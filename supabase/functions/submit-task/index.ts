/**
 * supabase/functions/submit-task/index.ts
 *
 * Stage 3 orchestrator — the ONLY path to submitting work on a task.
 *
 * What this does:
 *   1. Validate contributor owns the claimed task
 *   2. For PR submissions: live GitHub API validation
 *      — PR exists, is not a draft, is open
 *      — PR touches at least one file matching the task's expected_path
 *      — Fetch PR file list + store diff_url for host review
 *   3. Call submit_task_atomic RPC
 *      — inserts submission record
 *      — transitions task → under_review
 *      — audit log + host notification
 *   4. Invoke verify-submission async (non-blocking)
 *      — deep binary / PR / spec_constraints checks run in background
 *      — result written back to submissions.verification_result
 *   5. Return submission + initial verification status to frontend
 *
 * POST body:
 * {
 *   taskId:    string (uuid)
 *   assetUrl?: string  -- Supabase Storage URL (from supabase-storage-upload)
 *   prUrl?:    string  -- GitHub PR URL (https://github.com/org/repo/pull/N)
 *   notes?:    string  -- contributor message to host (max 2000 chars)
 * }
 *
 * At least one of assetUrl or prUrl is required.
 */

import { resolveAuth, serviceRoleClient } from "../_shared/auth.ts";

const GITHUB_TOKEN = Deno.env.get("GITHUB_TOKEN");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Types ───────────────────────────────────────────────────────────────────

interface PRFile {
  filename:  string;
  status:    string;
  additions: number;
  deletions: number;
  patch?:    string;
}

interface PRValidation {
  valid:        boolean;
  error?:       string;
  pr_title?:    string;
  pr_state?:    string;
  is_draft?:    boolean;
  diff_url?:    string;
  files?:       PRFile[];
  touches_expected_path: boolean;
}

// ── GitHub helpers ──────────────────────────────────────────────────────────

function ghHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    Accept:       "application/vnd.github.v3+json",
    "User-Agent": "FatedFortress-SubmitTask/1.0",
  };
  if (GITHUB_TOKEN) h["Authorization"] = `Bearer ${GITHUB_TOKEN}`;
  return h;
}

async function validatePR(
  prUrl: string,
  expectedPath: string | null
): Promise<PRValidation> {
  const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) {
    return { valid: false, error: "Not a valid GitHub PR URL", touches_expected_path: false };
  }
  const [, owner, repo, prNum] = match;

  // ── Fetch PR metadata ────────────────────────────────────────────────────
  let prData: Record<string, unknown>;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNum}`,
      { headers: ghHeaders(), signal: AbortSignal.timeout(10000) }
    );
    if (res.status === 404) return { valid: false, error: `PR #${prNum} not found in ${owner}/${repo}`, touches_expected_path: false };
    if (!res.ok)            return { valid: false, error: `GitHub API returned ${res.status}`, touches_expected_path: false };
    prData = await res.json() as Record<string, unknown>;
  } catch (e) {
    return { valid: false, error: `GitHub API unreachable: ${(e as Error).message}`, touches_expected_path: false };
  }

  const isDraft = Boolean(prData.draft);
  const state   = prData.state as string;

  if (isDraft)        return { valid: false, error: "PR is still a draft — mark it ready for review before submitting", is_draft: true, pr_title: prData.title as string, touches_expected_path: false };
  if (state !== "open") return { valid: false, error: `PR is "${state}" — only open PRs can be submitted`, pr_state: state, pr_title: prData.title as string, touches_expected_path: false };

  // ── Fetch changed files ──────────────────────────────────────────────────
  let files: PRFile[] = [];
  try {
    const filesRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNum}/files?per_page=100`,
      { headers: ghHeaders(), signal: AbortSignal.timeout(10000) }
    );
    if (filesRes.ok) {
      const raw = await filesRes.json() as PRFile[];
      // Strip patch hunks from storage (can be huge) but keep metadata
      files = raw.map(({ filename, status, additions, deletions }) => ({ filename, status, additions, deletions }));
    }
  } catch { /* non-fatal — file list is enrichment, not a blocker */ }

  // ── Expected path check ──────────────────────────────────────────────────
  // expected_path may be a glob-style prefix, e.g. "src/models/"
  // We check if any changed file starts with (or equals) the path.
  let touchesExpectedPath = true; // default: pass if no expected_path
  if (expectedPath && files.length > 0) {
    const norm = expectedPath.replace(/\/$/, ""); // strip trailing slash
    touchesExpectedPath = files.some(
      f => f.filename === norm || f.filename.startsWith(norm + "/") || f.filename.startsWith(norm)
    );
  }

  const diffUrl = `https://github.com/${owner}/${repo}/pull/${prNum}.diff`;

  return {
    valid:                 true,
    pr_title:              prData.title as string,
    pr_state:              state,
    is_draft:              isDraft,
    diff_url:              diffUrl,
    files,
    touches_expected_path: touchesExpectedPath,
  };
}

