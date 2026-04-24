/**
 * apps/web/src/handlers/payout.ts — Stripe Connect onboarding + wallet helpers.
 *
 * NOTE: All review decisions now flow through the review-submission edge
 * function (apps/web/src/handlers/review.ts). This file no longer performs
 * payout logic or touches Stripe PaymentIntents directly.
 */

import { getSupabase } from "../auth/index.js";

// ---------------------------------------------------------------------------
// Connect onboarding (unchanged)
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
// Project wallet — fund / withdraw (kept; used by host create flow)
// ---------------------------------------------------------------------------

/** Pre-fund project wallet via atomic RPC — no racy read-then-update. */
export async function fundProjectWallet(
  projectId: string,
  amount: number
): Promise<void> {
  const supabase = getSupabase();

  const { error } = await supabase.rpc("upsert_wallet_deposited", {
    p_project_id: projectId,
    p_amount: amount,
  });
  if (error) throw error;
}
