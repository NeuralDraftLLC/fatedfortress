/**
 * Test 05: expire_claims_trigger
 *
 * Proves expire-claims returns a claimed task to 'open' when the lock window has passed.
 * Strategy: seed a task in status=claimed with soft_lock_expires_at in the past.
 * Trigger expire-claims. Assert task→open, wallet.locked decremented.
 */

import type { SupabaseAdminClient } from "../lib/supabase.ts";
import { log } from "../lib/reporter.ts";
import { config } from "../lib/config.ts";
import { seedProject, seedTask } from "../lib/seed.ts";
import { teardownAll } from "../lib/teardown.ts";

const PAST = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
const PAYOUT = 20_00;

export async function testExpireClaimsTrigger(admin: SupabaseAdminClient): Promise<void> {
  const { projectId } = await seedProject(admin, 200_00);

  // Seed task in 'claimed' state with expired soft lock
  const { taskId } = await seedTask(admin, projectId, {
    payout_max:           PAYOUT,
    status:               "claimed",
    claimed_by:           config.testContributorId,
    claimed_at:           PAST,
    soft_lock_expires_at: PAST,       // already expired
    payment_intent_id:    "pi_smoke_expire_test",
  });

  // Simulate the wallet lock that was set when the task was claimed
  await admin.rpc("lock_wallet_funds", { p_project_id: projectId, p_amount: PAYOUT })
    .then(({ error }) => { if (error) throw new Error(`lock_wallet_funds: ${error.message}`); });

  log.detail(`Task seeded in claimed state, lock expired at ${PAST}`);

  try {
    // Trigger expire-claims
    const { error: fnErr } = await admin.functions.invoke("expire-claims", {
      headers: { Authorization: `Bearer ${config.serviceRoleKey}` },
    });
    if (fnErr) throw new Error(`expire-claims invoke: ${fnErr.message}`);
    log.detail(`expire-claims invoked ✓`);

    // ── Assertions ─────────────────────────────────────────────────────────
    const { data: task } = await admin
      .from("tasks")
      .select("status, claimed_by, payment_intent_id")
      .eq("id", taskId)
      .single();

    const t = task as { status: string; claimed_by: string | null; payment_intent_id: string | null };
    if (t.status !== "open") {
      throw new Error(`task.status='${t.status}' expected 'open'`);
    }
    if (t.claimed_by !== null) {
      throw new Error(`task.claimed_by='${t.claimed_by}' expected null`);
    }

    const { data: wallet } = await admin
      .from("project_wallet")
      .select("locked")
      .eq("project_id", projectId)
      .single();
    const locked = (wallet as { locked: number })?.locked ?? -1;
    if (locked !== 0) {
      throw new Error(`wallet.locked=${locked} expected 0 — lock not released on expiry`);
    }

    log.detail(`task=open  claimed_by=null  wallet.locked=0 ✓`);
  } finally {
    await teardownAll(admin);
  }
}
