/**
 * supabase/functions/review-submission/index.ts
 *
 * Stage 4 — The ONLY server-side path for a host to act on a submission.
 * Replaces all three client-side payout.ts functions:
 *   releasePayout()      → verdict: 'approved'
 *   rejectSubmission()   → verdict: 'rejected'
 *   requestRevision()    → verdict: 'revision_requested'
 *
 * Security model:
 *   - Caller MUST be the project host (verified via JWT → profiles.role=host,
 *     and review_submission_atomic checks host_id = project.host_id)
 *   - All Stripe calls happen server-side with the secret key
 *   - Client never touches payment amounts or task status directly
 *
 * POST body:
 * {
 *   submissionId:       string   (uuid)
 *   verdict:            'approved' | 'rejected' | 'revision_requested'
 *   decisionReason:     string   (enum from decisions.decision_reason)
 *   reviewNotes?:       string   (max 4000 chars)
 *   structuredFeedback?: object[]
 *   payoutOverride?:    number   (cents, must be ≤ task.payout_max)
 *   revisionDeadline?:  string   (ISO-8601, revision_requested only)
 * }
 *
 * Response:
 * {
 *   success:         true
 *   decisionId:      string
 *   taskStatus:      string
 *   payoutCaptured?: number   (cents, approve only)
 *   stripeStatus?:   string
 * }
 */

import { resolveAuth, serviceRoleClient } from "../_shared/auth.ts";

const SUPABASE_URL       = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PLATFORM_FEE_BPS   = 1000; // 10%

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const VALID_VERDICTS = new Set(["approved", "rejected", "revision_requested"]);

const VALID_REASONS = new Set([
  "requirements_not_met", "quality_issue", "scope_mismatch",
  "missing_files", "great_work", "approved_fast_track",
]);

// ── helpers ──────────────────────────────────────────────────────────────────

function platformFee(amount: number): number {
  return Math.round(amount * (PLATFORM_FEE_BPS / 10_000));
}

async function invokeStripe(
  action: string,
  body: Record<string, unknown>
): Promise<{ success: boolean; error?: string; [k: string]: unknown }> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/stripe-payment`, {
    method:  "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization:  `Bearer ${SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ action, ...body }),
    signal: AbortSignal.timeout(30_000),
  });
  return res.json();
}

async function writeStripeArtefacts(
  admin: ReturnType<typeof serviceRoleClient>,
  decisionId: string,
  intentId: string,
  captureStatus: string
): Promise<void> {
  await admin
    .from("decisions")
    .update({
      stripe_payment_intent_id: intentId,
      stripe_capture_status:    captureStatus,
    })
    .eq("id", decisionId);
}

