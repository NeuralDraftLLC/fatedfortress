/**
 * supabase/functions/stripe-webhook/index.ts
 *
 * Handles Stripe webhook events for the Fated Fortress payment lifecycle.
 *
 * Events handled:
 *   - payment_intent.succeeded:      PI captured — update task to paid, insert decision
 *   - payment_intent.payment_failed: PI capture failed — revert task to open, notify host
 *   - transfer.created:              Funds moved to Connect account — audit log
 *   - account.updated:               Host Connect account status — write charges/payouts_enabled
 *
 * FIX: Previous implementation computed HMAC as a base64 string and compared it
 * to the hex-encoded v1 signature from Stripe. Stripe always sends lowercase hex.
 * This fix converts the HMAC digest bytes to a hex string for a correct comparison.
 */

import { serviceRoleClient } from "../_shared/auth.ts";

// ── Stripe signature verification ─────────────────────────────────────────────

/**
 * Verify a Stripe webhook signature.
 * Stripe signs: `${timestamp}.${rawBody}` with HMAC-SHA256, hex-encoded.
 * Docs: https://stripe.com/docs/webhooks/signatures
 */
async function verifyStripeSignature(
  body: string,
  sig: string,
  secret: string
): Promise<Record<string, unknown>> {
  const parts = sig.split(",");
  const timestamp = parts.find(p => p.startsWith("t="))?.slice(2) ?? "";
  const expectedHex = parts.find(p => p.startsWith("v1="))?.slice(3) ?? "";

  if (!timestamp || !expectedHex) {
    throw new Error("Invalid Stripe-Signature header format");
  }

  // Reject events older than 5 minutes to prevent replay attacks
  const tolerance = 5 * 60; // seconds
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > tolerance) {
    throw new Error("Stripe webhook timestamp outside tolerance window");
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signedPayload = `${timestamp}.${body}`;
  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(signedPayload)
  );

  // FIX: Convert digest bytes to lowercase hex — NOT base64.
  // Previous code used btoa(String.fromCharCode(...bytes)) which produces base64,
  // but Stripe's v1 signatures are always lowercase hex.
  const computedHex = Array.from(new Uint8Array(signatureBuffer))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

  if (computedHex !== expectedHex) {
    throw new Error("Stripe signature mismatch");
  }

  return JSON.parse(body);
}

// ── Stripe API helper ──────────────────────────────────────────────────────────

async function stripeRequest(
  method: string,
  path: string,
  body?: Record<string, string>
): Promise<unknown> {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${Deno.env.get("STRIPE_SECRET_KEY")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body ? new URLSearchParams(body).toString() : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message ?? "Stripe API error");
  return data;
}

