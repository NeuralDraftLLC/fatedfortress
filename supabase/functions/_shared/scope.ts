/**
 * supabase/functions/_shared/scope.ts
 *
 * Canonical scope logic extracted from the former scope-tasks function.
 * Imported by create-and-scope-project (the sole active scoping entry point).
 *
 * DO NOT import from ../scope-tasks/index.ts — that file is a tombstone.
 */

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;
const SENTRY_DSN = Deno.env.get("SENTRY_DSN");
const MODEL = "gpt-4o";

async function sendSentry({ message, extra }: { message: string; extra: Record<string, unknown> }): Promise<void> {
  if (!SENTRY_DSN) return;
  try {
    await fetch(`https://o447370.ingest.sentry.io/api/1/store/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        platform: "node",
        logger: "supabase-edge",
        environment: Deno.env.get("SUPABASE_ENVIRONMENT") ?? "unknown",
        release: Deno.env.get("SUPABASE_GIT_BRANCH") ?? "unknown",
        message,
        extra,
      }),
    });
  } catch { /* Sentry failure is non-fatal */ }
}

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

export function buildUserPrompt(intent: ScopeIntent): string {
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

// ─── Pillar 2: structural validation of GPT-4o output ───────────────────────
// No external dependencies — pure TypeScript for Deno edge function compatibility.

type ValidationError = {
  path: string;
  message: string;
};

function validateTask(task: unknown, index: number): ValidationError[] {
  const errors: ValidationError[] = [];
  if (typeof task !== "object" || task === null) {
    errors.push({ path: `tasks[${index}]`, message: "must be an object" });
    return errors;
  }
  const t = task as Record<string, unknown>;

  if (typeof t.title !== "string" || t.title.length > 80) {
    errors.push({ path: `tasks[${index}].title`, message: "string, max 80 chars" });
  }
  if (typeof t.description !== "string" || t.description.length > 500) {
    errors.push({ path: `tasks[${index}].description`, message: "string, max 500 chars" });
  }
  const validTypes = ["file","pr","code_patch","design_asset","text","audio","video","3d_model","figma_link"];
  if (!validTypes.includes(t.deliverable_type as string)) {
    errors.push({ path: `tasks[${index}].deliverable_type`, message: `one of: ${validTypes.join(", ")}` });
  }
  if (typeof t.payout_min !== "number" || !Number.isInteger(t.payout_min) || t.payout_min < 100) {
    errors.push({ path: `tasks[${index}].payout_min`, message: "integer >= 100 (cents)" });
  }
  if (typeof t.payout_max !== "number" || !Number.isInteger(t.payout_max) || t.payout_max < 100) {
    errors.push({ path: `tasks[${index}].payout_max`, message: "integer >= 100 (cents)" });
  }
  if (typeof t.payout_min === "number" && typeof t.payout_max === "number" && t.payout_max < t.payout_min) {
    errors.push({ path: `tasks[${index}].payout_max`, message: "must be >= payout_min" });
  }
  if (typeof t.ambiguity_score !== "number" || t.ambiguity_score < 0 || t.ambiguity_score > 1) {
    errors.push({ path: `tasks[${index}].ambiguity_score`, message: "number 0.0-1.0" });
  }
  if (typeof t.estimated_minutes !== "number" || !Number.isInteger(t.estimated_minutes) || t.estimated_minutes < 15 || t.estimated_minutes > 240) {
    errors.push({ path: `tasks[${index}].estimated_minutes`, message: "integer 15-240" });
  }
  return errors;
}

function validateScopeResult(json: unknown): ValidationError[] {
  const errors: ValidationError[] = [];
  if (typeof json !== "object" || json === null) {
    errors.push({ path: "$", message: "must be an object" });
    return errors;
  }
  const j = json as Record<string, unknown>;

  if (!Array.isArray(j.tasks) || j.tasks.length === 0) {
    errors.push({ path: "tasks", message: "non-empty array required" });
  } else if (j.tasks.length > 10) {
    errors.push({ path: "tasks", message: "max 10 tasks" });
  } else {
    j.tasks.forEach((task, i) => errors.push(...validateTask(task, i)));
  }
  if (typeof j.project_brief !== "string") {
    errors.push({ path: "project_brief", message: "string required" });
  }
  if (!Array.isArray(j.folder_structure)) {
    errors.push({ path: "folder_structure", message: "array required" });
  } else if (!j.folder_structure.every((f: unknown) => typeof f === "string")) {
    errors.push({ path: "folder_structure", message: "all items must be strings" });
  }
  if (typeof j.total_payout_min !== "number") {
    errors.push({ path: "total_payout_min", message: "number required" });
  }
  if (typeof j.total_payout_max !== "number") {
    errors.push({ path: "total_payout_max", message: "number required" });
  }
  return errors;
}

/**
 * Calls GPT-4o with the given intent and validates the response.
 * Throws with a structured error message if:
 *   - HTTP status is non-OK
 *   - Response body is missing
 *   - Response body fails structural validation
 *
 * The caller (create-and-scope-project) handles retries.
 *
 * @param intent - project scoping intent
 * @param temperatureOverride - optional, defaults to 0.3. Used by retry loop to decay temperature.
 * @param userPromptOverride - optional. If provided, overrides the prompt built by buildUserPrompt().
 *                            Used by the retry loop to append Zod validation errors to the prompt.
 */
export async function runScope(
  intent: ScopeIntent,
  temperatureOverride?: number,
  userPromptOverride?: string,
): Promise<ScopeResult> {
  const userPrompt = userPromptOverride ?? buildUserPrompt(intent);
  const temperature = temperatureOverride ?? 0.3;

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
      temperature,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    await sendSentry({ message: `OpenAI API error ${response.status}`, extra: { status: response.status, body: err.slice(0, 500) } });
    throw new Error(`OpenAI API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content;
  const usage = data.usage;

  if (!raw) throw new Error("OpenAI returned empty response");

  // ── Sentry: log token usage for cost tracking ───────────────────────────────
  await sendSentry({
    message: `GPT-4o scope: ${usage?.prompt_tokens ?? 0} in / ${usage?.completion_tokens ?? 0} out`,
    extra: {
      model: MODEL,
      temperature,
      prompt_tokens: usage?.prompt_tokens ?? 0,
      completion_tokens: usage?.completion_tokens ?? 0,
      total_tokens: usage?.total_tokens ?? 0,
      project_id: intent.projectId ?? "unknown",
    },
  });

  // ── Pillar 2: structural validation — never write invalid JSON to the DB ─────
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`GPT-4o returned invalid JSON: ${raw.slice(0, 200)}`);
  }

  const validationErrors = validateScopeResult(json);
  if (validationErrors.length > 0) {
    const summary = validationErrors
      .slice(0, 5)
      .map((e) => `${e.path}: ${e.message}`)
      .join("; ");
    throw new Error(`GPT-4o output failed validation: ${summary}`);
  }

  return json as ScopeResult;
}
