/**
 * tests/smoke/lib/seed.ts
 * Helpers to insert and track smoke-test rows for teardown.
 */

import { config } from "./config.ts";
import type { SupabaseAdminClient } from "./supabase.ts";

export const SMOKE_TAG = "[SMOKE]";

/** Seed a project + wallet, return { projectId }. */
export async function seedProject(
  admin: SupabaseAdminClient,
  depositCents: number = 100_00  // $100.00
): Promise<{ projectId: string }> {
  const { data: project, error: pErr } = await admin
    .from("projects")
    .insert({
      host_id:     config.testHostId,
      title:       `${SMOKE_TAG} Project ${Date.now()}`,
      description: "Smoke test project — safe to delete",
      status:      "active",
    })
    .select("id")
    .single();

  if (pErr || !project) throw new Error(`seedProject: ${pErr?.message}`);

  // Atomic wallet deposit via RPC
  const { error: wErr } = await admin.rpc("upsert_wallet_deposited", {
    p_project_id: project.id,
    p_amount:     depositCents,
  });
  if (wErr) throw new Error(`seedProject wallet: ${wErr.message}`);

  return { projectId: project.id };
}

/** Seed a single open task, return { taskId }. */
export async function seedTask(
  admin: SupabaseAdminClient,
  projectId: string,
  overrides: Record<string, unknown> = {}
): Promise<{ taskId: string }> {
  const { data: task, error } = await admin
    .from("tasks")
    .insert({
      project_id:       projectId,
      title:            `${SMOKE_TAG} Task ${Date.now()}`,
      description:      "Smoke test task",
      deliverable_type: "file",
      payout_min:       10_00,
      payout_max:       20_00,
      status:           "open",
      task_access:      "open",
      ...overrides,
    })
    .select("id")
    .single();

  if (error || !task) throw new Error(`seedTask: ${error?.message}`);
  return { taskId: task.id };
}

/** Seed a submission for a claimed task. */
export async function seedSubmission(
  admin: SupabaseAdminClient,
  taskId: string,
  contributorId: string,
  paymentIntentId: string = "pi_smoke_test"
): Promise<{ submissionId: string }> {
  const { data: sub, error } = await admin
    .from("submissions")
    .insert({
      task_id:            taskId,
      contributor_id:     contributorId,
      asset_url:          "https://example.com/smoke-asset.zip",
      payment_intent_id:  paymentIntentId,
      status:             "pending",
    })
    .select("id")
    .single();

  if (error || !sub) throw new Error(`seedSubmission: ${error?.message}`);
  return { submissionId: sub.id };
}
