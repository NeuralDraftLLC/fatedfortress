/**
 * supabase/functions/expire-claims/index.ts
 *
 * Runs every 5 minutes via Supabase cron or pg_cron.
 * Reclaims soft-locked tasks whose soft_lock_expires_at has passed.
 * Cancels the held Stripe PaymentIntent so the contributor's card is released.
 * Notifies the contributor (claim_expired) and the host (task back to open).
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

async function stripeCancel(piId: string): Promise<void> {
  try {
    const res = await fetch(`https://api.stripe.com/v1/payment_intents/${piId}/cancel`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${Deno.env.get("STRIPE_SECRET_KEY")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    if (!res.ok) {
      const err = await res.json() as Record<string, unknown>;
      console.warn(`expire-claims: Stripe cancel failed for ${piId}:`, err.error);
    }
  } catch (e) {
    console.error(`expire-claims: network error cancelling PI ${piId}:`, e);
  }
}

Deno.serve(async (req: Request) => {
  const authHeader = req.headers.get("Authorization") ?? "";
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  // ── Fetch expired claimed tasks (include PI id and project_id for wallet unlock) ─
  const { data: expiredTasks, error: fetchError } = await supabase
    .from("tasks")
    .select("id, claimed_by, title, project_id, payout_max, payment_intent_id")
    .eq("status", "claimed")
    .lt("soft_lock_expires_at", new Date().toISOString());

  if (fetchError) {
    console.error("expire-claims: fetch error", fetchError);
    return new Response(JSON.stringify({ error: fetchError.message }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }

  if (!expiredTasks || expiredTasks.length === 0) {
    return new Response(JSON.stringify({ reclaimed: 0 }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const taskIds = expiredTasks.map(t => t.id);

  // ── Cancel held Stripe PaymentIntents first (before DB state changes) ───────
  await Promise.allSettled(
    expiredTasks
      .filter(t => t.payment_intent_id)
      .map(t => stripeCancel(t.payment_intent_id!))
  );

  // ── Reclaim all expired tasks ─────────────────────────────────────────────
  const { error: updateError } = await supabase
    .from("tasks")
    .update({
      status:               "open",
      claimed_by:           null,
      claimed_at:           null,
      soft_lock_expires_at: null,
      payment_intent_id:    null,
    })
    .in("id", taskIds);

  if (updateError) {
    console.error("expire-claims: update error", updateError);
    return new Response(JSON.stringify({ error: updateError.message }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }

  // ── Unlock wallet for each expired task ───────────────────────────────────
  await Promise.allSettled(
    expiredTasks
      .filter(t => t.payout_max && t.payout_max > 0)
      .map(t =>
        supabase.rpc("unlock_wallet", {
          p_project_id: t.project_id,
          p_amount:     t.payout_max,
        }).then(() => ({ taskId: t.id, ok: true }))
        .catch(err => { console.warn("expire-claims: unlock_wallet failed", t.id, err); return { taskId: t.id, ok: false }; })
      )
  );

  // ── Notify contributors ─────────────────────────────────────────────────────
  const priorClaimants = expiredTasks.filter(t => t.claimed_by);

  if (priorClaimants.length > 0) {
    await supabase.from("notifications").insert(
      priorClaimants.map(t => ({
        user_id: t.claimed_by,
        type:    "claim_expired",
        task_id: t.id,
      }))
    );

    await supabase.from("audit_log").insert(
      priorClaimants.map(t => ({
        actor_id: t.claimed_by,
        task_id:  t.id,
        action:   "claim_expired",
        payload:  { title: t.title },
      }))
    );
  }

  console.log(`expire-claims: reclaimed ${expiredTasks.length} tasks`);
  return new Response(JSON.stringify({ reclaimed: expiredTasks.length }), {
    headers: { "Content-Type": "application/json" },
  });
});
