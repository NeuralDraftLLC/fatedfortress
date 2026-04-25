/**
 * supabase/functions/create-payment-intent/index.ts  — TOMBSTONE
 *
 * This function is DEPRECATED and no longer an active HTTP endpoint.
 *
 * The claim flow previously called this function to create a Stripe
 * PaymentIntent at claim time. That responsibility now belongs entirely to:
 *   supabase/functions/claim-task/index.ts
 *
 * claim-task handles:
 *   - Wallet lock (lock_wallet_for_claim RPC)
 *   - Task state transition (open → claimed)
 *   - Stripe PI creation where applicable
 *
 * All HTTP calls to this endpoint receive 410 Gone.
 * No callers in the active codebase; safe to delete after the next
 * Supabase deploy confirms claim-task is stable in production.
 */

Deno.serve(() =>
  new Response(
    JSON.stringify({
      error: "Gone",
      message:
        "create-payment-intent is deprecated. The claim flow is handled by claim-task.",
    }),
    {
      status: 410,
      headers: { "Content-Type": "application/json" },
    }
  )
);
