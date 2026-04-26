/**
 * apps/relay/src/verify-submission.ts — Surface-level pre-review submission checker.
 *
 * Runs BEFORE the Supabase Edge Function deep-spec gate (verify-submission edge fn).
 * Handles fast surface checks that do not require database access:
 *   format_valid       — MIME type matches deliverable_type
 *   size_within_limit  — asset < 500MB
 *   not_empty          — file size > 0
 *   mime_matches_type  — extension/MIME consistent with deliverable_type
 *   build_success      — code_patch / pr: smoke build stub (always true for now)
 *   pr_exists          — pr type: checks GitHub API for PR existence
 *   figma_accessible   — figma_link type: HEAD check on Figma URL
 *
 * If auto_reject = true the caller (submit.ts) will set the task to
 * revision_requested and notify the contributor — this handler does not
 * write to the database.
 *
 * Route: POST /verify-submission
 * Registered in apps/relay/src/index.ts main fetch handler.
 */

import type { Env } from "./index.js";

export interface VerifyRequest {
  submissionId: string;
  assetUrl: string;
  deliverableType: string;
}

export interface VerificationResult {
  passed: boolean;
  checks: {
    format_valid: boolean;
    size_within_limit: boolean;
    not_empty: boolean;
    mime_matches_type: boolean;
    build_success?: boolean;
    pr_exists?: boolean;
    figma_accessible?: boolean;
  };
  auto_reject: boolean;
  suggested_decision_reason?: string;
  failure_summary?: string;
}

const MAX_SIZE_BYTES = 500 * 1024 * 1024; // 500 MB

/** Maps deliverable_type to acceptable MIME patterns (surface check only). */
const MIME_PATTERNS: Record<string, RegExp[]> = {
  file:         [/^application\/octet-stream$/, /^text\//, /^application\/pdf$/],
  code_patch:   [/^text\/x-/, /^application\/json$/, /^text\/plain$/],
  design_asset: [/^image\//, /^application\/pdf$/, /^application\/vnd\./],
  pr:           [/^text\/html$/],
  text:         [/^text\/plain$/, /^text\/markdown$/],
  audio:        [/^audio\//],
  video:        [/^video\//],
  "3d_model":   [/^application\/octet-stream$/], // .glb .obj .fbx
  figma_link:   [/^text\/plain$/],               // plain URL string
};

async function fetchAssetHead(
  url: string
): Promise<{ ok: boolean; contentLength: number | null; contentType: string | null }> {
  try {
    const res = await fetch(url, { method: "HEAD" });
    const contentLength = res.headers.get("content-length");
    const contentType = res.headers.get("content-type") ?? "";
    return {
      ok: res.ok,
      contentLength: contentLength ? parseInt(contentLength, 10) : null,
      contentType,
    };
  } catch {
    return { ok: false, contentLength: null, contentType: "" };
  }
}

async function checkPrExists(prUrl: string, githubToken?: string): Promise<boolean> {
  const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return false;
  const [, owner, repo, number] = match;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`,
      {
        headers: {
          Authorization: githubToken ? `Bearer ${githubToken}` : "",
          Accept: "application/vnd.github.v3+json",
        },
      }
    );
    return res.ok;
  } catch {
    return false;
  }
}

export async function verifySubmission(
  request: VerifyRequest,
  env: Env
): Promise<VerificationResult> {
  const { assetUrl, deliverableType } = request;
  const checks = {
    format_valid: false,
    size_within_limit: false,
    not_empty: false,
    mime_matches_type: false,
  };
  const failures: string[] = [];

  const { ok, contentLength, contentType } = await fetchAssetHead(assetUrl);

  if (!ok) {
    failures.push(`Asset URL not reachable (${assetUrl})`);
  } else {
    if (contentLength != null && contentLength > 0) {
      checks.not_empty = true;
    } else {
      failures.push("Asset is empty");
    }

    if (contentLength != null && contentLength <= MAX_SIZE_BYTES) {
      checks.size_within_limit = true;
    } else {
      failures.push(
        `Asset exceeds 500 MB limit (${contentLength ?? "unknown"} bytes)`
      );
    }

    if (contentType) {
      const allowed = MIME_PATTERNS[deliverableType] ?? [/^application\/octet-stream$/];
      if (allowed.some((p) => p.test(contentType))) {
        checks.mime_matches_type = true;
      } else {
        failures.push(
          `MIME type '${contentType}' not valid for deliverable_type '${deliverableType}'`
        );
      }
    } else {
      // No Content-Type header — assume valid; Edge Function deep-spec gate will catch it.
      checks.mime_matches_type = true;
    }
  }

  checks.format_valid =
    checks.not_empty && checks.size_within_limit && checks.mime_matches_type;

  // ── Type-specific checks ──────────────────────────────────────────────────
  let build_success: boolean | undefined;
  let pr_exists: boolean | undefined;
  let figma_accessible: boolean | undefined;

  if (deliverableType === "pr") {
    pr_exists = await checkPrExists(assetUrl, env.GITHUB_TOKEN);
    if (!pr_exists) failures.push("Pull request not found or inaccessible");
  }

  if (deliverableType === "figma_link") {
    const figmaRes = await fetch(assetUrl, { method: "HEAD" }).catch(() => null);
    figma_accessible = figmaRes?.ok ?? false;
    if (!figma_accessible) failures.push("Figma link not accessible");
  }

  if (["code_patch", "file"].includes(deliverableType)) {
    // Smoke-build stub — real impl would clone the repo and run the build command.
    // Returns true here; deep-spec gate handles binary-level validation.
    build_success = true;
  }

  const auto_reject = !checks.format_valid;
  const failure_summary = failures.length > 0 ? failures.join("; ") : undefined;
  const suggested_decision_reason = auto_reject
    ? pr_exists === false
      ? "missing_files"
      : "quality_issue"
    : undefined;

  return {
    passed: checks.format_valid,
    checks: {
      ...checks,
      build_success,
      pr_exists,
      figma_accessible,
    },
    auto_reject,
    suggested_decision_reason,
    failure_summary,
  };
}

/** POST /verify-submission — called by index.ts main fetch handler. */
export async function handleVerifySubmission(
  request: Request,
  env: Env
): Promise<Response> {
  const corsHeaders = {
    "Access-Control-Allow-Origin": env.WEB_ORIGIN ?? "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
  }

  let body: VerifyRequest;
  try {
    body = (await request.json()) as VerifyRequest;
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON" }),
      { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }

  if (!body.submissionId || !body.assetUrl || !body.deliverableType) {
    return new Response(
      JSON.stringify({ error: "Missing required fields: submissionId, assetUrl, deliverableType" }),
      { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }

  try {
    const result = await verifySubmission(body, env);
    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Verification error";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }
}
