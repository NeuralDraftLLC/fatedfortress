/**
 * supabase/functions/create-payment-intent/index.ts
 *
 * Creates a Stripe PaymentIntent with manual capture at CLAIM time.
 * Called from tasks.ts when a contributor claims a task — BEFORE submission.
 * The PI is stored on tasks.payment_intent_id and used at capture time (Step 6).
 *
 * Why claim-time? So the host has already authorized the hold before the
 * contributor does work. Without this, a contributor could do work and then
 * discover the host has no valid payment method at approval time.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { resolveAuth } from "../_shared/auth.ts";

const PLATFORM_FEE_BPS = 1000; // 10%

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

Deno.serve(async (req: Request) => {
  const auth = await resolveAuth(req);
  if (auth.kind !== "user") {
    return new Response("Unauthorized", { status: 401 });
  }

  const { taskId, amount, connectedAccountId } = await req.json();

  if (!taskId || !amount || amount <= 0) {
    return Response.json({ success: false, error: "taskId and positive amount are required" }, { status: 400 });
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Verify the task exists and is claimable (status = 'open')
  const { data: task, error: taskError } = await supabase
    .from("tasks")
    .select("id, status, payout_min, payout_max, project:projects(host_id)")
    .eq("id", taskId)
    .single();

  if (taskError || !task) {
    return Response.json({ success: false, error: "Task not found" }, { status: 404 });
  }

  if ((task as Record<string, unknown>).status !== "open") {
    return Response.json({ success: false, error: "Task is no longer claimable" }, { status: 409 });
  }

  const hostId = (task.project as Record<string, unknown>)?.host_id as string;

  // Fetch host profile for Stripe Connect account
  const { data: hostProfile } = await supabase
    .from("profiles")
    .select("stripe_account_id")
    .eq("id", hostId)
    .single();

  const accountId = connectedAccountId ?? (hostProfile as Record<string, unknown>)?.stripe_account_id as string | null;

  const platformFee = Math.round(amount * (PLATFORM_FEE_BPS / 10000));

  const paymentIntentParams: Record<string, string> = {
    amount: amount.toString(),
    currency: "usd",
    "capture_method": "manual",
    "metadata[taskId]": taskId,
    "metadata[hostId]": hostId,
    "metadata[platformFee]": platformFee.toString(),
  };

  if (accountId) {
    paymentIntentParams["transfer_data[destination]"] = accountId;
    paymentIntentParams["application_fee_amount"] = platformFee.toString();
  }

  const paymentIntent = await stripeRequest(
    "POST",
    "payment_intents",
    paymentIntentParams
  ) as { id: string; client_secret: string };

  // Store PI id on the task for capture-time lookup (stripe-webhook also uses this)
  await supabase
    .from("tasks")
    .update({ payment_intent_id: paymentIntent.id } as Record<string, unknown>)
    .eq("id", taskId);

  return Response.json({
    success: true,
    paymentIntentId: paymentIntent.id,
    clientSecret: paymentIntent.client_secret,
  });
});