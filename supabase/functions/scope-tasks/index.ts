/**
 * supabase/functions/scope-tasks/index.ts
 *
 * AI-powered task scoping: takes a project brief and generates structured tasks
 * using GPT-4o with JSON object output mode.
 *
 * Two modes:
 *   preview (no projectId):  Returns tasks for the host to review/edit before saving
 *   persist (projectId set):  Atomically writes project + tasks via persist_scoped_project RPC
 *
 * Platform fee: 10% (1000 bps) baked into payout_min/payout_max
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);
const MODEL = "gpt-4o";

function userIdFromToken(authHeader: string): string | null {
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1];
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    return payload.sub ?? null;
  } catch {
    return null;
  }
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SYSTEM_PROMPT = `You are an expert project manager for an AI generation marketplace called FatedFortress.
Given a project brief, your job is to decompose it into clear, atomic tasks.

Rules:
- Each task must be independently completable by a contributor in 1-4 hours
- Task titles are specific and action-oriented (verb + deliverable)
- Descriptions explain WHAT to produce and any relevant HOW (tools, format, standards)
- payout_min: minimum fair payout for a competent contributor
- payout_max: upper bound for complex/reworked versions of the task
- payout is in USD CENTS (e.g., 500 = $5.00)
- ambiguity_score: 0.0 = perfectly clear, 1.0 = highly ambiguous
- estimated_minutes: realistic time estimate for a competent contributor
- ALWAYS output a valid JSON object with no markdown fences, no prose, no commentary
- Return 3-8 tasks maximum
- spread payout_range across tasks proportionally to complexity`;

function buildUserPrompt(intent: ScopeIntent): string {
  const {
    title,
    description,
    projectType,
    referenceUrls,
    budgetRange,
    targetTimeline,
  } = intent;

  let prompt = `Project: ${title}\nDescription: ${description}\nType: ${projectType}\n`;
  prompt += `Host budget range: $${(budgetRange.min / 100).toFixed(2)} – $${(budgetRange.max / 100).toFixed(2)}\n`;
  if (targetTimeline) prompt += `Timeline: ${targetTimeline}\n`;
  if (referenceUrls && referenceUrls.length > 0) {
    prompt += `Reference URLs:\n${referenceUrls.map((u) => `  - ${u}`).join("\n")}\n`;
  }
  prompt += `\nGenerate the scoped tasks as a JSON object with this exact structure:
{
  "tasks": [
    {
      "title": "string (max 80 chars)",
      "description": "string (max 500 chars)",
      "deliverableType": "file|pr|code_patch|design_asset|text|audio|video|3d_model|figma_link",
      "payoutMin": number (cents, min $1)",
      "payoutMax": number (cents, max 10x payoutMin)",
      "ambiguityScore": number (0.0-1.0),
      "estimatedMinutes": number (15-240)
    }
  ],
  "readmeDraft": "string (2-4 sentence overview of the project scope and what these tasks accomplish together)",
  "folderStructure": ["string (path like src/components/Button.tsx)"],
  "totalPayoutMin": number (cents, sum of task payoutMin)",
  "totalPayoutMax": number (cents, sum of task payoutMax)"
}`;

  return prompt;
}

interface ScopeIntent {
  projectId?: string;
  title: string;
  description: string;
  projectType: string;
  referenceUrls?: string[];
  budgetRange: { min: number; max: number };
  targetTimeline?: string;
}

interface ScopedTask {
  title: string;
  description: string;
  deliverableType: string;
  payoutMin: number;
  payoutMax: number;
  ambiguityScore: number;
  estimatedMinutes: number;
}

interface ScopeResult {
  tasks: ScopedTask[];
  readmeDraft: string;
  folderStructure: string[];
  totalPayoutMin: number;
  totalPayoutMax: number;
}

async function callOpenAI(prompt: string): Promise<ScopeResult> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content;

  if (!raw) {
    throw new Error("OpenAI returned empty response");
  }

  try {
    return JSON.parse(raw) as ScopeResult;
  } catch {
    throw new Error(`OpenAI returned invalid JSON: ${raw.slice(0, 200)}`);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const allowed = [
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
    Deno.env.get("SUPABASE_ANON_KEY"),
  ].filter(Boolean);
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m || !allowed.includes(m[1])) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  try {
    const intent = (await req.json()) as ScopeIntent;

    if (!intent.title || !intent.description || !intent.budgetRange) {
      return new Response(
        JSON.stringify({ error: "title, description, and budgetRange are required" }),
        { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }

    const userPrompt = buildUserPrompt(intent);
    const result = await callOpenAI(userPrompt);

    // Persist if projectId provided
    if (intent.projectId) {
      const hostId = userIdFromToken(authHeader);
      if (!hostId) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }

      const { error: persistErr } = await supabase.rpc("persist_scoped_project", {
        p_project_id: intent.projectId,
        p_host_id: hostId,
        p_title: intent.title,
        p_description: intent.description,
        p_references_urls: intent.referenceUrls ?? [],
        p_readme_draft: result.readmeDraft,
        p_folder_structure: result.folderStructure ?? [],
        p_tasks: result.tasks,
      });

      if (persistErr) {
        return new Response(JSON.stringify({ error: `persist_scoped_project failed: ${persistErr.message}` }), {
          status: 500,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
    }

    return new Response(JSON.stringify(result), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("scope-tasks error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Internal error" }),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }
});
