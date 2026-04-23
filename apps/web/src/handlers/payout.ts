/**
 * apps/web/src/handlers/payout.ts — Stripe Connect payout handler.
 *
 * Payment flow: no funds held on claim or submit.
 * PaymentIntent captured ONLY in releasePayout().
 *
 * Sacred: Task, Submission, Decision
 */

import { getSupabase } from "../auth/index.js";
import type {
  DecisionReason,
  StructuredFeedback,
} from "@fatedfortress/protocol";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PLATFORM_FEE_BPS = 1000; // 1000 bps = 10%

function platformFee(amount: number): number {
  return Math.round(amount * (PLATFORM_FEE_BPS / 10000));
}

// ---------------------------------------------------------------------------
// Connect onboarding
// ---------------------------------------------------------------------------

/** Onboard host to Stripe Connect (one-time per host). */
export async function createConnectAccountLink(userId: string): Promise<string> {
  const stripeAccountId = await getOrCreateConnectAccount(userId);
  const origin = window.location.origin;

  const { data, error } = await getSupabase()
    .functions
    .invoke("stripe-connect-link", {
      body: { stripeAccountId, returnUrl: `${origin}/settings`, refreshUrl: `${origin}/settings` },
    });

  if (error || !data?.url) {
    throw new Error("Failed to create Stripe Connect account link");
  }
  return data.url;
}

async function getOrCreateConnectAccount(userId: string): Promise<string> {
  const { data: profile } = await getSupabase()
    .from("profiles")
    .select("stripe_account_id")
    .eq("id", userId)
    .single();

  if (profile?.stripe_account_id) {
    return profile.stripe_account_id;
  }

  const { data, error } = await getSupabase()
    .functions
    .invoke("stripe-connect-onboard", { body: { userId } });

  if (error || !data?.stripeAccountId) {
    throw new Error("Failed to create Stripe Connect account");
  }

  await getSupabase()
    .from("profiles")
    .update({ stripe_account_id: data.stripeAccountId } as Record<string, unknown>)
    .eq("id", userId);

  return data.stripeAccountId;
}

// ---------------------------------------------------------------------------
// Project wallet — fund / withdraw
// ---------------------------------------------------------------------------

