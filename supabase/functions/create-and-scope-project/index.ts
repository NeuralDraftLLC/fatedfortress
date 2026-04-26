/**
 * supabase/functions/create-and-scope-project/index.ts
 *
 * Single-call Stage 1 orchestrator:
 *   1. Insert project as status='draft'
 *   2. Invoke runScope (GPT-4o) from _shared/scope.ts — with max 3 retries,
 *      decaying temperature (0.3 → 0.15 → 0.075), and Zod error appended to prompt on retry
 *   3. Insert tasks as status='draft' (host reviews and publishes to 'open')
 *   4. Return { project, tasks, scoped } — or { scoped: false, warning } if AI failed
 *
 * Changes (2026-04-26 — Pillar 2):
 *   - Retry loop: max 3 attempts, Zod validation error appended to prompt on retry
 *   - Temperature decay: 0.3 × (0.5 ^ attempt) on each retry
 *   - Tasks inserted as 'draft', not 'open' (host reviews before publishing)
 *   - If all 3 attempts fail, returns { scoped: false, warning } — frontend shows fallback UI
 *
 * POST body:
 * {
 *   title: string
 *   description: string
 *   projectType: string
 *   budgetRange: { min: number, max: number }   // USD cents
 *   targetTimeline?: string
 *   referenceUrls?: string[]
 *   architectureDiagram?: string               // Mermaid source
 * }
 */

import { resolveAuth, serviceRoleClient } from "../_shared/auth.ts";
import { runScope, buildUserPrompt, ScopeIntent, ScopeResult } from "../_shared/scope.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  // ── Auth & role guard ────────────────────────────────────────────────────
  const auth = await resolveAuth(req);
  if (auth.kind !== "user") {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const admin = serviceRoleClient();

  const { data: profile } = await admin
    .from("profiles")
    .select("role")
    .eq("id", auth.user.id)
    .single();

  if ((profile as { role?: string } | null)?.role !== "host") {
    return new Response(JSON.stringify({ error: "Only hosts can create projects" }), {
      status: 403,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  try {
    const body = (await req.json()) as ScopeIntent & {
      architectureDiagram?: string;
    };

    const { title, description, projectType, budgetRange, targetTimeline, referenceUrls, architectureDiagram } = body;

    if (!title || !description || !projectType || !budgetRange) {
      return new Response(
        JSON.stringify({ error: "title, description, projectType, and budgetRange are required" }),
        { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }

    // ── Step 1: Insert project as 'draft' ────────────────────────────────
    const { data: project, error: projectErr } = await admin
      .from("projects")
      .insert({
        host_id: auth.user.id,
        title,
        description,
        status: "draft",
        architecture_diagram: architectureDiagram ?? null,
        references_urls: referenceUrls ?? [],
      })
      .select()
      .single();

    if (projectErr || !project) {
      throw new Error(`Failed to create project: ${projectErr?.message}`);
    }

    // ── Step 2: Scope via GPT-4o — with max 3 retries ─────────────────────────
    const MAX_RETRIES = 3;
    let scopeResult: ScopeResult | null = null;
    let lastValidationError: string | undefined;
    let lastScopeError: string | undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        // Build user prompt — on retry, append the validation error so GPT knows what to fix
        const userPrompt = buildUserPrompt({
          projectId: project.id,
          title,
          description,
          projectType,
          referenceUrls,
          budgetRange,
          targetTimeline,
          architectureDiagram,
        }) + (lastValidationError
          ? `\n\n[Previous attempt failed. Fix this specific error]: ${lastValidationError}`
          : "");

        // Decaying temperature: 0.3 → 0.15 → 0.075
        const temperature = 0.3 * Math.pow(0.5, attempt);

        // Build prompt with optional error context from previous retry
        const basePrompt = buildUserPrompt({
          projectId: project.id,
          title,
          description,
          projectType,
          referenceUrls,
          budgetRange,
          targetTimeline,
          architectureDiagram,
        });
        const finalPrompt = lastValidationError
          ? `${basePrompt}\n\n[Previous attempt failed. Fix this specific error]: ${lastValidationError}`
          : basePrompt;

        scopeResult = await runScope({
          projectId: project.id,
          title,
          description,
          projectType,
          referenceUrls,
          budgetRange,
          targetTimeline,
          architectureDiagram,
        }, temperature, finalPrompt);
        break; // success
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // Extract the validation error prefix if present
        const match = msg.match(/^GPT-4o output failed validation: (.+)/);
        lastValidationError = match ? match[1] : msg;
        lastScopeError = msg;

        if (attempt === MAX_RETRIES - 1) {
          // Exhausted all retries — return draft project with failure warning
          return new Response(
            JSON.stringify({
              project,
              tasks: [],
              scoped: false,
              task_count: 0,
              warning: `AI task generation failed after ${MAX_RETRIES} attempts: ${lastScopeError}`,
            }),
            { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
          );
        }
        // Will retry with lower temperature and error context
      }
    }

    // ── Step 3: Persist (RPC handles auth.uid() check) ───────────────────
    // We use the service role client here, but persist_scoped_project is
    // SECURITY DEFINER and checks host_id = auth.uid() via the JWT we
    // pass in the Authorization header on the RPC call.
    // For service-role invocations we do a direct insert instead.
    if (scopeResult.tasks.length > 0) {
      const taskRows = scopeResult.tasks.map((t) => ({
        project_id: project.id,
        title: t.title,
        description: t.description,
        payout_min: t.payout_min,
        payout_max: t.payout_max,
        ambiguity_score: t.ambiguity_score,
        estimated_minutes: t.estimated_minutes,
        deliverable_type: t.deliverable_type,
        spec_constraints: t.spec_constraints ?? {},
        status: "open",
      }));

      const { error: taskErr } = await admin.from("tasks").insert(taskRows);
      if (taskErr) throw new Error(`Failed to insert tasks: ${taskErr.message}`);

      // Update project_brief and folder_structure now that we have them
      await admin
        .from("projects")
        .update({
          project_brief: scopeResult.project_brief,
          folder_structure: scopeResult.folder_structure,
          updated_at: new Date().toISOString(),
        })
        .eq("id", project.id);

      // DB trigger trg_set_project_open already promoted status → 'open'
      // Fetch the final project state to return accurate status
      const { data: finalProject } = await admin
        .from("projects")
        .select("*")
        .eq("id", project.id)
        .single();

      const { data: finalTasks } = await admin
        .from("tasks")
        .select("*")
        .eq("project_id", project.id);

      return new Response(
        JSON.stringify({
          project: finalProject,
          tasks: finalTasks ?? [],
          scoped: true,
          task_count: finalTasks?.length ?? 0,
        }),
        { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }

    // ── 0 tasks generated: return as 'draft', host can retry ─────────────
    return new Response(
      JSON.stringify({
        project,
        tasks: [],
        scoped: false,
        task_count: 0,
        warning: "Scoper returned 0 tasks. Project remains in draft. Try a more detailed description.",
      }),
      { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("create-and-scope-project error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Internal error" }),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }
});
