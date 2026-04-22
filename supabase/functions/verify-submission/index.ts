import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Max allowed sizes per deliverable type (bytes)
const MAX_SIZE: Record<string, number> = {
  file:         100 * 1024 * 1024,
  pr:           1   * 1024 * 1024,
  code_patch:   5   * 1024 * 1024,
  design_asset: 50  * 1024 * 1024,
  text:         10  * 1024 * 1024,
  audio:        200 * 1024 * 1024,
  video:        500 * 1024 * 1024,
  "3d_model":   150 * 1024 * 1024,
  figma_link:   1   * 1024 * 1024,
};

const ALLOWED_MIMES: Record<string, string[]> = {
  file:         ["application/zip", "application/x-zip-compressed", "application/octet-stream"],
  pr:           ["text/plain"],
  code_patch:   ["text/plain", "text/x-diff", "text/x-patch"],
  design_asset: ["image/png", "image/jpeg", "image/webp", "image/svg+xml", "application/pdf"],
  text:         ["text/plain", "text/markdown", "application/pdf"],
  audio:        ["audio/mpeg", "audio/wav", "audio/ogg", "audio/flac", "audio/aac"],
  video:        ["video/mp4", "video/webm", "video/quicktime"],
  "3d_model":   ["model/gltf-binary", "model/gltf+json", "application/octet-stream"],
  figma_link:   ["text/plain"],
};

interface VerificationCheck {
  name: string;
  passed: boolean;
  message: string;
}

interface VerificationResult {
  passed: boolean;
  auto_reject: boolean;
  checks: VerificationCheck[];
  suggested_decision_reason?: string;
  failure_summary?: string;
}

async function checkAssetReachability(
  assetUrl: string,
  deliverableType: string
): Promise<VerificationCheck[]> {
  const checks: VerificationCheck[] = [];

  try {
    const headRes = await fetch(assetUrl, {
      method: "HEAD",
      signal: AbortSignal.timeout(10000),
    });

    checks.push({
      name: "asset_reachable",
      passed: headRes.ok,
      message: headRes.ok
        ? `Asset accessible (${headRes.status})`
        : `Asset returned ${headRes.status}`,
    });

    if (!headRes.ok) return checks;

    const contentType = headRes.headers.get("content-type")?.split(";")[0].trim() ?? "";
    const allowedMimes = ALLOWED_MIMES[deliverableType] ?? [];
    const mimeOk = allowedMimes.length === 0 || allowedMimes.includes(contentType);

    checks.push({
      name: "mime_type_valid",
      passed: mimeOk,
      message: mimeOk
        ? `MIME type ${contentType} is valid`
        : `MIME type ${contentType} not allowed for ${deliverableType}`,
    });

    const contentLength = parseInt(headRes.headers.get("content-length") ?? "0", 10);
    const maxBytes = MAX_SIZE[deliverableType] ?? 100 * 1024 * 1024;
    const sizeOk = contentLength === 0 || contentLength <= maxBytes;

    checks.push({
      name: "file_size_valid",
      passed: sizeOk,
      message: sizeOk
        ? `File size ${(contentLength / 1024 / 1024).toFixed(1)}MB within limit`
        : `File size ${(contentLength / 1024 / 1024).toFixed(1)}MB exceeds ${(maxBytes / 1024 / 1024).toFixed(0)}MB limit`,
    });
  } catch (err) {
    checks.push({
      name: "asset_reachable",
      passed: false,
      message: `Failed to reach asset: ${err instanceof Error ? err.message : "network error"}`,
    });
  }

  return checks;
}

async function checkGitHubPR(prUrl: string): Promise<VerificationCheck[]> {
  const checks: VerificationCheck[] = [];
  const githubToken = Deno.env.get("GITHUB_TOKEN");

  const prMatch = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!prMatch) {
    checks.push({
      name: "github_pr_url_valid",
      passed: false,
      message: "URL does not match GitHub PR pattern (github.com/owner/repo/pull/N)",
    });
    return checks;
  }

  const [, owner, repo, prNumber] = prMatch;
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;

  try {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "FatedFortress-VerifyWorker/1.0",
    };
    if (githubToken) headers["Authorization"] = `Bearer ${githubToken}`;

    const res = await fetch(apiUrl, {
      headers,
      signal: AbortSignal.timeout(8000),
    });

    if (res.status === 404) {
      checks.push({
        name: "github_pr_exists",
        passed: false,
        message: `PR #${prNumber} not found in ${owner}/${repo}`,
      });
      return checks;
    }

    if (!res.ok) {
      checks.push({
        name: "github_pr_exists",
        passed: false,
        message: `GitHub API returned ${res.status}`,
      });
      return checks;
    }

    const pr = await res.json();

    checks.push({
      name: "github_pr_exists",
      passed: true,
      message: `PR #${prNumber} exists: "${pr.title}"`,
    });

    checks.push({
      name: "github_pr_not_draft",
      passed: !pr.draft,
      message: pr.draft
        ? "PR is still a draft — mark as ready for review before submitting"
        : "PR is ready for review",
    });

    checks.push({
      name: "github_pr_open",
      passed: pr.state === "open",
      message: pr.state === "open"
        ? "PR is open"
        : `PR state is "${pr.state}" — expected "open"`,
    });
  } catch (err) {
    checks.push({
      name: "github_pr_exists",
      passed: false,
      message: `GitHub check failed: ${err instanceof Error ? err.message : "network error"}`,
    });
  }

  return checks;
}