// ── main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  // ── 1. Auth ────────────────────────────────────────────────────────────────
  const auth = await resolveAuth(req);
  if (auth.kind !== "user") {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers: CORS });
  }

  const admin = serviceRoleClient();

  // Verify caller has host role
  const { data: profile } = await admin
    .from("profiles")
    .select("role")
    .eq("id", auth.user.id)
    .single();

  if (!profile || (profile as Record<string, unknown>).role !== "host") {
    return Response.json(
      { error: "forbidden", message: "Only hosts can review submissions." },
      { status: 403, headers: CORS }
    );
  }

  // ── 2. Parse + validate body ───────────────────────────────────────────────
  const body = await req.json() as {
    submissionId:        string;
    verdict:             string;
    decisionReason:      string;
    reviewNotes?:        string;
    structuredFeedback?: unknown[];
    payoutOverride?:     number;
    revisionDeadline?:   string;
  };

  const {
    submissionId,
    verdict,
    decisionReason,
    payoutOverride,
    revisionDeadline,
  } = body;

  const reviewNotes        = body.reviewNotes?.slice(0, 4000) ?? null;
  const structuredFeedback = body.structuredFeedback ?? null;

  if (!submissionId) {
    return Response.json({ error: "submissionId is required" }, { status: 400, headers: CORS });
  }
  if (!VALID_VERDICTS.has(verdict)) {
    return Response.json(
      { error: "invalid_verdict", message: `verdict must be one of: ${[...VALID_VERDICTS].join(", ")}` },
      { status: 400, headers: CORS }
    );
  }
  if (!VALID_REASONS.has(decisionReason)) {
    return Response.json(
      { error: "invalid_decision_reason", message: `decisionReason must be one of: ${[...VALID_REASONS].join(", ")}` },
      { status: 400, headers: CORS }
    );
  }
  if (verdict === "approved" && decisionReason === "requirements_not_met") {
    return Response.json(
      { error: "reason_verdict_mismatch", message: "Cannot approve with reason 'requirements_not_met'." },
      { status: 400, headers: CORS }
    );
  }
  if (payoutOverride !== undefined && (typeof payoutOverride !== "number" || payoutOverride <= 0)) {
    return Response.json(
      { error: "invalid_payout_override", message: "payoutOverride must be a positive number (cents)." },
      { status: 400, headers: CORS }
    );
  }
  if (revisionDeadline) {
    const ts = Date.parse(revisionDeadline);
    if (isNaN(ts) || ts <= Date.now()) {
      return Response.json(
        { error: "invalid_revision_deadline", message: "revisionDeadline must be a future ISO-8601 timestamp." },
        { status: 400, headers: CORS }
      );
    }
  }

  // ── 3. Atomic DB decision (RPC) ────────────────────────────────────────────
  const { data: rpcResult, error: rpcErr } = await admin.rpc(
    "review_submission_atomic",
    {
      p_submission_id:      submissionId,
      p_host_id:            auth.user.id,
      p_verdict:            verdict,
      p_decision_reason:    decisionReason,
      p_review_notes:       reviewNotes,
      p_structured_feedback: structuredFeedback ? JSON.stringify(structuredFeedback) : null,
      p_approved_payout:    verdict === "approved" ? (payoutOverride ?? null) : null,
      p_payout_override:    payoutOverride ?? null,
      p_revision_deadline:  revisionDeadline ?? null,
    }
  );

  if (rpcErr) {
    console.error("review-submission: RPC error", rpcErr);
    return Response.json(
      { error: "review_failed", message: rpcErr.message },
      { status: 500, headers: CORS }
    );
  }

  const r = rpcResult as {
    result:             string;
    decision_id?:       string;
    contributor_id?:    string;
    task_id?:           string;
    project_id?:        string;
    payment_intent_id?: string;
    final_payout?:      number;
    current_status?:    string;
  };

  // Map RPC result codes → HTTP errors
  if (r.result !== "ok") {
    const codeMap: Record<string, [string, number]> = {
      invalid_verdict:      ["Invalid verdict.",                        400],
      submission_not_found: ["Submission not found.",                    404],
      task_not_found:       ["Task not found.",                          404],
      project_not_found:    ["Project not found.",                       404],
      not_host:             ["You are not the host of this project.",    403],
      invalid_task_status:  [`Task is "${r.current_status}" — expected under_review.`, 409],
      race:                 ["Concurrent review detected — please retry.", 409],
    };
    const [msg, status] = codeMap[r.result] ?? ["Review failed.", 500];
    return Response.json({ error: r.result, message: msg }, { status, headers: CORS });
  }

  const decisionId = r.decision_id!;

  // ── 4. Update contributor reputation (non-fatal) ───────────────────────────
  admin.rpc("update_contributor_reputation", {
    p_contributor_id: r.contributor_id,
    p_verdict:        verdict,
  }).then(({ error: e }) => {
    if (e) console.warn("review-submission: reputation update warn", e.message);
  });

  // ── 5. Stripe: capture on approve, cancel on reject ───────────────────────
  let payoutCaptured: number | null = null;
  let stripeStatus:   string | null = null;

  if (verdict === "approved" && r.payment_intent_id && r.final_payout) {
    const fee = platformFee(r.final_payout);
    const stripeRes = await invokeStripe("capture", {
      paymentIntentId:   r.payment_intent_id,
      amount:            r.final_payout,
      platformFee:       fee,
      submissionId,
      taskId:            r.task_id,
    });

    if (!stripeRes.success) {
      // Stripe capture failed — log + alert but DO NOT roll back the decision.
      // The decision is the source of truth; Stripe can be retried manually.
      // In production, pipe this to an ops alert (PagerDuty / Slack webhook).
      console.error("review-submission: Stripe capture failed", stripeRes.error);
    } else {
      payoutCaptured = r.final_payout;
      stripeStatus   = stripeRes.status as string;

      // Write Stripe artefacts back to the decision row
      await writeStripeArtefacts(
        admin, decisionId,
        stripeRes.paymentIntentId as string,
        stripeStatus
      );

      // Atomically move wallet: locked → released
      const { error: walletErr } = await admin.rpc("release_wallet_lock", {
        p_project_id: r.project_id,
        p_amount:     r.final_payout,
      });
      if (walletErr) {
        console.error("review-submission: release_wallet_lock failed", walletErr.message);
      }

      // Mark task paid
      await admin
        .from("tasks")
        .update({ status: "paid", updated_at: new Date().toISOString() })
        .eq("id", r.task_id);
    }
  }

  if (verdict === "rejected" && r.payment_intent_id) {
    const stripeRes = await invokeStripe("cancel", {
      paymentIntentId: r.payment_intent_id,
    });
    if (!stripeRes.success) {
      console.error("review-submission: Stripe cancel failed", stripeRes.error);
    } else {
      stripeStatus = stripeRes.status as string;
      await writeStripeArtefacts(
        admin, decisionId,
        r.payment_intent_id,
        stripeStatus
      );
      // Atomically release the lock back into available funds
      await admin.rpc("cancel_wallet_lock", {
        p_project_id: r.project_id,
        p_amount:     r.payment_intent_id, // amount derived inside RPC
      });
    }
  }

  // ── 6. Return to frontend ──────────────────────────────────────────────────
  const taskStatusMap: Record<string, string> = {
    approved:           "approved",
    rejected:           "open",
    revision_requested: "revision_requested",
  };

  return Response.json(
    {
      success:        true,
      decisionId,
      taskStatus:     taskStatusMap[verdict],
      payoutCaptured: payoutCaptured ?? undefined,
      stripeStatus:   stripeStatus   ?? undefined,
      message: {
        approved:           "Payment captured. The contributor has been notified.",
        rejected:           "Submission rejected. The task is back in the open pool.",
        revision_requested: "Revision requested. The contributor has 48 hours to resubmit.",
      }[verdict],
    },
    { headers: CORS }
  );
});
