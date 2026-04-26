/**
 * apps/web/src/handlers/scope.ts — SCOPE_PROJECT intent handler.
 *
 * Sacred objects: Task, Submission, Decision
 *
 * Takes a project brief and calls the SCOPE edge function to generate:
 *   ScopedTask[] (title, description, deliverableType, payoutMin/Max,
 *                 ambiguityScore, estimatedMinutes, suggestedRole)
 *   readmeDraft, folderStructure, totalPayoutMin, totalPayoutMax
 *
 * Tasks are written to Supabase with status = 'draft'.
 * Host reviews and publishes.
 *
 * Changes (2026-04-26 — Pillar 2):
 *   - Now calls `create-and-scope-project` instead of the deprecated `scope-tasks`.
 *     The deprecated function always returned 410 Gone.
 *   - `create-and-scope-project` inserts the project + tasks in a single call
 *     and returns { project, tasks, scoped }. Tasks have status='draft'.
 *   - If AI generation fails (scoped=false), returns partial data so the frontend
 *     can show the retry-exhausted fallback UI.
 */

import { getSupabase } from "../auth/index.js";
import type {
  Task,
  ScopeProjectResult,
  ScopedTask,
  DeliverableType,
} from "@fatedfortress/protocol";

const HARD_MAX_TASKS = 10;

interface ScopeProjectIntent {
  projectId: string;
  title: string;
  description: string;
  projectType: string;
  referenceUrls: string[];
  budgetRange: { min: number; max: number };
  targetTimeline?: string;
}

/**
 * Generate scoped tasks + readme draft + folder structure from a project brief.
 * Calls the `create-and-scope-project` edge function which inserts a draft project
 * and tasks in one call. On AI failure, returns { scoped: false, warning } so
 * the caller can show the fallback UI.
 */
export async function generateScopedTasks(
  intent: ScopeProjectIntent
): Promise<ScopeProjectResult> {
  const supabase = getSupabase();

  // create-and-scope-project inserts a draft project and runs GPT-4o scoping.
  // It returns { project, tasks, scoped, task_count, warning? }.
  // Tasks are inserted as status='draft' — host reviews before publishing.
  const { data, error } = await supabase.functions.invoke("create-and-scope-project", {
    body: {
      title: intent.title,
      description: intent.description,
      projectType: intent.projectType,
      referenceUrls: intent.referenceUrls,
      budgetRange: intent.budgetRange,
      targetTimeline: intent.targetTimeline,
    },
  });

  if (error) {
    throw new Error(error.message ?? "SCOPE failed");
  }

  const result = data as {
    project?: { id: string };
    tasks?: Array<Record<string, unknown>>;
    scoped: boolean;
    task_count: number;
    warning?: string;
  };

  if (!result.scoped || !result.tasks || result.task_count === 0) {
    // AI failed after all retries — return partial result with warning
    // so create.ts can show the retry-exhausted fallback UI
    return {
      tasks: [],
      readmeDraft: "",
      folderStructure: [],
      totalPayoutMin: intent.budgetRange.min,
      totalPayoutMax: intent.budgetRange.max,
      scoped: false,
      warning: result.warning ?? "AI task generation failed. Try a more detailed description.",
    };
  }

  // Normalize tasks from the edge function format to the frontend ScopedTask format
  const normalized = normalizeScopedTasks(result.tasks, intent.budgetRange.min, intent.budgetRange.max);

  return {
    tasks: normalized,
    readmeDraft: "",
    folderStructure: [],
    totalPayoutMin: intent.budgetRange.min,
    totalPayoutMax: intent.budgetRange.max,
    scoped: true,
  };
}

// ---------------------------------------------------------------------------
// Task normalization
// ---------------------------------------------------------------------------

function normalizeScopedTasks(
  raw: unknown[],
  budgetMin: number,
  budgetMax: number
): ScopedTask[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, HARD_MAX_TASKS)
    .map((t: any): ScopedTask => ({
      title: String(t.title ?? "Untitled").slice(0, 200),
      description: String(t.description ?? "").slice(0, 2000),
      deliverableType: normalizeDeliverableType(t.deliverableType),
      payoutMin: clamp(parseFloat(t.payoutMin ?? t.payout_min ?? budgetMin), 0, budgetMax),
      payoutMax: clamp(parseFloat(t.payoutMax ?? t.payout_max ?? t.payoutMin ?? budgetMax), 0, budgetMax),
      ambiguityScore: clamp(parseFloat(t.ambiguityScore ?? t.ambiguity_score ?? 0.5), 0, 1),
      estimatedMinutes: clamp(parseInt(t.estimatedMinutes ?? t.estimated_minutes ?? 30, 10), 5, 480),
      suggestedRole: String(t.suggestedRole ?? "contributor").slice(0, 80),
    }))
    .filter((t) => t.title && t.description);
}

function normalizeDeliverableType(raw: unknown): DeliverableType {
  const valid: DeliverableType[] = [
    "file", "pr", "code_patch", "design_asset", "text",
    "audio", "video", "3d_model", "figma_link",
  ];
  if (typeof raw === "string" && valid.includes(raw as DeliverableType)) {
    return raw as DeliverableType;
  }
  return "file";
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