async function checkFigmaLink(figmaUrl: string): Promise<VerificationCheck[]> {
  const checks: VerificationCheck[] = [];

  const isFigmaUrl = /figma\.com\/(file|design|proto)\//.test(figmaUrl);
  checks.push({
    name: "figma_url_format",
    passed: isFigmaUrl,
    message: isFigmaUrl
      ? "Figma URL format is valid"
      : "URL does not appear to be a valid Figma file/design/prototype link",
  });

  if (!isFigmaUrl) return checks;

  try {
    const res = await fetch(figmaUrl, {
      method: "HEAD",
      signal: AbortSignal.timeout(8000),
    });
    const reachable = res.ok || res.status === 302 || res.status === 301;
    checks.push({
      name: "figma_url_reachable",
      passed: reachable,
      message: reachable
        ? "Figma link is reachable"
        : `Figma URL returned ${res.status}`,
    });
  } catch {
    checks.push({
      name: "figma_url_reachable",
      passed: false,
      message: "Could not reach Figma URL",
    });
  }

  return checks;
}

function buildResult(checks: VerificationCheck[]): VerificationResult {
  const failed = checks.filter((c) => !c.passed);
  const passed = failed.length === 0;
  const hardFailNames = [
    "asset_reachable",
    "mime_type_valid",
    "file_size_valid",
    "github_pr_exists",
    "figma_url_format",
  ];
  const hasHardFailure = failed.some((c) => hardFailNames.includes(c.name));

  let suggested_decision_reason: string | undefined;
  let failure_summary: string | undefined;

  if (!passed) {
    failure_summary = failed.map((c) => c.message).join("; ");

    if (failed.some((c) => c.name === "asset_reachable")) {
      suggested_decision_reason = "missing_files";
    } else if (failed.some((c) => c.name === "mime_type_valid" || c.name === "file_size_valid")) {
      suggested_decision_reason = "requirements_not_met";
    } else if (failed.some((c) => c.name.startsWith("github_pr"))) {
      suggested_decision_reason = "requirements_not_met";
    } else {
      suggested_decision_reason = "quality_issue";
    }
  }

  return {
    passed,
    auto_reject: hasHardFailure,
    checks,
    suggested_decision_reason,
    failure_summary,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: authError } = await supabaseClient.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const { assetUrl, deliverableType, taskId, submissionId } = await req.json();

    if (!assetUrl || !deliverableType) {
      return new Response(JSON.stringify({ error: "assetUrl and deliverableType are required" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    let allChecks: VerificationCheck[] = [];

    if (deliverableType === "pr") {
      allChecks = await checkGitHubPR(assetUrl);
    } else if (deliverableType === "figma_link") {
      allChecks = await checkFigmaLink(assetUrl);
    } else {
      allChecks = await checkAssetReachability(assetUrl, deliverableType);
    }

    const result = buildResult(allChecks);

    if (result.auto_reject && submissionId && taskId) {
      const serviceClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
      );

      // Look up the project's host_id so we have a valid not-null reference
      const { data: task } = await serviceClient
        .from("tasks")
        .select("project_id")
        .eq("id", taskId)
        .single();

      let hostId: string | null = null;
      if (task?.project_id) {
        const { data: project } = await serviceClient
          .from("projects")
          .select("host_id")
          .eq("id", task.project_id)
          .single();
        hostId = project?.host_id ?? null;
      }

      await serviceClient.from("decisions").insert({
        submission_id: submissionId,
        host_id: hostId,
        decision_reason: result.suggested_decision_reason ?? "quality_issue",
        review_notes: result.failure_summary ?? "Automated verification failed",
        structured_feedback: result.checks,
        approved_payout: 0,
      });

      await serviceClient
        .from("tasks")
        .update({ status: "revision_requested" })
        .eq("id", taskId);

      await serviceClient.from("audit_log").insert({
        actor_id: hostId,
        task_id: taskId,
        action: "verification_failed",
        payload: { submissionId, failure_summary: result.failure_summary, checks: result.checks },
      });

      await serviceClient.from("notifications").insert({
        user_id: user.id,
        type: "verification_failed",
        task_id: taskId,
        read: false,
      });
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("verify-submission error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