// ── Async verify (fire-and-forget, writes result back to submission) ─────────

async function runVerificationAsync(
  submissionId: string,
  taskId: string,
  assetUrl: string | null,
  prUrl: string | null,
  contributorId: string,
  serviceToken: string
): Promise<void> {
  try {
    const verifyRes = await fetch(
      `${SUPABASE_URL}/functions/v1/verify-submission`,
      {
        method:  "POST",
        headers: {
          "Content-Type":  "application/json",
          Authorization:   `Bearer ${serviceToken}`,
        },
        body: JSON.stringify({
          assetUrl:       assetUrl ?? prUrl,
          deliverableType: prUrl && !assetUrl ? "pr" : undefined,
          taskId,
          submissionId,
        }),
        signal: AbortSignal.timeout(60000), // 60s — deep binary checks can be slow
      }
    );

    const admin = serviceRoleClient();
    if (verifyRes.ok) {
      const result = await verifyRes.json();
      // Write result back to submission
      await admin
        .from("submissions")
        .update({
          verification_result: result,
          verified_at: new Date().toISOString(),
        })
        .eq("id", submissionId);

      // If auto-rejected, reset task to revision_requested + notify contributor
      if (result.auto_reject) {
        await admin
          .from("tasks")
          .update({ status: "revision_requested", updated_at: new Date().toISOString() })
          .eq("id", taskId);

        await admin.from("notifications").insert({
          user_id:  contributorId,
          type:     "verification_failed",
          task_id:  taskId,
        });
      }
    } else {
      console.error("submit-task: verify-submission returned", verifyRes.status);
    }
  } catch (err) {
    console.error("submit-task: runVerificationAsync error", err);
  }
}

// ── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const auth = await resolveAuth(req);
  if (auth.kind !== "user") {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers: CORS });
  }

  const admin = serviceRoleClient();

  // ── Parse body ─────────────────────────────────────────────────────────
  const body = await req.json() as {
    taskId:    string;
    assetUrl?: string;
    prUrl?:    string;
    notes?:    string;
  };

  const { taskId, assetUrl, prUrl } = body;
  const notes = body.notes?.slice(0, 2000) ?? null;

  if (!taskId) {
    return Response.json({ error: "taskId is required" }, { status: 400, headers: CORS });
  }
  if (!assetUrl && !prUrl) {
    return Response.json(
      { error: "At least one of assetUrl or prUrl is required" },
      { status: 400, headers: CORS }
    );
  }

  // ── Fetch task (verify ownership + state before hitting RPC) ────────────
  const { data: taskRow, error: taskErr } = await admin
    .from("tasks")
    .select(`
      id, status, claimed_by, deliverable_type, expected_path, title, payout_max,
      project:projects ( id, host_id, title )
    `)
    .eq("id", taskId)
    .single();

  if (taskErr || !taskRow) {
    return Response.json({ error: "Task not found" }, { status: 404, headers: CORS });
  }

  const task = taskRow as Record<string, unknown>;

  if (task.claimed_by !== auth.user.id) {
    return Response.json(
      { error: "not_assignee", message: "You have not claimed this task." },
      { status: 403, headers: CORS }
    );
  }

  if (!(["claimed", "revision_requested"] as string[]).includes(task.status as string)) {
    return Response.json(
      { error: "invalid_status", message: `Task is in status "${task.status}" — cannot submit.` },
      { status: 409, headers: CORS }
    );
  }

  // ── PR validation (live GitHub checks) ─────────────────────────────────
  let prValidation: PRValidation | null = null;
  let prDiffUrl:    string | null       = null;
  let prFiles:      PRFile[] | null     = null;

  if (prUrl) {
    prValidation = await validatePR(prUrl, task.expected_path as string | null);

    if (!prValidation.valid) {
      return Response.json(
        {
          error:   "pr_validation_failed",
          message: prValidation.error,
          details: prValidation,
        },
        { status: 422, headers: CORS }
      );
    }

    // Warn if PR doesn't touch expected files — not a hard block, but surfaces to host
    if (!prValidation.touches_expected_path && task.expected_path) {
      console.warn(
        `submit-task: PR ${prUrl} does not touch expected_path "${task.expected_path}" for task ${taskId}`
      );
    }

    prDiffUrl = prValidation.diff_url ?? null;
    prFiles   = prValidation.files ?? null;
  }

  // ── Atomic DB submission ────────────────────────────────────────────────
  const { data: rpcResult, error: rpcErr } = await admin.rpc("submit_task_atomic", {
    p_task_id:        taskId,
    p_contributor_id: auth.user.id,
    p_asset_url:      assetUrl ?? null,
    p_pr_url:         prUrl ?? null,
    p_pr_diff_url:    prDiffUrl,
    p_pr_files:       prFiles ? JSON.stringify(prFiles) : null,
    p_notes:          notes,
  });

  if (rpcErr) {
    console.error("submit-task: RPC error", rpcErr);
    return Response.json({ error: "submission_failed", message: rpcErr.message }, { status: 500, headers: CORS });
  }

  const result = rpcResult as { result: string; submission_id?: string };

  if (result.result !== "ok") {
    const msgs: Record<string, [string, number]> = {
      no_evidence:    ["Provide an asset URL or PR link.",          400],
      not_assignee:   ["You have not claimed this task.",           403],
      invalid_status: [`Task status is "${task.status}".",          409],
      race:           ["Submission conflict — please retry.",       409],
      not_found:      ["Task not found.",                           404],
    };
    const [msg, status] = msgs[result.result] ?? ["Submission failed.", 500];
    return Response.json({ error: result.result, message: msg }, { status, headers: CORS });
  }

  const submissionId = result.submission_id!;

  // ── Fire-and-forget async verification ─────────────────────────────────
  // Don't await — returns immediately so contributor gets instant feedback.
  // Verification result is written back to submissions.verification_result.
  const serviceToken = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  runVerificationAsync(
    submissionId, taskId,
    assetUrl ?? null, prUrl ?? null,
    auth.user.id, serviceToken
  ).catch(err => console.error("submit-task: verification async error", err));

  // ── Return to frontend ──────────────────────────────────────────────────
  return Response.json(
    {
      success:       true,
      submission_id: submissionId,
      task_status:   "under_review",
      pr_validation: prValidation
        ? {
            pr_title:              prValidation.pr_title,
            diff_url:              prValidation.diff_url,
            files_changed:         prValidation.files?.length ?? 0,
            touches_expected_path: prValidation.touches_expected_path,
          }
        : null,
      verification_status: "running",
      message: "Submission received. The AI is reviewing your work now.",
    },
    { headers: CORS }
  );
});
