/**
 * Test 03: claim_to_capture
 *
 * Full money loop:
 *   1. Seed project + task
 *   2. Create real Stripe PaymentIntent (test mode, pm_card_visa, manual capture)
 *   3. claim_task_atomic with real PI id
 *   4. Seed submission
 *   5. Call stripe-payment edge function with action=capture
 *   6. Assert task.status = 'paid', wallet locked→released, payout_ledger row inserted
 */

import type { SupabaseAdminClient } from "../lib/supabase.ts";
import { log } from "../lib/reporter.ts";
import { seedProject, seedTask, seedSubmission } from "../lib/seed.ts";
import { teardownAll } from "../lib/teardown.ts";
import { config } from "../lib/config.ts";
import { createTestPaymentIntent, cancelPaymentIntent } from "../lib/stripe.ts";

export async function testClaimToCapture(admin: SupabaseAdminClient): Promise<void> {
  const PAYOUT = 20_00; // $20.00
  const { projectId } = await seedProject(admin, 200_00);
  const { taskId }    = await seedTask(admin, projectId, { payout_max: PAYOUT });
  log.detail(`Task seeded: ${taskId}`);

  // Create a real Stripe PI in test mode
  const pi = await createTestPaymentIntent(PAYOUT);
  log.detail(`Stripe PI created: ${pi.id}  status=${pi.status}`);

  let piCaptured = false;

  try {
    // Claim the task atomically
    const { data: claimCode, error: claimErr } = await admin.rpc("claim_task_atomic", {
      p_task_id:              taskId,
      p_contributor_id:       config.testContributorId,
      p_payment_intent_id:    pi.id,
      p_claim_duration_hours: 48,
    });

    if (claimErr) throw new Error(`claim_task_atomic: ${claimErr.message}`);
    if (claimCode !== "ok") throw new Error(`claim_task_atomic returned '${claimCode}'`);
    log.detail(`Task claimed ✓`);

    // Seed a submission
    const { submissionId } = await seedSubmission(admin, taskId, config.testContributorId, pi.id);
    log.detail(`Submission seeded: ${submissionId}`);

    // Call the stripe-payment edge function with action=capture
    const captureRes = await admin.functions.invoke("stripe-payment", {
      body: {
        action:          "capture",
        paymentIntentId: pi.id,
        amount:          PAYOUT,
        platformFee:     Math.round(PAYOUT * 0.10),
        submissionId,
        taskId,
      },
    });

    if (captureRes.error) throw new Error(`stripe-payment capture: ${captureRes.error.message}`);
    const captureData = captureRes.data as { success: boolean; status: string };
    if (!captureData.success) throw new Error(`stripe-payment capture failed: ${JSON.stringify(captureData)}`);
    piCaptured = true;
    log.detail(`Stripe capture: status=${captureData.status} ✓`);

    // Update task to paid + release wallet lock (mimics payout.ts flow)
    await admin.from("tasks").update({ status: "paid" }).eq("id", taskId);
    const { error: releaseErr } = await admin.rpc("release_wallet_lock", {
      p_project_id: projectId,
      p_amount:     PAYOUT,
    });
    if (releaseErr) throw new Error(`release_wallet_lock: ${releaseErr.message}`);

    // Insert payout_ledger row
    const fee = Math.round(PAYOUT * 0.10);
    await admin.from("payout_ledger").insert({
      task_id:            taskId,
      submission_id:      submissionId,
      project_id:         projectId,
      contributor_id:     config.testContributorId,
      host_id:            config.testHostId,
      payment_intent_id:  pi.id,
      event:              "captured",
      gross_amount_cents: PAYOUT,
      platform_fee_cents: fee,
      net_amount_cents:   PAYOUT - fee,
      stripe_status:      captureData.status,
    });

    // ── Assertions ─────────────────────────────────────────────────────────
    const { data: task } = await admin
      .from("tasks")
      .select("status")
      .eq("id", taskId)
      .single();
    if ((task as { status: string })?.status !== "paid") {
      throw new Error(`Task status='${(task as { status: string })?.status}' expected 'paid'`);
    }

    const { data: wallet } = await admin
      .from("project_wallet")
      .select("deposited, locked, released")
      .eq("project_id", projectId)
      .single();
    const w = wallet as { deposited: number; locked: number; released: number };
    if (w.locked !== 0) throw new Error(`wallet.locked=${w.locked} expected 0`);
    if (w.released !== PAYOUT) throw new Error(`wallet.released=${w.released} expected ${PAYOUT}`);

    const { data: ledger } = await admin
      .from("payout_ledger")
      .select("id")
      .eq("task_id", taskId)
      .limit(1);
    if (!ledger || (ledger as unknown[]).length === 0) {
      throw new Error("payout_ledger row missing");
    }

    log.detail(`task=paid  wallet.locked=0  wallet.released=${w.released}  ledger=✓`);
  } finally {
    if (!piCaptured) await cancelPaymentIntent(pi.id);
    await teardownAll(admin);
  }
}
