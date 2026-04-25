/**
 * apps/web/src/net/data.ts — FatedFortress data layer.
 *
 * Single place for all Supabase queries.
 * Pages must NOT call supabase directly — all data access goes through here.
 *
 * Principles:
 * - Every function is async and typed against @fatedfortress/protocol domain types
 * - Errors are normalized to typed error codes (never raw Supabase errors escape)
 * - Pagination params are optional, defaults are sensible
 *
 * Sacred objects: Task, Submission, Decision
 * System of record: Supabase
 */

import { getSupabase } from "../auth/index.js";
import type {
  Task,
  Project,
  Submission,
  Decision,
  Profile,
  Invitation,
  ReviewSession,
  AuditEntry,
  ProjectWallet,
  TaskStatus,
  DeliverableType,
  ScopedTask,
} from "@fatedfortress/protocol";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class DataError extends Error {
  constructor(
    public readonly code:
      | "NOT_FOUND"
      | "UNAUTHORIZED"
      | "FORBIDDEN"
      | "CONFLICT"
      | "VALIDATION"
      | "NETWORK"
      | "UNKNOWN",
    message: string
  ) {
    super(message);
    this.name = "DataError";
  }
}

function normalizeError(err: unknown, context: string): DataError {
  if (err instanceof DataError) return err;
  if (typeof err === "object" && err !== null && "code" in err) {
    const e = err as Record<string, unknown>;
    if (e.code === "PGRST116") return new DataError("NOT_FOUND", `${context}: not found`);
    if (e.code === "23505") return new DataError("CONFLICT", `${context}: already exists`);
    if (e.code === "23503") return new DataError("FORBIDDEN", `${context}: foreign key violation`);
  }
  if (err instanceof Error) {
    if (err.message.includes("No rows")) return new DataError("NOT_FOUND", `${context}: not found`);
    return new DataError("NETWORK", `${context}: ${err.message}`);
  }
  return new DataError("UNKNOWN", `${context}: unknown error`);
}

// ---------------------------------------------------------------------------
// Auth helpers (mirror auth/index.ts but expose here so pages don't import both)
// ---------------------------------------------------------------------------

export async function getCurrentUserId(): Promise<string | null> {
  const { data } = await getSupabase().auth.getUser();
  return data.user?.id ?? null;
}

// ---------------------------------------------------------------------------
// Safe profile columns — never request stripe_account_id, notification_trigger_url,
// or stripe_charges_enabled from the client. Those are service_role / edge-fn only.
// If you need to add a column here, confirm it contains no PII or financial data.
// ---------------------------------------------------------------------------
const PROFILE_SAFE_COLS =
  "id, username, avatar_url, display_name, review_reliability, skills, stripe_charges_enabled, created_at, updated_at";
// Note: stripe_charges_enabled is a boolean flag (not the account ID) — safe to
// expose so the UI can show "payouts enabled" without revealing the Stripe account.

// ---------------------------------------------------------------------------
// PROJECTS
// ---------------------------------------------------------------------------

export interface ProjectDetail extends Project {
  host: { id: string; display_name: string; review_reliability: number } | null;
}

export async function getProject(projectId: string): Promise<ProjectDetail> {
  const { data, error } = await getSupabase()
    .from("projects")
    .select("*, host:profiles!projects_host_id_fkey(id, display_name, review_reliability)")
    .eq("id", projectId)
    .single();

  if (error || !data) throw normalizeError(error, "getProject");
  return data as ProjectDetail;
}

export async function getMyProjects(): Promise<Project[]> {
  const userId = await getCurrentUserId();
  if (!userId) throw new DataError("UNAUTHORIZED", "getMyProjects: not authenticated");

  const { data, error } = await getSupabase()
    .from("projects")
    .select("*")
    .eq("host_id", userId)
    .order("created_at", { ascending: false });

  if (error) throw normalizeError(error, "getMyProjects");
  return (data ?? []) as Project[];
}

