/**
 * Test 02: claim_task_race
 *
 * Fires two concurrent claim_task_atomic RPC calls against the same open task.
 * Exactly one must return 'ok'; the other must return 'already_claimed'.
 * Proves the SELECT FOR UPDATE SKIP LOCKED prevents double-claim.
 */

import type { SupabaseAdminClient } from "../lib/supabase.ts";
import { log } from "../lib/reporter.ts";
import { seedProject, seedTask } from "../lib/seed.ts";
import { teardownAll } from "../lib/teardown.ts";
import { config } from "../lib/config.ts";

export async function testClaimTaskRace(admin: SupabaseAdminClient): Promise<void> {
  const { projectId } = await seedProject(admin, 200_00);
  const { taskId }    = await seedTask(admin, projectId, { payout_max: 20_00 });
  log.detail(`Task seeded: ${taskId}`);

  try {
    // Two concurrent claims — use fake PI IDs (we're testing the DB lock, not Stripe)
    const [resA, resB] = await Promise.all([
      admin.rpc("claim_task_atomic", {
        p_task_id:              taskId,
        p_contributor_id:       config.testContributorId,
        p_payment_intent_id:    "pi_smoke_race_A",
        p_claim_duration_hours: 48,
      }),
      admin.rpc("claim_task_atomic", {
        p_task_id:              taskId,
        p_contributor_id:       config.testContributorId,
        p_payment_intent_id:    "pi_smoke_race_B",
        p_claim_duration_hours: 48,
      }),
    ]);

    const codeA = resA.data as string;
    const codeB = resB.data as string;
    log.detail(`Claim A: ${codeA}  |  Claim B: ${codeB}`);

    if (resA.error) throw new Error(`Claim A RPC error: ${resA.error.message}`);
    if (resB.error) throw new Error(`Claim B RPC error: ${resB.error.message}`);

    const codes = [codeA, codeB].sort();
    // Expect exactly one 'ok' and one 'already_claimed'
    if (!(codes.includes("ok") && codes.includes("already_claimed"))) {
      throw new Error(
        `Expected one 'ok' and one 'already_claimed', got: ${codeA}, ${codeB}`
      );
    }

    // Verify task is claimed once
    const { data: task } = await admin
      .from("tasks")
      .select("status, claimed_by")
      .eq("id", taskId)
      .single();

    if ((task as { status: string })?.status !== "claimed") {
      throw new Error(`Task status is '${(task as { status: string })?.status}', expected 'claimed'`);
    }

    // Verify wallet locked = payout_max (only one lock applied)
    const { data: wallet } = await admin
      .from("project_wallet")
      .select("locked")
      .eq("project_id", projectId)
      .single();

    const locked = (wallet as { locked: number })?.locked ?? 0;
    if (locked !== 20_00) {
      throw new Error(`Wallet locked=${locked}, expected 2000 — double-lock detected!`);
    }

    log.detail(`Task status=claimed  wallet.locked=${locked} ✓`);
  } finally {
    await teardownAll(admin);
  }
}
