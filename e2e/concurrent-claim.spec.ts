/**
 * E2E: concurrent-claim.spec.ts
 *
 * Pillar 1: Two-browser concurrent claim race test.
 *
 * Flow:
 *   1. Host creates a project with one open task
 *   2. Two contributor browsers hit CLAIM on the same task simultaneously
 *   3. One must succeed (task claimed); the other must see a 409/already_claimed error
 *   4. Task must have version >= 2 in DB (incremented on successful claim)
 *   5. Wallet must have exactly payout_max locked — no double-lock
 */

import { test, expect, type Browser } from "@playwright/test";
import { getServiceClient } from "./helpers/supabaseService";

const hostEmail    = process.env.E2E_HOST_EMAIL!;
const hostPassword = process.env.E2E_HOST_PASSWORD!;
const contAEmail  = process.env.E2E_CONTRIBUTOR_EMAIL!;
const contAPassword = process.env.E2E_CONTRIBUTOR_PASSWORD!;
const contBEmail  = process.env.E2E_CONTRIBUTOR_EMAIL_2 ?? process.env.E2E_CONTRIBUTOR_EMAIL!;
const contBPassword = process.env.E2E_CONTRIBUTOR_PASSWORD_2 ?? process.env.E2E_CONTRIBUTOR_PASSWORD!;

const ready = !!(hostEmail && hostPassword && contAEmail && contAPassword && contBEmail && contBPassword);

test.beforeEach(() => { test.skip(!ready, "Set E2E_{HOST,CONTRIBUTOR}* in e2e/.env"); });

