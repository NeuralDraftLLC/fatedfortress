/**
 * supabase/functions/_shared/scope.ts
 *
 * Canonical scope logic extracted from the former scope-tasks function.
 * Imported by create-and-scope-project (the sole active scoping entry point).
 *
 * DO NOT import from ../scope-tasks/index.ts — that file is a tombstone.
 */

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;
const MODEL = "gpt-4o";

const SYSTEM_PROMPT = `You are an expert project manager for an AI generation marketplace called FatedFortress.
Given a project brief and optional architecture diagram, your job is to decompose the project
into clear, atomic tasks that human contributors can complete.

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
- Spread payout_range across tasks proportionally to complexity`;

function buildUserPrompt(intent: ScopeIntent): string {
  const {
    title,
    description,
    projectType,
    referenceUrls,
    budgetRange,
    targetTimeline,
    architectureDiagram,
  } = intent;

  let prompt = `Project: ${title}\nDescription: ${description}\nType: ${projectType}\n`;
  prompt += `Host budget range: $${(budgetRange.min / 100).toFixed(2)} – $${(budgetRange.max / 100).toFixed(2)}\n`;
  if (targetTimeline) prompt += `Timeline: ${targetTimeline}\n`;
  if (referenceUrls && referenceUrls.length > 0) {
    prompt += `Reference URLs:\n${referenceUrls.map((u) => `  - ${u}`).join("\n")}\n`;
  }
  if (architectureDiagram) {
    prompt += `\nArchitecture Diagram (Mermaid):\n${architectureDiagram}\n`;
    prompt += `Use the diagram nodes as context for task dependency_node metadata.\n`;
  }
  prompt += `\nGenerate the scoped tasks as a JSON object with this exact structure:
{
  "tasks": [
    {
      "title": "string (max 80 chars)",
      "description": "string (max 500 chars)",
      "deliverable_type": "file|pr|code_patch|design_asset|text|audio|video|3d_model|figma_link",
      "payout_min": number (cents, min $1),
      "payout_max": number (cents, max 10x payout_min),
      "ambiguity_score": number (0.0-1.0),
      "estimated_minutes": number (15-240),
      "spec_constraints": {}
    }
  ],
  "project_brief": "string (2-4 sentence overview of what these tasks accomplish together)",
  "folder_structure": ["string (path like src/components/Button.tsx)"],
  "total_payout_min": number (cents, sum of task payout_min),
  "total_payout_max": number (cents, sum of task payout_max)
}`;

  return prompt;
}

export interface ScopeIntent {
  projectId?: string;
  title: string;
  description: string;
  projectType: string;
  referenceUrls?: string[];
  budgetRange: { min: number; max: number };
  targetTimeline?: string;
  architectureDiagram?: string;
}

export interface ScopedTask {
  title: string;
  description: string;
  deliverable_type: string;
  payout_min: number;
  payout_max: number;
  ambiguity_score: number;
  estimated_minutes: number;
  spec_constraints: Record<string, unknown>;
}

export interface ScopeResult {
  tasks: ScopedTask[];
  project_brief: string;
  folder_structure: string[];
  total_payout_min: number;
  total_payout_max: number;
}

export async function runScope(intent: ScopeIntent): Promise<ScopeResult> {
  const userPrompt = buildUserPrompt(intent);
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
        { role: "user", content: userPrompt },
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

  if (!raw) throw new Error("OpenAI returned empty response");

  try {
    return JSON.parse(raw) as ScopeResult;
  } catch {
    throw new Error(`OpenAI returned invalid JSON: ${raw.slice(0, 200)}`);
  }
}
