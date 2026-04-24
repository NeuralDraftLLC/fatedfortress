/**
 * supabase/functions/expire-claims/index.ts
 *
 * Runs every 5 minutes via Supabase cron or pg_cron.
 * Reclaims soft-locked tasks whose soft_lock_expires_at has passed.
 * Notifies the previously assigned contributor via type = 'claim_expired'.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

Deno.serve(async (req: Request) => {
  // Optional: verify cron secret to prevent unauthorized runs
  const authHeader = req.headers.get("Authorization") ?? "";
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Find claimed tasks past their soft-lock expiry
  const { data: expiredTasks, error: fetchError } = await supabase
    .from("tasks")
    .select("id, claimed_by, title")
    .eq("status", "claimed")
    .lt("soft_lock_expires_at", new Date().toISOString());

  if (fetchError) {
    console.error("expire-claims: fetch error", fetchError);
    return new Response(JSON.stringify({ error: fetchError.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!expiredTasks || expiredTasks.length === 0) {
    return new Response(JSON.stringify({ reclaimed: 0 }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const taskIds = expiredTasks.map(t => t.id);
  const priorClaimants = expiredTasks.filter(t => t.claimed_by).map(t => ({
    taskId: t.id,
    claimedBy: t.claimed_by!,
    title: t.title,
  }));

  // Reclaim all expired tasks
  const { error: updateError } = await supabase
    .from("tasks")
    .update({
      status: "open",
      claimed_by: null,
      claimed_at: null,
      soft_lock_expires_at: null,
    })
    .in("id", taskIds);

  if (updateError) {
    console.error("expire-claims: update error", updateError);
    return new Response(JSON.stringify({ error: updateError.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Release any wallet locks held by the expired claims (funds return to available).
  // unlock_wallet is a no-op if no lock exists — safe to call for all expired tasks.
  const unlockResults = await Promise.allSettled(
    expiredTasks.map(t =>
      supabase.rpc("unlock_wallet", {
        p_project_id: t.project_id,
        p_amount: t.payout_max ?? 0,
      }).then(() => ({ taskId: t.id, ok: true }))
      .catch(err => ({ taskId: t.id, ok: false, err }))
    )
  );

  const unlockFailures = unlockResults.filter(r => r.status === "rejected" || !r.value.ok);
  if (unlockFailures.length > 0) {
    console.warn("expire-claims: unlock_wallet failures:", unlockFailures.slice(0, 3));
  }

  // Notify each prior contributor
  const notifications = priorClaimants.map(p => ({
    user_id: p.claimedBy,
    type: "claim_expired",
    task_id: p.taskId,
  }));

  if (notifications.length > 0) {
    const { error: notifError } = await supabase
      .from("notifications")
      .insert(notifications);

    if (notifError) {
      console.error("expire-claims: notification insert error", notifError);
    }
  }

  // Audit log entries
  const auditEntries = priorClaimants.map(p => ({
    actor_id: p.claimedBy,
    task_id: p.taskId,
    action: "claim_expired",
    payload: { title: p.title },
  }));

  if (auditEntries.length > 0) {
    const { error: auditError } = await supabase
      .from("audit_log")
      .insert(auditEntries);

    if (auditError) {
      console.error("expire-claims: audit log error", auditError);
    }
  }

  console.log(`expire-claims: reclaimed ${expiredTasks.length} tasks`);
  return new Response(JSON.stringify({ reclaimed: expiredTasks.length }), {
    headers: { "Content-Type": "application/json" },
  });
});
