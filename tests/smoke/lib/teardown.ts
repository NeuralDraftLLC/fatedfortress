/**
 * tests/smoke/lib/teardown.ts
 * Deletes all rows seeded by smoke tests (identified by SMOKE_TAG title prefix).
 * Safe to run multiple times.
 */

import { SMOKE_TAG } from "./seed.ts";
import type { SupabaseAdminClient } from "./supabase.ts";

export async function teardownAll(admin: SupabaseAdminClient): Promise<void> {
  // Delete in dependency order (FK children first)
  const smokeLike = `${SMOKE_TAG}%`;

  // 1. Get smoke project IDs
  const { data: projects } = await admin
    .from("projects")
    .select("id")
    .like("title", smokeLike);

  const projectIds = (projects ?? []).map((p: { id: string }) => p.id);

  if (projectIds.length === 0) return;

  // 2. Get smoke task IDs
  const { data: tasks } = await admin
    .from("tasks")
    .select("id")
    .in("project_id", projectIds);

  const taskIds = (tasks ?? []).map((t: { id: string }) => t.id);

  if (taskIds.length > 0) {
    // Delete children of tasks
    await admin.from("decisions").delete().in("submission_id",
      (await admin.from("submissions").select("id").in("task_id", taskIds)).data
        ?.map((s: { id: string }) => s.id) ?? []
    );
    await admin.from("submissions").delete().in("task_id", taskIds);
    await admin.from("audit_log").delete().in("task_id", taskIds);
    await admin.from("notifications").delete().in("task_id", taskIds);
    await admin.from("payout_ledger").delete().in("task_id", taskIds);
    await admin.from("tasks").delete().in("id", taskIds);
  }

  // 3. Delete wallets + projects
  await admin.from("project_wallet").delete().in("project_id", projectIds);
  await admin.from("projects").delete().in("id", projectIds);
}