export async function getProjectWallet(projectId: string): Promise<ProjectWallet | null> {
  const { data, error } = await getSupabase()
    .from("project_wallet")
    .select("*")
    .eq("project_id", projectId)
    .maybeSingle();

  if (error) throw normalizeError(error, "getProjectWallet");
  return data as ProjectWallet | null;
}

// ---------------------------------------------------------------------------
// TASKS
// ---------------------------------------------------------------------------

export interface TaskDetail extends Task {
  project: { id: string; title: string; host_id: string; host: { display_name: string; review_reliability: number } } | null;
}

export async function getTask(taskId: string): Promise<TaskDetail> {
  const { data, error } = await getSupabase()
    .from("tasks")
    .select("*, project:projects(id, title, host_id, host:profiles!projects_host_id_fkey(display_name, review_reliability))")
    .eq("id", taskId)
    .single();

  if (error || !data) throw normalizeError(error, "getTask");
  return data as TaskDetail;
}

export async function getTasks(opts: {
  projectId?: string;
  statuses?: TaskStatus[];
  claimedBy?: string;
  includeProject?: boolean;
} = {}): Promise<TaskDetail[]> {
  let q = getSupabase().from("tasks").select(
    opts.includeProject
      ? "*, project:projects(id, title, host_id, host:profiles!projects_host_id_fkey(display_name, review_reliability))"
      : "*"
  );

  if (opts.projectId) q = q.eq("project_id", opts.projectId);
  if (opts.statuses?.length) q = q.in("status", opts.statuses);
  if (opts.claimedBy) q = q.eq("claimed_by", opts.claimedBy);

  q = q.order("created_at", { ascending: false });

  const { data, error } = await q;
  if (error) throw normalizeError(error, "getTasks");
  return (data ?? []) as TaskDetail[];
}

export async function getOpenTasks(): Promise<TaskDetail[]> {
  return getTasks({ statuses: ["open", "claimed", "submitted", "under_review", "revision_requested"], includeProject: true });
}

export async function getMyClaimedTasks(userId: string): Promise<TaskDetail[]> {
  return getTasks({ claimedBy: userId, statuses: ["claimed", "submitted", "under_review", "revision_requested"], includeProject: true });
}

export async function getProjectTasks(projectId: string): Promise<Task[]> {
  const { data, error } = await getSupabase()
    .from("tasks")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at");

  if (error) throw normalizeError(error, "getProjectTasks");
  return (data ?? []) as Task[];
}

export async function getMyAcceptedInvitedTaskIds(userId: string): Promise<Set<string>> {
  const { data } = await getSupabase()
    .from("invitations")
    .select("task_id")
    .eq("invited_user_id", userId)
    .not("accepted_at", "is", null);

  return new Set((data ?? []).map((i: Record<string, unknown>) => i.task_id as string));
}

export async function updateTaskStatus(taskId: string, status: TaskStatus): Promise<void> {
  const { error } = await getSupabase()
    .from("tasks")
    .update({ status, updated_at: new Date().toISOString() } as Record<string, unknown>)
    .eq("id", taskId);

  if (error) throw normalizeError(error, "updateTaskStatus");
}

// ---------------------------------------------------------------------------
// SUBMISSIONS
// ---------------------------------------------------------------------------

export async function getSubmission(submissionId: string): Promise<Submission> {
  const { data, error } = await getSupabase()
    .from("submissions")
    .select("*")
    .eq("id", submissionId)
    .single();

  if (error || !data) throw normalizeError(error, "getSubmission");
  return data as Submission;
}

export async function getTaskSubmissions(taskId: string): Promise<Submission[]> {
  const { data, error } = await getSupabase()
    .from("submissions")
    .select("*")
    .eq("task_id", taskId)
    .order("created_at", { ascending: true });

  if (error) throw normalizeError(error, "getTaskSubmissions");
  return (data ?? []) as Submission[];
}

export async function getMySubmissions(userId: string): Promise<Submission[]> {
  const { data, error } = await getSupabase()
    .from("submissions")
    .select("*, task:tasks(id, title, status)")
    .eq("contributor_id", userId)
    .order("created_at", { ascending: false });

  if (error) throw normalizeError(error, "getMySubmissions");
  return (data ?? []) as Submission[];
}