test("concurrent claim — exactly one winner, version incremented, no double-lock", async ({ browser }) => {
  const admin = getServiceClient();
  const suffix = Date.now();

  // ── Host: create + publish a project with one open task ─────────────────
  const hostCtx = await browser.newContext();
  const pHost = await hostCtx.newPage();
  await pHost.goto("/login");
  await pHost.getByTestId("e2e-email").fill(hostEmail);
  await pHost.getByTestId("e2e-password").fill(hostPassword);
  await pHost.getByTestId("e2e-signin-btn").click();
  await pHost.waitForURL(/\/(reviews|tasks)$/, { timeout: 60_000 });

  await pHost.goto("/create");
  await pHost.locator("#project-title").fill(`Race test ${suffix}`);
  await pHost.locator("#project-type").selectOption("code");
  await pHost.locator("#budget-min").fill("10");
  await pHost.locator("#budget-max").fill("50");
  await pHost.locator("#project-description").fill("One task: write hello.txt");
  await pHost.locator("#scope-btn").click();
  await pHost.waitForSelector("#publish-btn:visible", { timeout: 240_000 });
  await pHost.locator("#publish-btn").click();
  await pHost.waitForURL(/\/project\/[0-9a-f-]+/i, { timeout: 120_000 });

  const projectId = pHost.url().split("/project/")[1]?.split(/[?#]/)[0] ?? "";
  expect(projectId).toMatch(/^[0-9a-f-]{36}$/i);

  // Make task public so contributors can see it
  const { data: tasks } = await admin
    .from("tasks")
    .select("id, payout_max, version")
    .eq("project_id", projectId)
    .single();
  const task = tasks as { id: string; payout_max: number; version: number } | null;
  expect(task, "task seeded").toBeTruthy();
  const taskId = task!.id;
  const payoutMax = task!.payout_max;
  await admin.from("tasks").update({ task_access: "public" } as Record<string, unknown>).eq("id", taskId);

  // Record initial version
  const initialVersion = task!.version ?? 1;

  // Record initial wallet locked amount
  const { data: walletBefore } = await admin
    .from("project_wallet")
    .select("locked")
    .eq("project_id", projectId)
    .single();
  const lockedBefore = (walletBefore as { locked: number } | null)?.locked ?? 0;

  await hostCtx.close();

  // ── Contributor A + B both open /tasks simultaneously ──────────────────
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pA = await ctxA.newPage();
  const pB = await ctxB.newPage();

  // Both log in
  await pA.goto("/login");
  await pA.getByTestId("e2e-email").fill(contAEmail);
  await pA.getByTestId("e2e-password").fill(contAPassword);
  await pA.getByTestId("e2e-signin-btn").click();
  await pA.waitForURL(/\/(reviews|tasks)$/, { timeout: 60_000 });

  await pB.goto("/login");
  await pB.getByTestId("e2e-email").fill(contBEmail);
  await pB.getByTestId("e2e-password").fill(contBPassword);
  await pB.getByTestId("e2e-signin-btn").click();
  await pB.waitForURL(/\/(reviews|tasks)$/, { timeout: 60_000 });

  // Both navigate to /tasks
  await Promise.all([pA.goto("/tasks"), pB.goto("/tasks")]);
  await Promise.all([
    pA.waitForSelector(`[data-task-id="${taskId}"][data-action="claim"]`, { timeout: 30_000 }),
    pB.waitForSelector(`[data-task-id="${taskId}"][data-action="claim"]`, { timeout: 30_000 }),
  ]);

  // Click both claim buttons simultaneously (within same JS event loop tick)
  await Promise.all([
    pA.click(`[data-task-id="${taskId}"][data-action="claim"]`),
    pB.click(`[data-task-id="${taskId}"][data-action="claim"]`),
  ]);

  // Wait up to 60s for at least one to resolve
  const settle = async (page: typeof pA) => {
    for (let i = 0; i < 120; i++) {
      const url = page.url();
      if (url.includes("/submit/")) return "success";
      const dialogOrError = await page.evaluate(() => {
        const btn = document.querySelector(`[data-task-id="${taskId}"][data-action="claim"]`);
        if (!btn) return "no-button";
        const hasClaiming = btn.getAttribute("data-claiming") !== null;
        const opacity = window.getComputedStyle(btn).opacity;
        return hasClaiming || parseFloat(opacity) < 1 ? "claiming" : "idle";
      });
      if (dialogOrError === "success") return "success";
      if (dialogOrError === "no-button") return "already-gone";
      await new Promise((r) => setTimeout(r, 500));
    }
    return "timeout";
  };

  const [resultA, resultB] = await Promise.all([settle(pA), settle(pB)]);
  const winner = resultA === "success" ? "A" : resultB === "success" ? "B" : "neither";

  // ── Assertions ────────────────────────────────────────────────────────────
  // Exactly one winner
  expect(winner, `A=${resultA} B=${resultB} — expected exactly one success`).not.toBe("neither");

  // The winner should be on /submit/:taskId
  if (winner === "A") {
    expect(pA.url()).toContain("/submit/");
  } else {
    expect(pB.url()).toContain("/submit/");
  }

  // The loser should NOT be on /submit (should see 409 or stay on /tasks)
  if (winner === "A") {
    expect(pB.url()).not.toContain("/submit/");
  } else {
    expect(pA.url()).not.toContain("/submit/");
  }

  // DB: task is claimed
  const { data: taskAfter } = await admin
    .from("tasks")
    .select("status, claimed_by, version")
    .eq("id", taskId)
    .single();
  const after = taskAfter as { status: string; claimed_by: string | null; version: number } | null;
  expect(after?.status).toBe("claimed");
  expect(after?.claimed_by).not.toBeNull();
  expect(after?.version).toBeGreaterThanOrEqual(initialVersion + 1);

  // DB: wallet locked exactly once
  const { data: walletAfter } = await admin
    .from("project_wallet")
    .select("locked")
    .eq("project_id", projectId)
    .single();
  const lockedAfter = (walletAfter as { locked: number } | null)?.locked ?? 0;
  expect(lockedAfter - lockedBefore).toBe(payoutMax);

  await ctxA.close();
  await ctxB.close();
});
