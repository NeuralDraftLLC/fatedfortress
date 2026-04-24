/**
 * supabase/functions/auto-release/index.ts
 *
 * Runs every 30 minutes via Supabase cron or pg_cron.
 *
 * 24h path:  Find under_review tasks with no decision after 24h since submission.
 *            Fire type = 'auto_release_warning' to host.
 *
 * 48h path:  Find tasks from the 24h-warned cohort that still have no decision
 *            after 48h. Auto-release them:
 *            decision_reason = 'approved_fast_track', task.status = 'paid',
 *            wallet locked/released updates, audit log, notify both parties.
 *
 * Cohort logic:
 *   - 24h cohort: submitted_at < now-24h AND submitted_at >= now-48h  (the warning window)
 *   - 48h cohort: submitted_at < now-48h  (time to release)
 *   The 48h query is independent — it does NOT exclude the 24h cohort.
 *   Tasks may have missed the warning (e.g. function was down) and still must be released.
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
  return Math.round(amount * (PLATFORM_FEE_BPS / 10000));
}

Deno.serve(async (req: Request) => {
  const authHeader = req.headers.get("Authorization") ?? "";
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const now = new Date();
  const warningCutoff = new Date(now.getTime() - WARNING_HOURS * 60 * 60 * 1000).toISOString();
  const warningUpperBound = new Date(now.getTime() - RELEASE_HOURS * 60 * 60 * 1000).toISOString();
  const releaseCutoff = warningUpperBound; // tasks older than 48h get released

  // ── 24h: auto_release_warning ───────────────────────────────────────────
  // Warn tasks in the 24–48h window (submitted between 48h ago and 24h ago)
  const { data: warningTasks } = await supabase
    .from("tasks")
    .select("id, title, submitted_at, project:projects(host_id)")
    .eq("status", "under_review")
    .lt("submitted_at", warningCutoff)      // older than 24h
    .gte("submitted_at", warningUpperBound); // but not yet 48h old

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
  // Release ALL tasks older than 48h, regardless of whether they got a warning.
  // FIX: was using .not.in(...) which is invalid PostgREST chaining syntax.
  // The correct form is .not('col', 'in', `(${ids.join(',')})`) — but since
  // we no longer need to exclude the warning cohort, the filter is removed entirely.
  const { data: releaseTasks } = await supabase
    .from("tasks")
    .select(`
      id,
      title,
      submitted_at,
      approved_payout,
      payout_max,
      project:projects(id, host_id)
    `)
    .eq("status", "under_review")
    .lt("submitted_at", releaseCutoff);

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
      // Use approved_payout if set, otherwise fall back to payout_max
      const approvedPayout = Number(task.approved_payout ?? task.payout_max ?? 0);

      if (approvedPayout <= 0) {
        console.warn(`auto-release: task ${task.id} has no payout amount — skipping`);
        return;
      }

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

      if (!submission) {
        console.warn(`auto-release: no submission for task ${task.id} — skipping`);
        return;
      }

      const sub = submission as Record<string, unknown>;
      const contributorId = sub.contributor_id as string;
      const paymentIntentId = sub.payment_intent_id as string | null;

      // Insert decision (approved_fast_track)
      const { data: decisionRow } = await supabase
        .from("decisions")
        .insert({
          submission_id:   sub.id,
          host_id:         hostId,
          decision_reason: "approved_fast_track",
          review_notes:    "Auto-released after 48 hours without host decision.",
          approved_payout: approvedPayout,
        })
        .select("id")
        .single();

      // Capture the Stripe PaymentIntent
      let stripeStatus = "skipped";
      if (paymentIntentId) {
        try {
          const stripeRes = await supabase.functions.invoke("stripe-payment", {
            body: {
              action:             "capture",
              amount:             approvedPayout,
              platformFee:        platformFee(approvedPayout),
              paymentIntentId,
              connectedAccountId: connectedAccountId ?? null,
              submissionId:       sub.id,
              taskId:             task.id,
            },
          });
          stripeStatus = (stripeRes.data as Record<string, unknown>)?.status as string ?? "captured";
        } catch (stripeErr) {
          console.error("auto-release: stripe capture failed for task", task.id, stripeErr);
          stripeStatus = "error";
        }

        // Immutable ledger entry
        const fee = platformFee(approvedPayout);
        await supabase.from("payout_ledger").insert({
          task_id:            task.id,
          submission_id:      sub.id,
          project_id:         projectId,
          contributor_id:     contributorId,
          host_id:            hostId,
          payment_intent_id:  paymentIntentId,
          event:              "captured",
          gross_amount_cents: approvedPayout,
          platform_fee_cents: fee,
          net_amount_cents:   approvedPayout - fee,
          stripe_status:      stripeStatus,
          decision_id:        (decisionRow as Record<string, unknown>)?.id ?? null,
        }).then(({ error: e }) => {
          if (e) console.error("auto-release: payout_ledger insert failed", e.message);
        });
      }

      // Update task to paid
      await supabase
        .from("tasks")
        .update({ status: "paid", reviewed_at: new Date().toISOString() } as Record<string, unknown>)
        .eq("id", task.id);

      // Release locked funds atomically (moves locked → released)
      const { error: walletErr } = await supabase.rpc("release_wallet_lock", {
        p_project_id: projectId,
        p_amount:     approvedPayout,
      });
      if (walletErr) {
        console.error("auto-release: release_wallet_lock failed for task", task.id, walletErr.message);
      }

      // Audit log
      await supabase.from("audit_log").insert({
        actor_id: hostId,
        task_id:  task.id,
        action:   "auto_released",
        payload:  { submissionId: sub.id, approvedPayout, stripeStatus },
      });

      // Notify host and contributor
      await supabase.from("notifications").insert([
        { user_id: hostId,        type: "auto_released", task_id: task.id },
        { user_id: contributorId, type: "auto_released", task_id: task.id },
      ]);
    })
  );

  const released = results.filter(r => r.status === "fulfilled").length;
  const failed   = results.filter(r => r.status === "rejected").length;
  console.log(`auto-release: ${released} released, ${failed} failed`);

  return new Response(
    JSON.stringify({ warnings: warningTasks?.length ?? 0, released, failed }),
    { headers: { "Content-Type": "application/json" } }
  );
});
