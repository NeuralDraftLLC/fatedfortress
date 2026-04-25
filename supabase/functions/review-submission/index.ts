/**
 * supabase/functions/review-submission/index.ts
 *
 * CHANGES (wave 6):
 *  - FIX 8: after approved/rejected decision, upsert avg_review_time_hours
 *    onto the host's profile using an online Welford running mean:
 *      new_avg = old_avg + (new_sample - old_avg) / new_count
 *    This requires profiles to have: review_count INT, avg_review_time_hours FLOAT.
 *    Both columns are added by the seed migration if they don't exist.
 *
 * Previous wave-5 changes retained in full.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { resolveAuth, serviceRoleClient } from "../_shared/auth.ts";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin":  Deno.env.get("ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type Decision = "approved" | "revision_requested" | "rejected";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });

  try {
    const user = await resolveAuth(req);
    if (!user) return json({ error: "Unauthorized" }, 401);

    const body = await req.json() as {
      submission_id:        string;
      decision:             Decision;
      decision_reason:      string;
      review_notes?:        string;
      revision_deadline?:   string;
      approved_payout?:     number;
    };

    const { submission_id, decision, decision_reason, review_notes, revision_deadline, approved_payout } = body;
    if (!submission_id || !decision) return json({ error: "submission_id and decision are required" }, 400);

    const svc = serviceRoleClient();

    // Fetch submission + task + project
    const { data: sub, error: subErr } = await svc
      .from("submissions")
      .select("id, contributor_id, task_id, created_at")
      .eq("id", submission_id)
      .single();
    if (subErr || !sub) return json({ error: "Submission not found" }, 404);

    const subRow = sub as Record<string, unknown>;
    const taskId        = String(subRow.task_id);
    const contributorId = String(subRow.contributor_id);
    const submittedAt   = new Date(String(subRow.created_at ?? Date.now()));

    const { data: task, error: taskErr } = await svc
      .from("tasks")
      .select("id, project_id, payout_min, payout_max, status")
      .eq("id", taskId)
      .single();
    if (taskErr || !task) return json({ error: "Task not found" }, 404);

    const taskRow  = task as Record<string, unknown>;
    const projectId = String(taskRow.project_id);

    const { data: project } = await svc
      .from("projects")
      .select("host_id")
      .eq("id", projectId)
      .single();
    const hostId = (project as Record<string, unknown> | null)?.host_id as string | null ?? user.id;

    // Guard: only the project host can review
    if (hostId !== user.id) return json({ error: "Forbidden — only the project host may review" }, 403);

    const reviewedAt   = new Date();
    const payoutAmount = typeof approved_payout === "number"
      ? approved_payout
      : decision === "approved" ? Number(taskRow.payout_max ?? 0) : 0;

    // Determine new task status
    const newTaskStatus =
      decision === "approved"            ? "completed" :
      decision === "revision_requested"  ? "revision_requested" :
      "open"; // rejected → re-open for reclaim

    const writes = await Promise.allSettled([
      // 1. Insert decision record
      svc.from("decisions").insert({
        submission_id,
        host_id:          hostId,
        decision_reason,
        review_notes:     review_notes ?? null,
        structured_feedback: null,
        approved_payout:  payoutAmount,
      }),

      // 2. Update task status
      svc.from("tasks").update({
        status:             newTaskStatus,
        ...(decision === "revision_requested" && revision_deadline
          ? { revision_deadline }
          : {}),
      }).eq("id", taskId),

      // 3. Audit log
      svc.from("audit_log").insert({
        actor_id: hostId,
        task_id:  taskId,
        action:   `decision_${decision}`,
        payload:  { submission_id, decision_reason, approved_payout: payoutAmount },
      }),

      // 4. Notify contributor
      svc.from("notifications").insert({
        user_id: contributorId,
        type:    `decision_${decision}`,
        task_id: taskId,
        read:    false,
      }),

      // 5. FIX 8: update host avg_review_time_hours using Welford running mean
      ...(decision === "approved" || decision === "rejected"
        ? [updateHostAvgReviewTime(svc, hostId, submittedAt, reviewedAt)]
        : []),
    ]);

    writes.forEach((w, i) => {
      if (w.status === "rejected") console.error(`review-submission write[${i}] failed:`, (w as PromiseRejectedResult).reason);
    });

    return json({ ok: true, decision, task_status: newTaskStatus, approved_payout: payoutAmount });

  } catch (err) {
    console.error("review-submission error:", err);
    return json({ error: "Internal server error" }, 500);
  }
});

// ---------------------------------------------------------------------------
// FIX 8: Welford running mean for avg_review_time_hours
// ---------------------------------------------------------------------------
async function updateHostAvgReviewTime(
  svc: ReturnType<typeof createClient>,
  hostId: string,
  submittedAt: Date,
  reviewedAt: Date,
): Promise<void> {
  const elapsedHours = (reviewedAt.getTime() - submittedAt.getTime()) / (1000 * 60 * 60);

  // Fetch current running stats (review_count + avg_review_time_hours)
  const { data: profile } = await svc
    .from("profiles")
    .select("review_count, avg_review_time_hours")
    .eq("id", hostId)
    .single();

  const currentCount = Number((profile as Record<string, unknown> | null)?.review_count ?? 0);
  const currentAvg   = Number((profile as Record<string, unknown> | null)?.avg_review_time_hours ?? 0);

  const newCount = currentCount + 1;
  // Welford online mean: M_n = M_{n-1} + (x_n - M_{n-1}) / n
  const newAvg   = currentAvg + (elapsedHours - currentAvg) / newCount;

  const { error } = await svc
    .from("profiles")
    .update({
      review_count:          newCount,
      avg_review_time_hours: Math.round(newAvg * 100) / 100, // 2 dp
    })
    .eq("id", hostId);

  if (error) console.error("updateHostAvgReviewTime upsert failed:", error);
}
