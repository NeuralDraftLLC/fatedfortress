/**
 * tests/smoke/run.ts
 *
 * Fated Fortress smoke test runner.
 * Runs 5 critical flow tests against a live Supabase + Stripe test-mode project.
 *
 * Usage:
 *   deno run --allow-net --allow-env --allow-read tests/smoke/run.ts
 *   npx tsx tests/smoke/run.ts
 */

import { config } from "./lib/config.ts";
import { createAdminClient } from "./lib/supabase.ts";
import { log, summary } from "./lib/reporter.ts";
import { teardownAll } from "./lib/teardown.ts";

import { testWalletDepositAtomic } from "./tests/01_wallet_deposit_atomic.ts";
import { testClaimTaskRace } from "./tests/02_claim_task_race.ts";
import { testClaimToCapture } from "./tests/03_claim_to_capture.ts";
import { testAutoReleaseTrigger } from "./tests/04_auto_release_trigger.ts";
import { testExpireClaimsTrigger } from "./tests/05_expire_claims_trigger.ts";

const TESTS = [
  { name: "wallet_deposit_atomic",  fn: testWalletDepositAtomic },
  { name: "claim_task_race",        fn: testClaimTaskRace },
  { name: "claim_to_capture",       fn: testClaimToCapture },
  { name: "auto_release_trigger",   fn: testAutoReleaseTrigger },
  { name: "expire_claims_trigger",  fn: testExpireClaimsTrigger },
];

async function main() {
  log.header("Fated Fortress Smoke Tests");
  log.info(`Target: ${config.supabaseUrl}`);
  log.info(`Stripe:  test mode (${config.stripeKey.slice(0, 12)}...)`);
  console.log("");

  const admin = createAdminClient();
  const results: { name: string; passed: boolean; error?: string }[] = [];

  for (const test of TESTS) {
    log.running(test.name);
    try {
      await test.fn(admin);
      results.push({ name: test.name, passed: true });
      log.pass(test.name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ name: test.name, passed: false, error: msg });
      log.fail(test.name, msg);
    } finally {
      // Best-effort cleanup after every test
      await teardownAll(admin).catch(() => {});
    }
    console.log("");
  }

  summary(results);

  const allPassed = results.every(r => r.passed);
  if (typeof Deno !== "undefined") {
    Deno.exit(allPassed ? 0 : 1);
  } else {
    process.exit(allPassed ? 0 : 1);
  }
}

main();
