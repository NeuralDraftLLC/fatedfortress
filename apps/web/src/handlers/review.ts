/**
 * apps/web/src/handlers/review.ts — unified host review handler.
 *
 * This replaces the three payout.ts entrypoints:
 *   - releasePayout()
 *   - rejectSubmission()
 *   - requestRevision()
 *
 * All decisions now go through the review-submission edge function, which:
 *   - Validates host role and project ownership
 *   - Runs review_submission_atomic RPC for DB state (Task, Submission, Decision)
 *   - Handles Stripe capture/cancel and wallet movements server-side
 */

import { getSupabase } from "../auth/index.js";
import type { DecisionReason, StructuredFeedback } from "@fatedfortress/protocol";

export type Verdict = "approved" | "rejected" | "revision_requested";

export interface ReviewOptions {
  reviewNotes?: string;
  structuredFeedback?: StructuredFeedback[];
  payoutOverrideCents?: number;
  revisionDeadlineIso?: string;
}

export interface ReviewResult {
  success: boolean;
  message: string;
  taskStatus?: string;
  payoutCaptured?: number;
  stripeStatus?: string;
}

export async function reviewSubmission(
  submissionId: string,
  verdict: Verdict,
  decisionReason: DecisionReason,
  opts: ReviewOptions = {},
): Promise<ReviewResult> {
  const supabase = getSupabase();

  const { data, error } = await supabase.functions.invoke("review-submission", {
    body: {
      submissionId,
      verdict,
      decisionReason,
      reviewNotes: opts.reviewNotes,
      structuredFeedback: opts.structuredFeedback,
      payoutOverride: opts.payoutOverrideCents,
      revisionDeadline: opts.revisionDeadlineIso,
    },
  });

  if (error) {
    throw new Error(error.message ?? "Review failed");
  }

  const payload = data as {
    success?: boolean;
    message?: string;
    taskStatus?: string;
    payoutCaptured?: number;
    stripeStatus?: string;
    error?: string;
  } | null;

  if (!payload?.success) {
    throw new Error(payload?.message ?? "Review failed");
  }

  return {
    success: true,
    message: payload.message ?? "Review completed.",
    taskStatus: payload.taskStatus,
    payoutCaptured: payload.payoutCaptured,
    stripeStatus: payload.stripeStatus,
  };
}
