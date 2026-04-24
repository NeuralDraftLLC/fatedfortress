/**
 * tests/smoke/lib/reporter.ts
 * Simple coloured console reporter.
 */

const RESET  = "\x1b[0m";
const GREEN  = "\x1b[32m";
const RED    = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN   = "\x1b[36m";
const BOLD   = "\x1b[1m";

export const log = {
  header: (msg: string) =>
    console.log(`${BOLD}${CYAN}\n═══════════════════════════════════\n  ${msg}\n═══════════════════════════════════${RESET}`),
  info:    (msg: string) => console.log(`  ${CYAN}ℹ${RESET}  ${msg}`),
  running: (name: string) => console.log(`  ${YELLOW}⏳${RESET} ${BOLD}${name}${RESET}`),
  pass:    (name: string) => console.log(`  ${GREEN}✔${RESET}  ${name}`),
  fail:    (name: string, err: string) => {
    console.log(`  ${RED}✘${RESET}  ${name}`);
    console.log(`     ${RED}${err}${RESET}`);
  },
  detail:  (msg: string) => console.log(`     ${msg}`),
};

export function summary(results: { name: string; passed: boolean; error?: string }[]) {
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`${BOLD}\n─────────────────────────────────────${RESET}`);
  console.log(`  Results: ${GREEN}${passed} passed${RESET}  ${failed > 0 ? RED : ""}${failed} failed${RESET}  / ${results.length} total`);
  if (failed > 0) {
    console.log(`\n  ${RED}Failed tests:${RESET}`);
    results.filter(r => !r.passed).forEach(r =>
      console.log(`    ${RED}✘${RESET} ${r.name}: ${r.error}`)
    );
  }
  console.log("");
}
