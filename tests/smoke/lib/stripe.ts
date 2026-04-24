/**
 * tests/smoke/lib/stripe.ts
 * Minimal Stripe test-mode helpers.
 */

import { config } from "./config.ts";

async function stripePost(path: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.stripeKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body).toString(),
  });
  const data = await res.json() as Record<string, unknown>;
  if (!res.ok) throw new Error((data.error as Record<string, string>)?.message ?? "Stripe error");
  return data;
}

/** Create a test PaymentIntent with manual capture. Returns the PI object. */
export async function createTestPaymentIntent(amountCents: number): Promise<{
  id: string;
  client_secret: string;
  status: string;
}> {
  const pi = await stripePost("payment_intents", {
    amount:           amountCents.toString(),
    currency:         "usd",
    capture_method:   "manual",
    // Attach a test payment method so it can be confirmed
    payment_method:   "pm_card_visa",
    confirm:          "true",
    "metadata[smoke]": "true",
  });
  return pi as { id: string; client_secret: string; status: string };
}

/** Capture a PaymentIntent. */
export async function capturePaymentIntent(piId: string): Promise<{ status: string }> {
  return await stripePost(`payment_intents/${piId}/capture`, {}) as { status: string };
}

/** Cancel a PaymentIntent (cleanup). */
export async function cancelPaymentIntent(piId: string): Promise<void> {
  await stripePost(`payment_intents/${piId}/cancel`, {}).catch(() => {
    // Already cancelled/captured — safe to ignore
  });
}