export async function getSubmissionCount(taskId: string, contributorId: string): Promise<number> {
  const { count, error } = await getSupabase()
    .from("submissions")
    .select("id", { count: "exact", head: true })
    .eq("task_id", taskId)
    .eq("contributor_id", contributorId);

  if (error) throw normalizeError(error, "getSubmissionCount");
  return count ?? 0;
}

// ---------------------------------------------------------------------------
// DECISIONS
// ---------------------------------------------------------------------------

export interface DecisionDetail extends Decision {
  submission: { id: string; task_id: string; contributor_id: string };
}

export async function getTaskDecisions(taskId: string): Promise<DecisionDetail[]> {
  const { data, error } = await getSupabase()
    .from("decisions")
    .select("*, submission:submissions(id, task_id, contributor_id)")
    .eq("submission.task_id", taskId)
    .order("created_at", { ascending: true });

  if (error) throw normalizeError(error, "getTaskDecisions");
  return (data ?? []) as DecisionDetail[];
}

// ---------------------------------------------------------------------------
// REVIEWS (tasks under review for a host)
// ---------------------------------------------------------------------------

export async function getHostReviewQueue(hostId: string): Promise<TaskDetail[]> {
  const { data, error } = await getSupabase()
    .from("tasks")
    .select("*, project:projects(id, title, host_id, host:profiles!projects_host_id_fkey(display_name, review_reliability))")
    .eq("project.host_id", hostId)
    .in("status", ["submitted", "under_review"])
    .order("submitted_at", { ascending: true });

  if (error) throw normalizeError(error, "getHostReviewQueue");
  return (data ?? []) as TaskDetail[];
}

// ---------------------------------------------------------------------------
// INVITATIONS
// ---------------------------------------------------------------------------

export async function getInvitationByToken(token: string) {
  const { data, error } = await getSupabase()
    .from("invitations")
    .select("*")
    .eq("token", token)
    .maybeSingle();

  if (error) throw normalizeError(error, "getInvitationByToken");
  return data;
}

export async function acceptInvitation(invitationId: string): Promise<void> {
  const { error } = await getSupabase()
    .from("invitations")
    .update({ accepted_at: new Date().toISOString() } as Record<string, unknown>)
    .eq("id", invitationId);

  if (error) throw normalizeError(error, "acceptInvitation");
}

// ---------------------------------------------------------------------------
// NOTIFICATIONS
// ---------------------------------------------------------------------------

export async function insertNotification(payload: {
  user_id: string;
  type: string;
  task_id?: string;
}): Promise<void> {
  const { error } = await getSupabase()
    .from("notifications")
    .insert(payload as Record<string, unknown>);

  if (error) throw normalizeError(error, "insertNotification");
}

// ---------------------------------------------------------------------------
// AUDIT LOG
// ---------------------------------------------------------------------------

export async function insertAuditEntry(payload: {
  actor_id: string;
  task_id?: string;
  project_id?: string;
  action: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  const { error } = await getSupabase()
    .from("audit_log")
    .insert(payload as Record<string, unknown>);

  if (error) throw normalizeError(error, "insertAuditEntry");
}

export async function getProjectAuditLog(projectId: string): Promise<AuditEntry[]> {
  const { data, error } = await getSupabase()
    .from("audit_log")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) throw normalizeError(error, "getProjectAuditLog");
  return (data ?? []) as AuditEntry[];
}

// ---------------------------------------------------------------------------
// PROJECT CREATION / PUBLISH
// ---------------------------------------------------------------------------

