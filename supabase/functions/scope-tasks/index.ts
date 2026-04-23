/**
 * supabase/functions/scope-tasks/index.ts
 *
 * AI-powered task scoping: takes a project brief and generates structured tasks
 * using GPT-4o with JSON object output mode.
 *
 * The browser calls this with a `projectId` for correlation, then persists with the
 * user's session via `persist_scoped_project` in create.ts (RPC needs auth.uid()).
 *
 * Platform fee: 10% (1000 bps) baked into payout_min/payout_max
 */

import { resolveAuth, serviceRoleClient } from "../_shared/auth.ts";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;
const MODEL = "gpt-4o";

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
    return new Response(JSON.stringify({ error: "Only hosts can scope projects" }), {
      status: 403,
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

    if (intent.projectId) {
      const { data: proj } = await admin
        .from("projects")
        .select("host_id")
        .eq("id", intent.projectId)
        .maybeSingle();
      const hostId = (proj as { host_id?: string } | null)?.host_id;
      if (hostId != null && hostId !== auth.user.id) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
    }

    const userPrompt = buildUserPrompt(intent);
    const result = await callOpenAI(userPrompt);

    // Persistence is done by the browser with the user's session JWT via
    // `persist_scoped_project` in create.ts (RPC requires auth.uid(); service-role
    // invocations from this function would leave auth.uid() null and fail).

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
