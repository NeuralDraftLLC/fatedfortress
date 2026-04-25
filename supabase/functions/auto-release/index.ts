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
 *
 * Webhook dispatch:
 *   After inserting notifications, if the host has notification_trigger_url set and
 *   notification_trigger_enabled = true, we POST the notification payload to that URL.
 *   Webhook failures are logged but never throw — they must not block the release path.
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

/**
 * Fire a webhook to a host's configured notification_trigger_url.
 * Never throws — failures are console.error only so they never interrupt the release path.
 */
async function dispatchWebhook(
  hostId: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    const { data: hostProfile } = await supabase
      .from("profiles")
      .select("notification_trigger_url, notification_trigger_enabled")
      .eq("id", hostId)
      .single();

    const profile = hostProfile as Record<string, unknown> | null;
    if (!profile?.notification_trigger_enabled || !profile?.notification_trigger_url) return;

    const url = profile.notification_trigger_url as string;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      // Abort after 5 seconds — never let a slow webhook stall the cron
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      console.error(`auto-release: webhook POST to ${url} failed with status ${res.status}`);
    }
  } catch (err) {
    console.error("auto-release: dispatchWebhook error", err);
  }
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
  const releaseCutoff = warningUpperBound;

  // ── 24h: auto_release_warning ───────────────────────────────────────────
  const { data: warningTasks } = await supabase
    .from("tasks")
    .select("id, title, submitted_at, project:projects(host_id)")
    .eq("status", "under_review")
    .lt("submitted_at", warningCutoff)
    .gte("submitted_at", warningUpperBound);

  if (warningTasks && warningTasks.length > 0) {
    const warnings = warningTasks.map(t => ({
      user_id: (t.project as Record<string, unknown>)?.host_id as string,
      type: "auto_release_warning",
      task_id: t.id,
    }));

    await supabase.from("notifications").insert(warnings);
    console.log(`auto-release: sent ${warnings.length} 24h warnings`);

    // Dispatch webhooks for warning notifications
    await Promise.allSettled(
      warningTasks.map(t => {
        const hostId = (t.project as Record<string, unknown>)?.host_id as string;
        if (!hostId) return Promise.resolve();
        return dispatchWebhook(hostId, {
          event: "auto_release_warning",
          task_id: t.id,
          task_title: t.title,
          hours_remaining: RELEASE_HOURS - WARNING_HOURS,
          timestamp: now.toISOString(),
        });
      })
    );
  }

  // ── 48h: auto_released ─────────────────────────────────────────────────
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
      const approvedPayout = Number(task.approved_payout ?? task.payout_max ?? 0);

      if (approvedPayout <= 0) {
        console.warn(`auto-release: task ${task.id} has no payout amount — skipping`);
        return;
      }

      const { data: hostProfile } = await supabase
        .from("profiles")
        .select("stripe_account_id")
        .eq("id", hostId)
        .single();

      const connectedAccountId = (hostProfile as Record<string, unknown>)?.stripe_account_id as string | null;

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

      await supabase
        .from("tasks")
        .update({ status: "paid", reviewed_at: new Date().toISOString() } as Record<string, unknown>)
        .eq("id", task.id);

      const { error: walletErr } = await supabase.rpc("release_wallet_lock", {
        p_project_id: projectId,
        p_amount:     approvedPayout,
      });
      if (walletErr) {
        console.error("auto-release: release_wallet_lock failed for task", task.id, walletErr.message);
      }

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

      // Dispatch webhooks for release notifications
      await dispatchWebhook(hostId, {
        event: "auto_released",
        task_id: task.id,
        task_title: task.title,
        approved_payout: approvedPayout,
        contributor_id: contributorId,
        timestamp: now.toISOString(),
      });
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
