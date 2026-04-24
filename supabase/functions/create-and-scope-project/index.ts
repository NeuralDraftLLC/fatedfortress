/**
 * supabase/functions/create-and-scope-project/index.ts
 *
 * Single-call Stage 1 orchestrator:
 *   1. Insert project as status='draft'
 *   2. Invoke scope-tasks (GPT-4o)
 *   3. Call persist_scoped_project RPC (inserts tasks)
 *   4. DB trigger promotes project to 'open' on first task insert
 *   5. Return { project, tasks } — or 'draft' if 0 tasks generated
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
import { runScope, ScopeIntent } from "../scope-tasks/index.ts";

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

    // ── Step 2: Scope via GPT-4o ─────────────────────────────────────────
    const scopeResult = await runScope({
      projectId: project.id,
      title,
      description,
      projectType,
      referenceUrls,
      budgetRange,
      targetTimeline,
      architectureDiagram,
    });

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
