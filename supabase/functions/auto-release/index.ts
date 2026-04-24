/**
 * supabase/functions/auto-release/index.ts
 *
 * Runs every 30 minutes via Supabase cron or pg_cron.
 *
 * 24h path:  Find under_review tasks with no decision after 24h since submission.
 *            Fire type = 'auto_release_warning' to host.
 *
 * 48h path:  Same cohort after 48h. Call releasePayout equivalent:
 *            decision_reason = 'approved_fast_track', task.status = 'paid',
 *            wallet locked/released updates, audit log, notify both parties
 *            type = 'auto_released'.
 *
 * Note: This function implements the releasePayout contract internally using
 * service-role key to avoid circular client dependencies. Only Stripe capture
 * happens here (same as the client-side releasePayout — no other site captures).
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const PLATFORM_FEE_BPS = 1000; // 10%
const WARNING_HOURS = 24;
const RELEASE_HOURS = 48;

function platformFee(amount: number): number {
  return Math.round(amount * (PLATFORM_FEE_BPS / 10000)); // cents, matches payout.ts
}

Deno.serve(async (req: Request) => {
  const authHeader = req.headers.get("Authorization") ?? "";
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const now = new Date();
  const warningCutoff = new Date(now.getTime() - WARNING_HOURS * 60 * 60 * 1000).toISOString();
  const releaseCutoff = new Date(now.getTime() - RELEASE_HOURS * 60 * 60 * 1000).toISOString();

  // ── 24h: auto_release_warning ───────────────────────────────────────────
  const { data: warningTasks } = await supabase
    .from("tasks")
    .select("id, title, submitted_at, project:projects(host_id)")
    .eq("status", "under_review")
    .lt("submitted_at", warningCutoff);

  if (warningTasks && warningTasks.length > 0) {
    const warnings = warningTasks.map(t => ({
      user_id: (t.project as Record<string, unknown>)?.host_id as string,
      type: "auto_release_warning",
      task_id: t.id,
    }));

    await supabase.from("notifications").insert(warnings);
    console.log(`auto-release: sent ${warnings.length} 24h warnings`);
  }

  // ── 48h: auto_released ─────────────────────────────────────────────────
  // Exclude tasks that were already warned at 24h to avoid double-processing
  const warnedTaskIds = warningTasks && warningTasks.length > 0
    ? warningTasks.map(t => t.id)
    : null;

  let releaseQuery = supabase
    .from("tasks")
    .select(`
      id,
      title,
      submitted_at,
      approved_payout,
      project:projects(id, host_id)
    `)
    .eq("status", "under_review")
    .lt("submitted_at", releaseCutoff);

  if (warnedTaskIds) {
    releaseQuery = releaseQuery.not.in("id", warnedTaskIds);
  }

  const { data: releaseTasks } = await releaseQuery;

  if (!releaseTasks || releaseTasks.length === 0) {
    return new Response(JSON.stringify({ warnings: warningTasks?.length ?? 0, released: 0 }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const results = await Promise.allSettled(
    releaseTasks.map(async (task) => {
      const project = task.project as Record<string, unknown>;
      const hostId = project?.host_id as string;
      const projectId = project?.id as string;
      const approvedPayout = task.approved_payout ?? task.payout_max ?? 0;

      // Look up host's Stripe Connect account for payout transfer
      const { data: hostProfile } = await supabase
        .from("profiles")
        .select("stripe_account_id")
        .eq("id", hostId)
        .single();

      const connectedAccountId = (hostProfile as Record<string, unknown>)?.stripe_account_id as string | null;

      // Get the latest submission for this task
      const { data: submission } = await supabase
        .from("submissions")
        .select("id, contributor_id, payment_intent_id")
        .eq("task_id", task.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (!submission) return;

      const contributorId = (submission as Record<string, unknown>)?.contributor_id as string;

      // Insert decision (approved_fast_track)
      await supabase.from("decisions").insert({
        submission_id: (submission as Record<string, unknown>)?.id,
        host_id: hostId,
        decision_reason: "approved_fast_track",
        review_notes: "Auto-released after 48 hours without host decision.",
        approved_payout: approvedPayout,
      });

      // Call Stripe payment capture via stripe-payment edge function
      try {
        await supabase.functions.invoke("stripe-payment", {
          body: {
            action: "capture",
            amount: approvedPayout,
            platformFee: platformFee(approvedPayout),
            paymentIntentId: (submission as Record<string, unknown>)?.payment_intent_id,
            connectedAccountId: connectedAccountId ?? null,
            submissionId: (submission as Record<string, unknown>)?.id,
            taskId: task.id,
          },
        });
      } catch (stripeErr) {
        console.error("auto-release: stripe capture failed for task", task.id, stripeErr);
      }

      // Update task to paid
      await supabase
        .from("tasks")
        .update({ status: "paid", reviewed_at: new Date().toISOString() } as Record<string, unknown>)
        .eq("id", task.id);

      // Release locked funds atomically (moves locked → released)
      await supabase.rpc("release_wallet_lock", {
        p_project_id: projectId,
        p_amount: approvedPayout,
      });

      // Audit log
      await supabase.from("audit_log").insert({
        actor_id: hostId,
        task_id: task.id,
        action: "auto_released",
        payload: { submissionId: (submission as Record<string, unknown>)?.id, approvedPayout },
      });

      // Notify host and contributor
      await supabase.from("notifications").insert([
        { user_id: hostId, type: "auto_released", task_id: task.id },
        { user_id: contributorId, type: "auto_released", task_id: task.id },
      ]);
    })
  );

  const released = results.filter(r => r.status === "fulfilled").length;
  console.log(`auto-release: ${released} tasks auto-released`);
  return new Response(JSON.stringify({ warnings: warningTasks?.length ?? 0, released }), {
    headers: { "Content-Type": "application/json" },
  });
});