// ── Main handler ───────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!webhookSecret) {
    console.error("stripe-webhook: STRIPE_WEBHOOK_SECRET is not set");
    return new Response("Webhook secret not configured", { status: 500 });
  }

  const sig = req.headers.get("Stripe-Signature") ?? "";
  const rawBody = await req.text();

  let event: Record<string, unknown>;
  try {
    event = await verifyStripeSignature(rawBody, sig, webhookSecret);
  } catch (e) {
    console.error("stripe-webhook: signature verification failed", (e as Error).message);
    return new Response("Signature verification failed", { status: 400 });
  }

  const supabase = serviceRoleClient();
  const eventType = event.type as string;
  const data = (event.data as Record<string, unknown>)?.["object"] as Record<string, unknown>;

  console.log(`stripe-webhook: received ${eventType}`);

  try {
    switch (eventType) {
      case "payment_intent.succeeded": {
        const piId = data.id as string;

        const { data: task } = await supabase
          .from("tasks")
          .select("id, status, project:projects(host_id)")
          .eq("payment_intent_id", piId)
          .single();

        if (!task) {
          console.warn(`stripe-webhook: no task found for PI ${piId}`);
          break;
        }

        const t = task as Record<string, unknown>;
        if (t.status === "paid") {
          console.log(`stripe-webhook: task ${t.id} already paid — skipping (idempotent)`);
          break;
        }

        const taskId = t.id as string;
        const hostId = (t.project as Record<string, unknown>)?.host_id as string | null;

        const { data: submission } = await supabase
          .from("submissions")
          .select("id, contributor_id, payment_intent_id")
          .eq("task_id", taskId)
          .order("created_at", { ascending: false })
          .limit(1)
          .single();

        const sub = submission as Record<string, unknown> | null;
        const submissionId = sub?.id as string | undefined;

        if (submissionId && hostId) {
          const { data: existing } = await supabase
            .from("decisions")
            .select("id")
            .eq("submission_id", submissionId)
            .limit(1)
            .maybeSingle();

          if (!existing) {
            await supabase.from("decisions").insert({
              submission_id:   submissionId,
              host_id:         hostId,
              decision_reason: "great_work",
              review_notes:    "Captured via Stripe webhook",
              approved_payout: data.amount ? Number(data.amount) / 100 : null,
            });
          }
        }

        await supabase
          .from("tasks")
          .update({ status: "paid", reviewed_at: new Date().toISOString() })
          .eq("id", taskId);

        if (hostId) {
          await supabase.from("audit_log").insert({
            actor_id: hostId,
            task_id:  taskId,
            action:   "payment_released",
            payload:  { paymentIntentId: piId, source: "webhook" },
          });
        }

        console.log(`stripe-webhook: task ${taskId} marked paid from PI ${piId}`);
        break;
      }

      case "payment_intent.payment_failed": {
        const piId = data.id as string;

        const { data: task } = await supabase
          .from("tasks")
          .select("id, status, project:projects(host_id)")
          .eq("payment_intent_id", piId)
          .maybeSingle();

        if (!task) break;

        const t = task as Record<string, unknown>;
        const taskId = t.id as string;
        const hostId = (t.project as Record<string, unknown>)?.host_id as string | null;

        // Revert to open so the task can be re-claimed or re-funded
        await supabase
          .from("tasks")
          .update({ status: "open" })
          .eq("id", taskId)
          .in("status", ["claimed", "under_review"]);

        if (hostId) {
          await supabase.from("notifications").insert({
            user_id: hostId,
            type:    "verification_failed",
            task_id: taskId,
          });
        }

        console.log(`stripe-webhook: PI ${piId} failed — task ${taskId} reverted to open`);
        break;
      }

      case "transfer.created": {
        const transferId   = data.id as string;
        const destAccount  = data.destination as string;
        const amount       = data.amount as number;

        const { data: hostProfile } = await supabase
          .from("profiles")
          .select("id")
          .eq("stripe_account_id", destAccount)
          .single();

        if (hostProfile) {
          await supabase.from("audit_log").insert({
            actor_id: (hostProfile as Record<string, unknown>).id,
            action:   "transfer_created",
            payload:  { transferId, amount: amount / 100, destination: destAccount },
          });
        }

        console.log(`stripe-webhook: transfer ${transferId} → ${destAccount} ($${amount / 100})`);
        break;
      }

      case "account.updated": {
        const accountId      = data.id as string;
        const chargesEnabled = data.charges_enabled as boolean;
        const payoutsEnabled = data.payouts_enabled as boolean;

        // FIX: Previous handler was a no-op. Now write the capability flags back
        // to profiles so the UI can show onboarding completion status and gate
        // host actions (e.g., "fund project") behind charges_enabled.
        const { error: profileErr } = await supabase
          .from("profiles")
          .update({
            stripe_charges_enabled: chargesEnabled,
            stripe_payouts_enabled: payoutsEnabled,
          })
          .eq("stripe_account_id", accountId);

        if (profileErr) {
          console.error(
            `stripe-webhook: failed to update profile for account ${accountId}`,
            profileErr.message
          );
        } else {
          console.log(
            `stripe-webhook: account ${accountId} — charges:${chargesEnabled} payouts:${payoutsEnabled}`
          );
        }
        break;
      }

      default:
        console.log(`stripe-webhook: unhandled event type ${eventType} — ignoring`);
    }
  } catch (handlerErr) {
    // Log but always return 200 so Stripe does not retry indefinitely.
    // Critical failures should be investigated via Stripe Dashboard event logs.
    console.error(`stripe-webhook: handler error for ${eventType}`, handlerErr);
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
