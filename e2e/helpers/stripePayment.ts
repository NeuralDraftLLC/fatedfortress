import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Calls stripe-payment "create" with the service key so the Edge Function
 * can create a manual-capture PaymentIntent and attach it to the submission.
 */
export async function bindPaymentIntentToSubmission(opts: {
  amountCents: number;
  taskId: string;
  submissionId: string;
  hostStripeConnectAccountId?: string | null;
}): Promise<{ paymentIntentId: string }> {
  const { amountCents, taskId, submissionId, hostStripeConnectAccountId } = opts;
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing service URL or key");

  const res = await fetch(`${url}/functions/v1/stripe-payment`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      action: "create",
      amount: amountCents,
      taskId,
      submissionId,
      connectedAccountId: hostStripeConnectAccountId ?? undefined,
    }),
  });

  const data = (await res.json()) as { success?: boolean; paymentIntentId?: string; error?: string };
  if (!res.ok || !data.success || !data.paymentIntentId) {
    throw new Error(data.error ?? `stripe-payment create failed: ${res.status}`);
  }
  return { paymentIntentId: data.paymentIntentId };
}

/**
 * Suggested amount in USD cents: use the midpoint of task min/max.
 */
export function amountCentsFromPayoutMinMax(
  min: string | number,
  max: string | number
): number {
  const a = Math.round(typeof min === "string" ? parseFloat(min) : min);
  const b = Math.round(typeof max === "string" ? parseFloat(max) : max);
  return Math.max(1, Math.round((a + b) / 2));
}

/**
 * If E2E_HOST_STRIPE_ACCOUNT is set, patch the host profile so the PI can use Connect transfer.
 */
export async function setHostStripeIfConfigured(
  supabase: SupabaseClient,
  hostUserId: string
): Promise<void> {
  const acct = process.env.E2E_HOST_STRIPE_CONNECT_ACCOUNT;
  if (!acct) return;
  const { error } = await supabase
    .from("profiles")
    .update({ stripe_account_id: acct } as Record<string, unknown>)
    .eq("id", hostUserId);
  if (error) throw new Error(`setHostStripe: ${error.message}`);
}

export async function getStripe() {
  const { default: Stripe } = await import("stripe");
  const sk = process.env.STRIPE_SECRET_KEY;
  if (!sk) {
    return null;
  }
  return new Stripe(sk);
}
