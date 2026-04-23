import { test, expect } from "@playwright/test";
import {
  getServiceClient,
  makeProjectTasksPublic,
  getTaskById,
  getLatestSubmissionForTask,
} from "./helpers/supabaseService";
import {
  amountCentsFromPayoutMinMax,
  bindPaymentIntentToSubmission,
  getStripe,
} from "./helpers/stripePayment";

const hostEmail = process.env.E2E_HOST_EMAIL;
const hostPassword = process.env.E2E_HOST_PASSWORD;
const contEmail = process.env.E2E_CONTRIBUTOR_EMAIL;
const contPassword = process.env.E2E_CONTRIBUTOR_PASSWORD;
const supabaseStorageUrl = process.env.VITE_SUPABASE_STORAGE_URL;

const ready =
  hostEmail &&
  hostPassword &&
  contEmail &&
  contPassword &&
  process.env.SUPABASE_SERVICE_ROLE_KEY &&
  process.env.VITE_SUPABASE_URL;

test.beforeEach(() => {
  test.skip(!ready, "Set e2e/.env (see e2e/.env.example)");
});

test("forge → claim → R2 → bind PI → approve → Stripe succeeded", async ({ browser, baseURL }) => {
  test.setTimeout(360_000);
  if (!ready || !baseURL) return;

  const supabase = getServiceClient();
  const suffix = Date.now();

  // -------- Host: create, SCOPE, publish --------
  const hostCtx = await browser.newContext();
  const pHost = await hostCtx.newPage();
  await pHost.goto("/login");
  await pHost.getByTestId("e2e-email").fill(hostEmail!);
  await pHost.getByTestId("e2e-password").fill(hostPassword!);
  await pHost.getByTestId("e2e-signin-btn").click();
  await pHost.waitForURL(/\/reviews$/, { timeout: 60_000 });
  await pHost.goto("/create");
  await pHost.locator("#project-title").fill(`E2E Forge ${suffix}`);
  await pHost.locator("#project-type").selectOption("code");
  await pHost.locator("#budget-min").fill("10");
  await pHost.locator("#budget-max").fill("50");
  await pHost
    .locator("#project-description")
    .fill("E2E: one deliverable file. Minimal scope for smoke testing.");
  await pHost.locator("#scope-btn").click();
  await pHost.waitForSelector("#publish-btn:visible", { timeout: 240_000 });
  await pHost.locator("#publish-btn").click();
  await pHost.waitForURL(/\/project\/[0-9a-f-]+/i, { timeout: 120_000 });
  const projectId = pHost.url().split("/project/")[1]?.split(/[?#]/)[0] ?? "";
  expect(projectId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  );
  const { data: hostTasks, error: taskErr } = await supabase
    .from("tasks")
    .select("id, payout_min, payout_max")
    .eq("project_id", projectId);
  expect(taskErr, String(taskErr)).toBeNull();
  const task = (hostTasks ?? [])[0] as
    | { id: string; payout_min: number; payout_max: number }
    | undefined;
  expect(task, "task row after publish").toBeTruthy();
  const taskId = task!.id;
  await makeProjectTasksPublic(supabase, projectId);
  await hostCtx.close();

  // -------- Contributor: claim, upload, submit --------
  const contCtx = await browser.newContext();
  const pC = await contCtx.newPage();
  await pC.goto("/login");
  await pC.getByTestId("e2e-email").fill(contEmail!);
  await pC.getByTestId("e2e-password").fill(contPassword!);
  await pC.getByTestId("e2e-signin-btn").click();
  await pC.waitForURL(/\/reviews$/, { timeout: 60_000 });
  await pC.goto("/tasks");
  await pC.locator(".claim-btn").first().click();
  await pC.goto(`/submit/${taskId}`);
  const fileBuffer = Buffer.from(
    "e2e deliverable\n" + new Date().toISOString() + "\n",
    "utf8"
  );
  await pC.setInputFiles("#file-input", {
    name: "e2e-smoke.txt",
    mimeType: "text/plain",
    buffer: fileBuffer,
  });
  await pC.getByRole("button", { name: /submit deliverable/i }).click();
  await pC.locator("#submit-success").waitFor({ state: "visible", timeout: 300_000 });
  let submission = await (async function waitForSub() {
    for (let i = 0; i < 60; i++) {
      const s = await getLatestSubmissionForTask(supabase, taskId);
      if (s?.asset_url) return s;
      await new Promise((r) => setTimeout(r, 2000));
    }
    return null;
  })();
  expect(submission?.asset_url).toBeTruthy();
  const assetUrl = submission!.asset_url;
  if (supabaseStorageUrl) {
    const host = new URL(supabaseStorageUrl).hostname;
    expect(assetUrl, "asset on Supabase Storage public base").toContain(host);
  }
  const head = await fetch(assetUrl, { method: "HEAD" });
  expect(head.ok, `Supabase Storage object HEAD ${head.status}`).toBe(true);

  const trow = await getTaskById(supabase, taskId);
  expect(trow).toBeTruthy();
  const amountCents = amountCentsFromPayoutMinMax(
    trow!.payout_min,
    trow!.payout_max
  );
  const { paymentIntentId } = await bindPaymentIntentToSubmission({
    amountCents,
    taskId,
    submissionId: submission!.id,
    hostStripeConnectAccountId: process.env.E2E_HOST_STRIPE_CONNECT_ACCOUNT,
  });
  expect(paymentIntentId).toMatch(/^pi_/);
  await contCtx.close();

  // -------- Host: approve (capture) --------
  const h2 = await browser.newContext();
  const p2 = await h2.newPage();
  p2.on("dialog", (d) => d.accept().catch(() => {}));
  await p2.goto("/login");
  await p2.getByTestId("e2e-email").fill(hostEmail!);
  await p2.getByTestId("e2e-password").fill(hostPassword!);
  await p2.getByTestId("e2e-signin-btn").click();
  await p2.waitForURL(/\/reviews$/, { timeout: 60_000 });
  await p2.goto("/reviews");
  await p2.getByRole("button", { name: "START_REVIEW" }).first().click({ timeout: 120_000 });
  await p2.locator("#decision-reason").selectOption("great_work");
  await p2.getByRole("button", { name: /approve.*pay/i }).click();
  await p2.waitForTimeout(5000);

  const final = await getLatestSubmissionForTask(supabase, taskId);
  expect(final?.payment_intent_id, "PI id on submission after bind").toBeTruthy();

  const stripe = await getStripe();
  if (stripe && final?.payment_intent_id) {
    const pi = await stripe.paymentIntents.retrieve(final.payment_intent_id);
    expect(
      pi.status,
      "Dashboard/API: manual capture should leave PI succeeded in test mode"
    ).toBe("succeeded");
  } else {
    // eslint-disable-next-line no-console
    console.warn(
      "[e2e] Set STRIPE_SECRET_KEY in e2e/.env to assert capture in Stripe API"
    );
  }
  await h2.close();
});