export async function persistScopedProject(opts: {
  projectId: string;
  hostId: string;
  title: string;
  description: string;
  readmeDraft: string;
  folderStructure: string[];
  tasks: Array<{
    title: string;
    description: string;
    deliverable_type?: string;
    payout_min?: number;
    payout_max?: number;
    ambiguity_score?: number;
    estimated_minutes?: number;
    spec_constraints?: Record<string, unknown>;
  }>;
}): Promise<string> {
  const { data, error } = await getSupabase().rpc("persist_scoped_project", {
    p_project_id: opts.projectId,
    p_host_id: opts.hostId,
    p_title: opts.title,
    p_description: opts.description,
    p_readme_draft: opts.readmeDraft,
    p_folder_structure: opts.folderStructure,
    p_tasks: opts.tasks,
  });
  if (error) throw normalizeError(error, "persistScopedProject");
  return data as string;
}

export async function updateTaskPayout(taskId: string, payoutMax: number): Promise<void> {
  const { error } = await getSupabase()
    .from("tasks")
    .update({ status: "open", payout_max: payoutMax, updated_at: new Date().toISOString() } as Record<string, unknown>)
    .eq("id", taskId);
  if (error) throw normalizeError(error, "updateTaskPayout");
}

export async function activateProject(projectId: string): Promise<void> {
  const { error } = await getSupabase()
    .from("projects")
    .update({ status: "active", updated_at: new Date().toISOString() } as Record<string, unknown>)
    .eq("id", projectId);
  if (error) throw normalizeError(error, "activateProject");
}

export async function createProjectWallet(projectId: string): Promise<void> {
  const { error } = await getSupabase()
    .from("project_wallet")
    .insert({ project_id: projectId, deposited: 0, locked: 0, released: 0 } as Record<string, unknown>);
  if (error) throw normalizeError(error, "createProjectWallet");
}

export async function getInsertedTasks(projectId: string): Promise<Array<{ id: string; payout_min: number; payout_max: number; title: string }>> {
  const { data, error } = await getSupabase()
    .from("tasks")
    .select("id, payout_min, payout_max, title")
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });

  if (error) throw normalizeError(error, "getInsertedTasks");
  return data as Array<{ id: string; payout_min: number; payout_max: number; title: string }>;
}

// ---------------------------------------------------------------------------
// WALLET / FINANCIAL
// ---------------------------------------------------------------------------

export async function getWalletDeposit(projectId: string, amount: number): Promise<void> {
  const { error } = await getSupabase().rpc("upsert_wallet_deposited", {
    p_project_id: projectId,
    p_amount: amount,
  });
  if (error) throw normalizeError(error, "getWalletDeposit");
}

// ---------------------------------------------------------------------------
// PROFILE
// Safe columns only — see PROFILE_SAFE_COLS above.
// Sensitive fields (stripe_account_id, notification_trigger_url) are
// service_role / edge-fn only and must never appear in client queries.
// ---------------------------------------------------------------------------

export async function getMyProfile(): Promise<Profile | null> {
  const userId = await getCurrentUserId();
  if (!userId) return null;
  return getProfile(userId);
}

export async function getProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await getSupabase()
    .from("profiles")
    .select(PROFILE_SAFE_COLS)
    .eq("id", userId)
    .single();

  if (error) {
    if ((error as Record<string, unknown>).code === "PGRST116") return null;
    throw normalizeError(error, "getProfile");
  }
  return data as Profile;
}

export async function updateProfile(userId: string, updates: Partial<Profile>): Promise<Profile> {
  const { data, error } = await getSupabase()
    .from("profiles")
    .update({ ...updates, updated_at: new Date().toISOString() } as Record<string, unknown>)
    .eq("id", userId)
    .select(PROFILE_SAFE_COLS)
    .single();

  if (error) throw normalizeError(error, "updateProfile");
  return data as Profile;
}

// ---------------------------------------------------------------------------
// REVIEW SESSIONS (Y.js collab scoped)
// ---------------------------------------------------------------------------

export async function getActiveReviewSession(taskId: string): Promise<ReviewSession | null> {
  const { data, error } = await getSupabase()
    .from("review_sessions")
    .select("*")
    .eq("task_id", taskId)
    .eq("status", "active")
    .maybeSingle();

  if (error) throw normalizeError(error, "getActiveReviewSession");
  return data as ReviewSession | null;
}
