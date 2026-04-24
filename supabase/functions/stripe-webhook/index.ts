/**
 * supabase/functions/stripe-webhook/index.ts
 *
 * Handles Stripe webhook events for the Fated Fortress payment lifecycle.
 *
 * Run after: claim-time PaymentIntent (Step 2) and capture (Step 5/6) are real.
 *
 * Events handled:
 *   - payment_intent.succeeded:  PI was captured — update task to paid, insert decision
 *   - payment_intent.payment_failed: PI capture failed — revert task to open, notify host
 *   - transfer.created: funds moved to host Connect account — audit log
 *   - account.updated: host Stripe account status change — update profiles.stripe_account_id
 *
 * Verification: raw request body signed with Stripe signature header.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { serviceRoleClient } from "../_shared/auth.ts";

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

function verifyStripeSignature(body: string, sig: string, secret: string): Record<string, unknown> {
  const timestamp = sig.split(",").find(p => p.startsWith("t="))?.slice(2) ?? "";
  const expectedSig = sig.split(",").find(p => p.startsWith("v1="))?.slice(3) ?? "";

  // HMAC-SHA256 of timestamp + "." + raw body using secret
  const encoder = new TextEncoder();
  const key = encoder.encode(secret);
  const message = encoder.encode(`${timestamp}.${body}`);
  const hash = new Uint8Array(await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]).then(k => crypto.subtle.sign("HMAC", k, message)));
  const sigBase64 = btoa(String.fromCharCode(...hash));

  if (sigBase64 !== expectedSig) {
    throw new Error("Stripe signature mismatch");
  }

  return JSON.parse(body);
}

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
    event = verifyStripeSignature(rawBody, sig, webhookSecret) as Record<string, unknown>;
  } catch {
    return new Response("Signature verification failed", { status: 400 });
  }

  const supabase = serviceRoleClient();
  const eventType = event.type as string;
  const data = event.data?.["object"] as Record<string, unknown>;

  console.log(`stripe-webhook: received ${eventType}`);

  switch (eventType) {
    case "payment_intent.succeeded": {
      const piId = data.id as string;

      // Find task by payment_intent_id
      const { data: task } = await supabase
        .from("tasks")
        .select("id, status, project:projects(host_id)")
        .eq("payment_intent_id", piId)
        .single();

      if (!task) {
        console.warn(`stripe-webhook: no task found for PI ${piId}`);
        break;
      }

      // If task is already paid, skip
      if ((task as Record<string, unknown>).status === "paid") {
        console.log(`stripe-webhook: task ${(task as Record<string, unknown>).id} already paid, skipping`);
        break;
      }

      const taskId = (task as Record<string, unknown>).id as string;
      const hostId = (task as Record<string, unknown>).project as Record<string, unknown> && (task as Record<string, unknown>).project as Record<string, unknown> !== null
        ? ((task as Record<string, unknown>).project as Record<string, unknown>)?.host_id as string
        : null;

      // Get submission for this task
      const { data: submission } = await supabase
        .from("submissions")
        .select("id, contributor_id, payment_intent_id")
        .eq("task_id", taskId)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      const submissionId = (submission as Record<string, unknown>)?.id as string | undefined;

      // Insert decision if not exists (idempotent on submission_id)
      if (submissionId && hostId) {
        const { data: existing } = await supabase
          .from("decisions")
          .select("id")
          .eq("submission_id", submissionId)
          .limit(1)
          .maybeSingle();

        if (!existing) {
          await supabase.from("decisions").insert({
            submission_id: submissionId,
            host_id: hostId,
            decision_reason: "great_work",
            review_notes: "Captured via Stripe webhook",
            approved_payout: data.amount ? Number(data.amount) / 100 : null,
          });
        }
      }

      // Update task to paid
      await supabase
        .from("tasks")
        .update({
          status: "paid",
          reviewed_at: new Date().toISOString(),
        } as Record<string, unknown>)
        .eq("id", taskId);

      // Audit log
      if (hostId) {
        await supabase.from("audit_log").insert({
          actor_id: hostId,
          task_id: taskId,
          action: "payment_released",
          payload: { paymentIntentId: piId, source: "webhook" },
        } as Record<string, unknown>);
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

      const taskId = (task as Record<string, unknown>).id as string;
      const hostId = (task as Record<string, unknown>).project as Record<string, unknown> !== null
        ? ((task as Record<string, unknown>).project as Record<string, unknown>)?.host_id as string
        : null;

      // Revert task to open (contributor's work is preserved, host can re-fund
      // and approve or reject manually)
      await supabase
        .from("tasks")
        .update({ status: "open" } as Record<string, unknown>)
        .eq("id", taskId)
        .in("status", ["claimed", "under_review"]);

      // Notify host
      if (hostId) {
        await supabase.from("notifications").insert({
          user_id: hostId,
          type: "verification_failed",
          task_id: taskId,
        } as Record<string, unknown>);
      }

      console.log(`stripe-webhook: PI ${piId} failed — task ${taskId} reverted to open`);
      break;
    }

    case "transfer.created": {
      const transferId = data.id as string;
      const destAccount = data.destination as string;
      const amount = data.amount as number;

      // Find host by stripe_account_id and create audit log
      const { data: hostProfile } = await supabase
        .from("profiles")
        .select("id")
        .eq("stripe_account_id", destAccount)
        .single();

      if (hostProfile) {
        await supabase.from("audit_log").insert({
          actor_id: (hostProfile as Record<string, unknown>).id,
          action: "payment_released",
          payload: { transferId, amount: amount / 100, destination: destAccount },
        } as Record<string, unknown>);
      }

      console.log(`stripe-webhook: transfer ${transferId} to ${destAccount} (${amount / 100})`);
      break;
    }

    case "account.updated": {
      const accountId = data.id as string;
      const chargesEnabled = data.charges_enabled as boolean;
      const payoutsEnabled = data.payouts_enabled as boolean;

      // Update profiles stripe_account_id with latest capabilities
      await supabase
        .from("profiles")
        .update({
          // Could extend schema to track stripe_charges_enabled / stripe_payouts_enabled
          // For now just log
        } as Record<string, unknown>)
        .eq("stripe_account_id", accountId);

      console.log(`stripe-webhook: account ${accountId} updated — charges:${chargesEnabled} payouts:${payoutsEnabled}`);
      break;
    }

    default:
      console.log(`stripe-webhook: unhandled event type ${eventType}`);
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
  });
});