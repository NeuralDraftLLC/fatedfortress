/**
 * Test 01: wallet_deposit_atomic
 *
 * Fires two concurrent upsert_wallet_deposited RPCs against the same project.
 * Both must succeed and the final deposited balance must equal the sum of both.
 * Proves the atomic upsert prevents lost-update race conditions.
 */

import { config } from "../lib/config.ts";
import type { SupabaseAdminClient } from "../lib/supabase.ts";
import { log } from "../lib/reporter.ts";
import { teardownAll } from "../lib/teardown.ts";
import { SMOKE_TAG } from "../lib/seed.ts";

const DEPOSIT_A = 50_00; // $50.00
const DEPOSIT_B = 30_00; // $30.00
const EXPECTED  = DEPOSIT_A + DEPOSIT_B; // $80.00

export async function testWalletDepositAtomic(admin: SupabaseAdminClient): Promise<void> {
  // Seed a project with NO initial wallet
  const { data: project, error: pErr } = await admin
    .from("projects")
    .insert({
      host_id:     config.testHostId,
      title:       `${SMOKE_TAG} Wallet Race ${Date.now()}`,
      description: "Smoke test",
      status:      "active",
    })
    .select("id")
    .single();

  if (pErr || !project) throw new Error(`Seed project: ${pErr?.message}`);

  const projectId = (project as { id: string }).id;
  log.detail(`Project seeded: ${projectId}`);

  try {
    // Fire both deposits concurrently
    const [resA, resB] = await Promise.all([
      admin.rpc("upsert_wallet_deposited", { p_project_id: projectId, p_amount: DEPOSIT_A }),
      admin.rpc("upsert_wallet_deposited", { p_project_id: projectId, p_amount: DEPOSIT_B }),
    ]);

    if (resA.error) throw new Error(`Deposit A failed: ${resA.error.message}`);
    if (resB.error) throw new Error(`Deposit B failed: ${resB.error.message}`);

    log.detail(`Both deposits completed`);

    // Read final wallet state
    const { data: wallet, error: wErr } = await admin
      .from("project_wallet")
      .select("deposited, locked, released")
      .eq("project_id", projectId)
      .single();

    if (wErr || !wallet) throw new Error(`Wallet read failed: ${wErr?.message}`);

    const w = wallet as { deposited: number; locked: number; released: number };
    log.detail(`deposited=${w.deposited}  locked=${w.locked}  released=${w.released}`);

    if (w.deposited !== EXPECTED) {
      throw new Error(
        `deposited=${w.deposited} expected=${EXPECTED} — race condition detected!`
      );
    }
  } finally {
    await teardownAll(admin);
  }
}
