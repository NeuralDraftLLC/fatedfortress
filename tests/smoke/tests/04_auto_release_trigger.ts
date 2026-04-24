/**
 * Test 04: auto_release_trigger
 *
 * Proves the auto-release edge function correctly releases tasks older than 48h.
 * Strategy: seed a task in status=under_review with submitted_at backdated 50h.
 * Trigger the function directly. Assert task→paid, wallet locked→released,
 * decision row inserted with reason=approved_fast_track.
 *
 * Note: uses a real Stripe PI so the capture leg actually fires.
 */

import type { SupabaseAdminClient } from "../lib/supabase.ts";
import { log } from "../lib/reporter.ts";
import { seedProject, seedTask, seedSubmission } from "../lib/seed.ts";
import { teardownAll } from "../lib/teardown.ts";
import { config } from "../lib/config.ts";
import { createTestPaymentIntent, cancelPaymentIntent } from "../lib/stripe.ts";

const HOURS_50_AGO = new Date(Date.now() - 50 * 60 * 60 * 1000).toISOString();
const PAYOUT = 15_00;

export async function testAutoReleaseTrigger(admin: SupabaseAdminClient): Promise<void> {
  const { projectId } = await seedProject(admin, 200_00);

  // Seed task already in under_review with old submitted_at
  const { taskId } = await seedTask(admin, projectId, {
    payout_max:   PAYOUT,
    status:       "under_review",
    submitted_at: HOURS_50_AGO,
  });

  // Lock the wallet to simulate a prior claim
  await admin.rpc("lock_wallet_funds", { p_project_id: projectId, p_amount: PAYOUT })
    .then(({ error }) => { if (error) throw new Error(`lock_wallet_funds: ${error.message}`); });

  // Create a real PI so auto-release can capture it
  const pi = await createTestPaymentIntent(PAYOUT);
  log.detail(`PI created: ${pi.id}`);

  let piUsed = false;

  try {
    // Seed submission with PI
    const { submissionId } = await seedSubmission(
      admin, taskId, config.testContributorId, pi.id
    );
    log.detail(`Task: ${taskId}  submitted_at: ${HOURS_50_AGO}`);

    // Trigger auto-release directly
    const { error: fnErr } = await admin.functions.invoke("auto-release", {
      headers: { Authorization: `Bearer ${config.serviceRoleKey}` },
    });
    if (fnErr) throw new Error(`auto-release invoke: ${fnErr.message}`);
    piUsed = true;
    log.detail(`auto-release invoked ✓`);

    // ── Assertions ─────────────────────────────────────────────────────────
    const { data: task } = await admin
      .from("tasks")
      .select("status")
      .eq("id", taskId)
      .single();
    if ((task as { status: string })?.status !== "paid") {
      throw new Error(`task.status='${(task as { status: string })?.status}' expected 'paid'`);
    }

    const { data: wallet } = await admin
      .from("project_wallet")
      .select("locked, released")
      .eq("project_id", projectId)
      .single();
    const w = wallet as { locked: number; released: number };
    if (w.locked !== 0) throw new Error(`wallet.locked=${w.locked} expected 0`);

    const { data: decision } = await admin
      .from("decisions")
      .select("decision_reason")
      .eq("submission_id", submissionId)
      .single();
    if ((decision as { decision_reason: string })?.decision_reason !== "approved_fast_track") {
      throw new Error(`decision_reason='${(decision as { decision_reason: string })?.decision_reason}'`);
    }

    log.detail(`task=paid  wallet.locked=0  decision=approved_fast_track ✓`);
  } finally {
    if (!piUsed) await cancelPaymentIntent(pi.id);
    await teardownAll(admin);
  }
}