/** Pre-fund project wallet — writes to project_wallet.deposited. */
export async function fundProjectWallet(
  projectId: string,
  amount: number
): Promise<void> {
  const supabase = getSupabase();

  // Upsert: create wallet row if it doesn't exist, add to deposited
  const { data: existing } = await supabase
    .from("project_wallet")
    .select("id, deposited")
    .eq("project_id", projectId)
    .maybeSingle();

  if (existing) {
    const { error } = await supabase
      .from("project_wallet")
      .update({ deposited: existing.deposited + amount })
      .eq("id", existing.id);
    if (error) throw error;
  } else {
    const { error } = await supabase
      .from("project_wallet")
      .insert({ project_id: projectId, deposited: amount });
    if (error) throw error;
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function fetchSubmissionAndTask(supabase: ReturnType<typeof getSupabase>, submissionId: string) {
  const { data: submission } = await supabase
    .from("submissions")
    .select("*, task:tasks(*, project:projects(*))")
    .eq("id", submissionId)
    .single();

  if (!submission) throw new Error("Submission not found");
  return submission as Record<string, unknown>;
}

async function writeAudit(
  supabase: ReturnType<typeof getSupabase>,
  actorId: string,
  taskId: string,
  action: string,
  payload: Record<string, unknown>
): Promise<void> {
  await supabase.from("audit_log").insert({
    actor_id: actorId,
    task_id: taskId,
    action,
    payload,
  } as Record<string, unknown>);
}

async function sendNotification(
  supabase: ReturnType<typeof getSupabase>,
  userId: string,
  type: string,
  taskId: string
): Promise<void> {
  await supabase.from("notifications").insert({
    user_id: userId,
    type,
    task_id: taskId,
  } as Record<string, unknown>);
}

/**
 * Update review_reliability stats on a host profile after a decision.
 * Called by releasePayout, rejectSubmission, and requestRevision.
 */
async function updateHostReliability(
  hostId: string,
  decision: "approved" | "rejected" | "revision"
): Promise<void> {
  const { data: profile } = await getSupabase()
    .from("profiles")
    .select("total_submitted, total_approved, total_rejected, avg_revision_count, review_reliability, approval_rate")
    .eq("id", hostId)
    .single();

  if (!profile) return;

  const total = profile.total_submitted ?? 0;
  const approved = profile.total_approved ?? 0;
  const rejected = profile.total_rejected ?? 0;

  const newTotal = total + 1;
  const newApproved = decision === "approved" ? approved + 1 : approved;
  const newRejected = decision === "rejected" ? rejected + 1 : rejected;

  const newApprovalRate = newTotal > 0 ? newApproved / newTotal : 0;

  const alpha = 0.2;
  const revisions = profile.avg_revision_count ?? 0;
  const newAvgRevisions =
    decision === "revision"
      ? revisions * (1 - alpha) + (revisions + 1) * alpha
      : revisions * (1 - alpha);

  const rejectionRate = newTotal > 0 ? newRejected / newTotal : 0;
  const newReliability = newApprovalRate * (1 - rejectionRate * 0.5);

  await getSupabase()
    .from("profiles")
    .update({
      review_reliability: Math.round(newReliability * 1000) / 1000,
      approval_rate: Math.round(newApprovalRate * 1000) / 1000,
      avg_revision_count: Math.round(newAvgRevisions * 100) / 100,
      total_approved: newApproved,
      total_submitted: newTotal,
      total_rejected: newRejected,
    } as Record<string, unknown>)
    .eq("id", hostId);
}

// ---------------------------------------------------------------------------
// Core payout operations
// ---------------------------------------------------------------------------

/**
 * Host approves a submission.
 *
 * Steps:
 * 1. Insert into decisions (decision_reason, approved_payout, structured_feedback)
 * 2. Capture PaymentIntent + 10% application_fee_amount  ← ONLY place Stripe capture happens
 * 3. tasks.status = 'paid', tasks.approved_payout = cache from decisions
 * 4. project_wallet.locked -= approved_payout, .released += approved_payout
 * 5. audit_log: action = 'payment_released'
 * 6. review_sessions.status = 'resolved'
 * 7. Update profiles review_reliability stats
 * 8. Notify contributor: type = 'payment_released'
 */
export async function releasePayout(
  submissionId: string,
  approvedPayout: number,
  decisionReason: DecisionReason,
  reviewNotes?: string,
  structuredFeedback?: StructuredFeedback[]
): Promise<void> {
  const supabase = getSupabase();

  const submission = await fetchSubmissionAndTask(supabase, submissionId);
  const task = submission.task as Record<string, unknown>;
  const project = task.project as Record<string, unknown>;
  const hostId = project.host_id as string;
  const taskId = task.id as string;
  const contributorId = submission.contributor_id as string;

  // 1. Insert into decisions (authoritative record)
  const { data: decision, error: decisionError } = await supabase
    .from("decisions")
    .insert({
      submission_id: submissionId,
      host_id: hostId,
      decision_reason: decisionReason,
      review_notes: reviewNotes ?? null,
      structured_feedback: structuredFeedback ?? null,
      approved_payout: approvedPayout,
    })
    .select()
    .single();

  if (decisionError || !decision) throw new Error("Failed to record decision");

  // 2. Capture Stripe PaymentIntent — ONLY place payment is captured
  const { data: hostProfile } = await getSupabase()
    .from("profiles")
    .select("stripe_account_id")
    .eq("id", hostId)
    .single();

  const platformAmount = platformFee(approvedPayout);

  const paymentIntentId = (submission as Record<string, unknown>).payment_intent_id as
    | string
    | undefined;

  const { data: paymentData, error: paymentError } = await supabase
    .functions
    .invoke("stripe-payment", {
      body: {
        action: "capture",
        amount: approvedPayout,
        platformFee: platformAmount,
        paymentIntentId,
        contributorStripeAccountId: (submission as Record<string, unknown>).contributor_stripe_account_id as string | undefined,
        connectedAccountId: hostProfile?.stripe_account_id,
        submissionId,
        taskId,
      },
    });

  if (paymentError || !paymentData?.success) {
    throw new Error(paymentData?.error ?? "Payment capture failed");
  }

  // 3. Update task: status = paid, cache approved_payout from decisions
  await supabase
    .from("tasks")
    .update({
      status: "paid",
      approved_payout: approvedPayout,
      reviewed_at: new Date().toISOString(),
    } as Record<string, unknown>)
    .eq("id", taskId);

  // 4. Update project_wallet: locked -= approvedPayout, released += approvedPayout
  const { data: wallet } = await supabase
    .from("project_wallet")
    .select("id, locked, released")
    .eq("project_id", project.id)
    .maybeSingle();

  if (wallet) {
    await supabase
      .from("project_wallet")
      .update({
        locked: Math.max(0, (wallet.locked ?? 0) - approvedPayout),
        released: (wallet.released ?? 0) + approvedPayout,
      } as Record<string, unknown>)
      .eq("id", wallet.id);
  }

  // 5. Audit log
  await writeAudit(supabase, hostId, taskId, "payment_released", {
    submissionId,
    decisionId: (decision as Record<string, unknown>).id,
    approvedPayout,
    platformFee: platformAmount,
    decisionReason,
  });

  // 6. Resolve review_sessions for this task
  await supabase
    .from("review_sessions")
    .update({ status: "resolved" } as Record<string, unknown>)
    .eq("task_id", taskId)
    .eq("status", "active");

  // 7. Update host review_reliability
  await updateHostReliability(hostId, "approved");

  // 8. Notify contributor
  await sendNotification(supabase, contributorId, "payment_released", taskId);
}

/**
 * Host rejects a submission.
 *
 * Steps:
 * 1. Insert into decisions
 * 2. tasks.status = 'rejected' → returns to 'open'
 * 3. audit_log: action = 'rejected'
 * 4. Update review_reliability stats
 * 5. Notify contributor: type = 'submission_rejected'
 */
export async function rejectSubmission(
  submissionId: string,
  decisionReason: DecisionReason,
  notes: string,
  structuredFeedback?: StructuredFeedback[]
): Promise<void> {
  const supabase = getSupabase();

  const submission = await fetchSubmissionAndTask(supabase, submissionId);
  const task = submission.task as Record<string, unknown>;
  const project = task.project as Record<string, unknown>;
  const hostId = project.host_id as string;
  const taskId = task.id as string;
  const contributorId = submission.contributor_id as string;

  // 1. Insert into decisions
  await supabase.from("decisions").insert({
    submission_id: submissionId,
    host_id: hostId,
    decision_reason: decisionReason,
    review_notes: notes,
    structured_feedback: structuredFeedback ?? null,
  } as Record<string, unknown>);

  // 2. Task returns to open
  await supabase
    .from("tasks")
    .update({
      status: "open",
      claimed_by: null,
      claimed_at: null,
      soft_lock_expires_at: null,
      reviewed_at: new Date().toISOString(),
    } as Record<string, unknown>)
    .eq("id", taskId);

  // 3. Audit log
  await writeAudit(supabase, hostId, taskId, "rejected", {
    submissionId,
    decisionReason,
    notes,
  });

  // 4. Update host reliability
  await updateHostReliability(hostId, "rejected");

  // 5. Notify contributor
  await sendNotification(supabase, contributorId, "submission_rejected", taskId);
}

/**
 * Host requests a revision.
 *
 * Steps:
 * 1. Insert into decisions (with revision_deadline if provided)
 * 2. tasks.status = 'revision_requested'
 * 3. audit_log: action = 'revision_requested'
 * 4. Update review_reliability stats
 * 5. Notify contributor: type = 'revision_requested'
 */
export async function requestRevision(
  submissionId: string,
  decisionReason: DecisionReason,
  notes: string,
  structuredFeedback?: StructuredFeedback[],
  revisionDeadline?: Date
): Promise<void> {
  const supabase = getSupabase();

  const submission = await fetchSubmissionAndTask(supabase, submissionId);
  const task = submission.task as Record<string, unknown>;
  const project = task.project as Record<string, unknown>;
  const hostId = project.host_id as string;
  const taskId = task.id as string;
  const contributorId = submission.contributor_id as string;

  // 1. Insert into decisions
  await supabase.from("decisions").insert({
    submission_id: submissionId,
    host_id: hostId,
    decision_reason: decisionReason,
    review_notes: notes,
    structured_feedback: structuredFeedback ?? null,
    revision_deadline: revisionDeadline?.toISOString() ?? null,
  } as Record<string, unknown>);

  // 2. Task goes to revision_requested (contributor re-claims and resubmits)
  await supabase
    .from("tasks")
    .update({
      status: "revision_requested",
      reviewed_at: new Date().toISOString(),
    } as Record<string, unknown>)
    .eq("id", taskId);

  // 3. Audit log
  await writeAudit(supabase, hostId, taskId, "revision_requested", {
    submissionId,
    decisionReason,
    notes,
    revisionDeadline: revisionDeadline?.toISOString() ?? null,
  });

  // 4. Update host reliability
  await updateHostReliability(hostId, "revision");

  // 5. Notify contributor
  await sendNotification(supabase, contributorId, "revision_requested", taskId);
}
