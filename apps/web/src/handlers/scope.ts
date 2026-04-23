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
 * Calls the `scope-tasks` edge function.
 */
export async function generateScopedTasks(
  intent: ScopeProjectIntent
): Promise<ScopeProjectResult> {
  const supabase = getSupabase();

  const { data, error } = await supabase.functions.invoke<ScopeProjectResult>("scope-tasks", {
    body: intent,
  });

  if (error || !data) {
    throw new Error(error?.message ?? "SCOPE failed");
  }

  if (error) {
    throw new Error(error.message ?? "SCOPE failed");
  }

  // Normalize and cap at HARD_MAX_TASKS
  return {
    tasks: normalizeScopedTasks(data.tasks ?? [], intent.budgetRange.min, intent.budgetRange.max),
    readmeDraft: data.readmeDraft ?? "",
    folderStructure: Array.isArray(data.folderStructure) ? data.folderStructure.slice(0, 20) : [],
    totalPayoutMin: data.totalPayoutMin ?? intent.budgetRange.min,
    totalPayoutMax: data.totalPayoutMax ?? intent.budgetRange.max,
  };
}

/**
 * Write generated tasks to Supabase with status = 'draft'.
 * Caller is responsible for creating the project_wallet row on publish.
 */
export async function writeScopedTasks(
  projectId: string,
  tasks: ScopedTask[],
  hostId: string
): Promise<Task[]> {
  const supabase = getSupabase();

  const rows = tasks.map((t) => ({
    project_id: projectId,
    title: t.title,
    description: t.description,
    deliverable_type: t.deliverableType,
    payout_min: t.payoutMin,
    payout_max: t.payoutMax,
    ambiguity_score: t.ambiguityScore,
    estimated_minutes: t.estimatedMinutes,
    status: "draft",
    task_access: "invite",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }));

  const { data, error } = await supabase
    .from("tasks")
    .insert(rows as unknown as Record<string, unknown>)
    .select();

  if (error || !data) {
    throw new Error(`Failed to write tasks: ${error?.message}`);
  }

  await supabase.from("audit_log").insert({
    actor_id: hostId,
    task_id: null,
    action: "task_created",
    payload: { projectId, count: tasks.length },
  } as Record<string, unknown>);

  return data as unknown as Task[];
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
