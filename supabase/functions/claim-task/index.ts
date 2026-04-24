/**
 * supabase/functions/claim-task/index.ts
 *
 * Stage 2 orchestrator — the ONLY path to claiming a task.
 *
 * Flow:
 *   1. Validate contributor profile (role = 'contributor', stripe account present)
 *   2. Fetch task + project for payout amount
 *   3. Create Stripe PaymentIntent (manual capture, 10% platform fee)
 *   4. Call claim_task_atomic RPC (SELECT FOR UPDATE SKIP LOCKED)
 *      → if RPC fails, cancel the PI immediately (no orphaned holds)
 *   5. Return { task, paymentIntentClientSecret } to frontend
 *
 * The frontend uses paymentIntentClientSecret with stripe.confirmCardPayment()
 * to authorise the hold. The card is NOT charged until host approves.
 *
 * POST body:
 * {
 *   taskId: string (uuid)
 * }
 */

import { resolveAuth, serviceRoleClient } from "../_shared/auth.ts";

const PLATFORM_FEE_BPS = 1000; // 10%
const CLAIM_HOURS      = 48;   // soft-lock window

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Stripe helper ────────────────────────────────────────────────────────────────

async function stripePost(path: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${Deno.env.get("STRIPE_SECRET_KEY")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body).toString(),
  });
  const data = await res.json() as Record<string, unknown>;
  if (!res.ok) throw new Error((data.error as Record<string, string>)?.message ?? "Stripe error");
  return data;
}

async function cancelPaymentIntent(piId: string): Promise<void> {
  try {
    await stripePost(`payment_intents/${piId}/cancel`, {});
  } catch (e) {
    console.error("claim-task: failed to cancel PI", piId, e);
  }
}

// ── Handler ─────────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const auth = await resolveAuth(req);
  if (auth.kind !== "user") {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers: CORS });
  }

  const admin = serviceRoleClient();

  // ── Step 1: Contributor profile validation ─────────────────────────────
  const { data: profile, error: profErr } = await admin
    .from("profiles")
    .select("role, contributor_stripe_account_id, display_name")
    .eq("id", auth.user.id)
    .single();

  if (profErr || !profile) {
    return Response.json({ error: "Profile not found" }, { status: 404, headers: CORS });
  }

  const p = profile as { role: string; contributor_stripe_account_id: string | null; display_name: string };

  if (p.role !== "contributor") {
    return Response.json(
      { error: "Only contributors can claim tasks" },
      { status: 403, headers: CORS }
    );
  }

  if (!p.contributor_stripe_account_id) {
    return Response.json(
      {
        error: "stripe_onboarding_required",
        message: "Connect a Stripe account before claiming paid tasks.",
        onboarding_url: "/settings/stripe-connect",
      },
      { status: 402, headers: CORS }
    );
  }

  // ── Step 2: Fetch task + payout amount ─────────────────────────────────────
  const { taskId } = await req.json() as { taskId: string };

  if (!taskId) {
    return Response.json({ error: "taskId is required" }, { status: 400, headers: CORS });
  }

  const { data: task, error: taskErr } = await admin
    .from("tasks")
    .select(`
      id, status, payout_min, payout_max, task_access, title, description,
      project_id, spec_constraints,
      project:projects ( id, host_id, title,
        host:profiles!projects_host_id_fkey ( stripe_account_id ) )
    `)
    .eq("id", taskId)
    .single();

  if (taskErr || !task) {
    return Response.json({ error: "Task not found" }, { status: 404, headers: CORS });
  }

  const t = task as Record<string, unknown>;
  const project = t.project as Record<string, unknown>;
  const host    = project?.host as Record<string, unknown>;

  if (t.status !== "open") {
    return Response.json(
      { error: "already_claimed", message: "This task is no longer available." },
      { status: 409, headers: CORS }
    );
  }

  // Use payout_max as the hold amount (contributor earns up to this)
  const holdAmount = Math.round(Number(t.payout_max) || 0);

  if (holdAmount <= 0) {
    return Response.json(
      { error: "Task has no payout configured" },
      { status: 400, headers: CORS }
    );
  }

  // ── Step 3: Create Stripe PaymentIntent (manual capture) ────────────────
  const platformFee = Math.round(holdAmount * (PLATFORM_FEE_BPS / 10000));
  const hostStripeAccount = host?.stripe_account_id as string | undefined;

  const piParams: Record<string, string> = {
    amount:                             holdAmount.toString(),
    currency:                           "usd",
    capture_method:                     "manual",
    "metadata[task_id]":                taskId,
    "metadata[contributor_id]":         auth.user.id,
    "metadata[host_id]":                project.host_id as string,
    "metadata[platform_fee_cents]":     platformFee.toString(),
    "metadata[contributor_account_id]": p.contributor_stripe_account_id,
    "transfer_data[destination]":       p.contributor_stripe_account_id,
    application_fee_amount:             platformFee.toString(),
  };

  if (hostStripeAccount) {
    piParams["on_behalf_of"] = hostStripeAccount;
  }

  let pi: Record<string, unknown>;
  try {
    pi = await stripePost("payment_intents", piParams);
  } catch (err) {
    console.error("claim-task: Stripe PI creation failed", err);
    return Response.json(
      { error: "payment_setup_failed", message: (err as Error).message },
      { status: 502, headers: CORS }
    );
  }

  const piId           = pi.id as string;
  const clientSecret   = pi.client_secret as string;

  // ── Step 4: Atomically claim the task in Postgres ───────────────────────
  const { data: claimResult, error: claimErr } = await admin
    .rpc("claim_task_atomic", {
      p_task_id:              taskId,
      p_contributor_id:       auth.user.id,
      p_payment_intent_id:    piId,
      p_claim_duration_hours: CLAIM_HOURS,
    });

  const resultCode = claimResult as string | null;

  if (claimErr || resultCode !== "ok") {
    // RPC failed — cancel the Stripe PI immediately so no hold lingers
    await cancelPaymentIntent(piId);

    const userMessages: Record<string, string> = {
      already_claimed: "Another contributor just claimed this task. Try a different one.",
      not_open:        "This task is no longer available.",
      invite_only:     "This task requires an invitation.",
      wallet_error:    "The project wallet has insufficient funds for this task.",
      not_found:       "Task not found.",
    };

    const code    = resultCode ?? "unknown";
    const message = userMessages[code] ?? "Claim failed. Please try again.";
    const status  = code === "already_claimed" ? 409 :
                    code === "invite_only"     ? 403 :
                    code === "wallet_error"    ? 402 : 400;

    return Response.json({ error: code, message }, { status, headers: CORS });
  }

  // ── Step 5: Return claimed task + PI client secret to frontend ─────────
// Frontend calls stripe.confirmPayment({ clientSecret, confirmParams: { return_url } })
// to authorise the hold. Card is NOT charged until host approves.

  const { data: claimedTask } = await admin
    .from("tasks")
    .select("id, status, claimed_at, soft_lock_expires_at, payment_intent_id, title, payout_max")
    .eq("id", taskId)
    .single();

  return Response.json(
    {
      success: true,
      task: claimedTask,
      payment_intent_client_secret: clientSecret,
      claim_expires_at: (claimedTask as Record<string, unknown>)?.soft_lock_expires_at,
      message: `Task claimed! You have ${CLAIM_HOURS} hours to submit your work.`,
    },
    { headers: CORS }
  );
});
