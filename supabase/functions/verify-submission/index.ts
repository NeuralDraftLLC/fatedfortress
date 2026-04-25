/**
 * supabase/functions/verify-submission/index.ts
 *
 * CHANGES (wave 5 polish):
 *  - FIX 11: migrated from deprecated std@0.168.0 serve() to Deno.serve()
 *    for consistency with all other edge functions
 *  - FIX 12: single serviceClient instance reused across spec fetch +
 *    auto-reject writes (was creating two separate clients)
 *  - FIX 13: auto-reject notification targets contributor_id resolved from
 *    the submission row — not blindly user.id (the verifier)
 *  - FIX 14: missing taskId now surfaces a console.warn + inserts an explicit
 *    'spec_skipped' check entry so callers know deep-spec was not evaluated
 *
 * Previous changes retained:
 *  - spec_constraints bridge (GLB, audio, image binary parsers)
 *  - Promise.allSettled for deep checks
 *  - Surface checks (MIME, size, reachability, PR, Figma)
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin":  Deno.env.get("ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MAX_SIZE: Record<string, number> = {
  file:         100 * 1024 * 1024,
  pr:             1 * 1024 * 1024,
  code_patch:     5 * 1024 * 1024,
  design_asset:  50 * 1024 * 1024,
  text:          10 * 1024 * 1024,
  audio:        200 * 1024 * 1024,
  video:        500 * 1024 * 1024,
  "3d_model":   150 * 1024 * 1024,
  figma_link:     1 * 1024 * 1024,
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

interface SpecConstraints {
  max_polygons?:      number;
  requires_rig?:      boolean;
  lod_levels?:        number;
  sample_rate?:       number;
  channels?:          number;
  bit_depth?:         number;
  max_duration_s?:    number;
  max_width?:         number;
  max_height?:        number;
  min_width?:         number;
  min_height?:        number;
  min_words?:         number;
  max_words?:         number;
  max_files_changed?: number;
  requires_tests?:    boolean;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Deep-spec checker: GLB
// ---------------------------------------------------------------------------
async function checkGLBSpecs(
  assetUrl: string,
  spec: SpecConstraints,
): Promise<VerificationCheck[]> {
  const checks: VerificationCheck[] = [];
  if (!spec.max_polygons && !spec.requires_rig) return checks;

  try {
    const res = await fetch(assetUrl, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      checks.push({ name: "glb_readable", passed: false, message: `Could not fetch GLB (${res.status})` });
      return checks;
    }
    const buf  = await res.arrayBuffer();
    const view = new DataView(buf);

    const magic = view.getUint32(0, true);
    if (magic !== 0x46546C67) {
      checks.push({ name: "glb_magic_bytes", passed: false, message: "Not a valid .glb — magic bytes mismatch" });
      return checks;
    }
    checks.push({ name: "glb_magic_bytes", passed: true, message: "GLB magic bytes verified" });

    const version = view.getUint32(4, true);
    if (version !== 2) {
      checks.push({ name: "glb_version", passed: false, message: `GLB version ${version} — only glTF 2.0 accepted` });
      return checks;
    }

    const jsonChunkLength = view.getUint32(12, true);
    const jsonChunkType   = view.getUint32(16, true);
    if (jsonChunkType !== 0x4E4F534A) {
      checks.push({ name: "glb_json_chunk", passed: false, message: "First GLB chunk is not JSON — malformed file" });
      return checks;
    }

    const jsonBytes = new Uint8Array(buf, 20, jsonChunkLength);
    const gltf = JSON.parse(new TextDecoder().decode(jsonBytes)) as {
      meshes?: { primitives?: { mode?: number; indices?: number }[] }[];
      skins?:  unknown[];
    };

    let totalPrimitives = 0;
    for (const mesh of gltf.meshes ?? []) {
      totalPrimitives += (mesh.primitives ?? []).length;
    }
    checks.push({
      name:    "glb_json_chunk",
      passed:  true,
      message: `GLB JSON parsed — ${gltf.meshes?.length ?? 0} mesh(es), ${totalPrimitives} primitive(s)`,
    });

    if (spec.max_polygons) {
      const threshold = Math.ceil(spec.max_polygons / 1_000);
      const ok        = totalPrimitives <= threshold;
      checks.push({
        name:    "glb_polygon_budget",
        passed:  ok,
        message: ok
          ? `Primitive count (${totalPrimitives}) within budget for ${spec.max_polygons.toLocaleString()} polygon limit`
          : `Primitive count (${totalPrimitives}) likely over-budget for ${spec.max_polygons.toLocaleString()} polygon limit`,
      });
    }

    if (spec.requires_rig) {
      const hasRig = (gltf.skins?.length ?? 0) > 0;
      checks.push({
        name:    "glb_has_rig",
        passed:  hasRig,
        message: hasRig
          ? `GLB contains ${gltf.skins!.length} skin(s) — rig requirement met`
          : "GLB has no skins — rig is required but missing",
      });
    }
  } catch (err) {
    checks.push({ name: "glb_readable", passed: false, message: `GLB parse error: ${err instanceof Error ? err.message : "unknown"}` });
  }
  return checks;
}

// ---------------------------------------------------------------------------
// Deep-spec checker: Audio
// ---------------------------------------------------------------------------
async function checkAudioSpecs(
  assetUrl: string,
  spec: SpecConstraints,
): Promise<VerificationCheck[]> {
  const checks: VerificationCheck[] = [];
  if (!spec.sample_rate && !spec.channels && !spec.bit_depth) return checks;

  try {
    const res = await fetch(assetUrl, {
      headers: { Range: "bytes=0-63" },
      signal:  AbortSignal.timeout(15_000),
    });
    if (!res.ok && res.status !== 206) {
      checks.push({ name: "audio_readable", passed: false, message: `Could not fetch audio header (${res.status})` });
      return checks;
    }
    const buf   = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const view  = new DataView(buf);

    const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    const wave = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);

    if (riff === "RIFF" && wave === "WAVE") {
      const fmtTag = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
      if (fmtTag === "fmt ") {
        const channels   = view.getUint16(22, true);
        const sampleRate = view.getUint32(24, true);
        const bitDepth   = view.getUint16(34, true);
        checks.push({ name: "audio_format", passed: true, message: `WAV: ${channels}ch, ${sampleRate}Hz, ${bitDepth}-bit` });
        if (spec.sample_rate) {
          const ok = sampleRate === spec.sample_rate;
          checks.push({ name: "audio_sample_rate", passed: ok, message: ok ? `Sample rate ${sampleRate}Hz matches spec` : `Sample rate ${sampleRate}Hz — spec requires ${spec.sample_rate}Hz` });
        }
        if (spec.channels) {
          const ok = channels === spec.channels;
          checks.push({ name: "audio_channels", passed: ok, message: ok ? `Channel count ${channels} matches spec` : `Channel count ${channels} — spec requires ${spec.channels}` });
        }
        if (spec.bit_depth) {
          const ok = bitDepth === spec.bit_depth;
          checks.push({ name: "audio_bit_depth", passed: ok, message: ok ? `Bit depth ${bitDepth} matches spec` : `Bit depth ${bitDepth} — spec requires ${spec.bit_depth}` });
        }
      } else {
        checks.push({ name: "audio_format", passed: false, message: "WAV fmt sub-chunk not found at expected offset" });
      }
    } else if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
      checks.push({ name: "audio_format", passed: true, message: "MP3 with ID3v2 header — surface-level verification only" });
    } else if (bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0) {
      checks.push({ name: "audio_format", passed: true, message: "MP3 sync word detected — surface-level verification" });
    } else {
      checks.push({ name: "audio_format", passed: false, message: `Unrecognised audio format — 0x${bytes[0].toString(16).padStart(2,"0")} 0x${bytes[1].toString(16).padStart(2,"0")}` });
    }
  } catch (err) {
    checks.push({ name: "audio_readable", passed: false, message: `Audio parse error: ${err instanceof Error ? err.message : "unknown"}` });
  }
  return checks;
}

// ---------------------------------------------------------------------------
// Deep-spec checker: Image
// ---------------------------------------------------------------------------
async function checkImageSpecs(
  assetUrl: string,
  spec: SpecConstraints,
): Promise<VerificationCheck[]> {
  const checks: VerificationCheck[] = [];
  if (!spec.max_width && !spec.max_height && !spec.min_width && !spec.min_height) return checks;

  try {
    const res = await fetch(assetUrl, {
      headers: { Range: "bytes=0-511" },
      signal:  AbortSignal.timeout(15_000),
    });
    if (!res.ok && res.status !== 206) {
      checks.push({ name: "image_readable", passed: false, message: `Could not fetch image header (${res.status})` });
      return checks;
    }
    const buf   = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const view  = new DataView(buf);

    let imgWidth  = 0;
    let imgHeight = 0;
    let format    = "";

    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
      format    = "PNG";
      imgWidth  = view.getUint32(16, false);
      imgHeight = view.getUint32(20, false);
    } else if (bytes[0] === 0xFF && bytes[1] === 0xD8) {
      format = "JPEG";
      for (let i = 2; i < bytes.length - 8; i++) {
        if (bytes[i] === 0xFF && (bytes[i + 1] === 0xC0 || bytes[i + 1] === 0xC2)) {
          imgHeight = view.getUint16(i + 5, false);
          imgWidth  = view.getUint16(i + 7, false);
          break;
        }
      }
    } else {
      checks.push({ name: "image_format", passed: false, message: `Unrecognised image format — 0x${bytes[0].toString(16)} 0x${bytes[1].toString(16)}` });
      return checks;
    }

    if (imgWidth === 0 || imgHeight === 0) {
      checks.push({ name: "image_dimensions", passed: false, message: `${format}: could not extract dimensions from header` });
      return checks;
    }

    checks.push({ name: "image_format", passed: true, message: `${format}: ${imgWidth}\u00d7${imgHeight}px` });

    if (spec.max_width)  { const ok = imgWidth  <= spec.max_width;  checks.push({ name: "image_max_width",  passed: ok, message: ok ? `Width ${imgWidth}px \u2264 max ${spec.max_width}px`   : `Width ${imgWidth}px exceeds max ${spec.max_width}px` }); }
    if (spec.max_height) { const ok = imgHeight <= spec.max_height; checks.push({ name: "image_max_height", passed: ok, message: ok ? `Height ${imgHeight}px \u2264 max ${spec.max_height}px` : `Height ${imgHeight}px exceeds max ${spec.max_height}px` }); }
    if (spec.min_width)  { const ok = imgWidth  >= spec.min_width;  checks.push({ name: "image_min_width",  passed: ok, message: ok ? `Width ${imgWidth}px \u2265 min ${spec.min_width}px`   : `Width ${imgWidth}px below min ${spec.min_width}px` }); }
    if (spec.min_height) { const ok = imgHeight >= spec.min_height; checks.push({ name: "image_min_height", passed: ok, message: ok ? `Height ${imgHeight}px \u2265 min ${spec.min_height}px` : `Height ${imgHeight}px below min ${spec.min_height}px` }); }
  } catch (err) {
    checks.push({ name: "image_readable", passed: false, message: `Image parse error: ${err instanceof Error ? err.message : "unknown"}` });
  }
  return checks;
}

// ---------------------------------------------------------------------------
// Surface checkers
// ---------------------------------------------------------------------------
async function checkAssetReachability(assetUrl: string, deliverableType: string): Promise<VerificationCheck[]> {
  const checks: VerificationCheck[] = [];
  try {
    const headRes = await fetch(assetUrl, { method: "HEAD", signal: AbortSignal.timeout(10_000) });
    checks.push({ name: "asset_reachable", passed: headRes.ok, message: headRes.ok ? `Asset accessible (${headRes.status})` : `Asset returned ${headRes.status}` });
    if (!headRes.ok) return checks;

    const contentType  = headRes.headers.get("content-type")?.split(";")[0].trim() ?? "";
    const allowedMimes = ALLOWED_MIMES[deliverableType] ?? [];
    const mimeOk       = allowedMimes.length === 0 || allowedMimes.includes(contentType);
    checks.push({ name: "mime_type_valid", passed: mimeOk, message: mimeOk ? `MIME type ${contentType} is valid` : `MIME type ${contentType} not allowed for ${deliverableType}` });

    const contentLength = parseInt(headRes.headers.get("content-length") ?? "0", 10);
    const maxBytes      = MAX_SIZE[deliverableType] ?? 100 * 1024 * 1024;
    const sizeOk        = contentLength === 0 || contentLength <= maxBytes;
    checks.push({ name: "file_size_valid", passed: sizeOk, message: sizeOk ? `File size ${(contentLength / 1024 / 1024).toFixed(1)}MB within limit` : `File size ${(contentLength / 1024 / 1024).toFixed(1)}MB exceeds ${(maxBytes / 1024 / 1024).toFixed(0)}MB limit` });
  } catch (err) {
    checks.push({ name: "asset_reachable", passed: false, message: `Failed to reach asset: ${err instanceof Error ? err.message : "network error"}` });
  }
  return checks;
}

async function checkGitHubPR(prUrl: string): Promise<VerificationCheck[]> {
  const checks: VerificationCheck[] = [];
  const githubToken = Deno.env.get("GITHUB_TOKEN");
  const prMatch = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!prMatch) {
    checks.push({ name: "github_pr_url_valid", passed: false, message: "URL does not match GitHub PR pattern" });
    return checks;
  }
  const [, owner, repo, prNumber] = prMatch;
  try {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "FatedFortress-VerifyWorker/1.0",
    };
    if (githubToken) headers["Authorization"] = `Bearer ${githubToken}`;
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, { headers, signal: AbortSignal.timeout(8_000) });
    if (res.status === 404) { checks.push({ name: "github_pr_exists", passed: false, message: `PR #${prNumber} not found in ${owner}/${repo}` }); return checks; }
    if (!res.ok)            { checks.push({ name: "github_pr_exists", passed: false, message: `GitHub API returned ${res.status}` });               return checks; }
    const pr = await res.json();
    checks.push({ name: "github_pr_exists",   passed: true,              message: `PR #${prNumber} exists: "${pr.title}"` });
    checks.push({ name: "github_pr_not_draft", passed: !pr.draft,        message: pr.draft ? "PR is still a draft" : "PR is ready for review" });
    checks.push({ name: "github_pr_open",      passed: pr.state === "open", message: pr.state === "open" ? "PR is open" : `PR state is "${pr.state}"` });
  } catch (err) {
    checks.push({ name: "github_pr_exists", passed: false, message: `GitHub check failed: ${err instanceof Error ? err.message : "network error"}` });
  }
  return checks;
}

async function checkFigmaLink(figmaUrl: string): Promise<VerificationCheck[]> {
  const checks: VerificationCheck[] = [];
  const isFigmaUrl = /figma\.com\/(file|design|proto)\//.test(figmaUrl);
  checks.push({ name: "figma_url_format", passed: isFigmaUrl, message: isFigmaUrl ? "Figma URL format is valid" : "Not a valid Figma file/design/prototype link" });
  if (!isFigmaUrl) return checks;
  try {
    const res       = await fetch(figmaUrl, { method: "HEAD", signal: AbortSignal.timeout(8_000) });
    const reachable = res.ok || res.status === 302 || res.status === 301;
    checks.push({ name: "figma_url_reachable", passed: reachable, message: reachable ? "Figma link is reachable" : `Figma URL returned ${res.status}` });
  } catch {
    checks.push({ name: "figma_url_reachable", passed: false, message: "Could not reach Figma URL" });
  }
  return checks;
}

function buildResult(checks: VerificationCheck[]): VerificationResult {
  const failed = checks.filter(c => !c.passed);
  const passed = failed.length === 0;
  const hardFailNames = new Set([
    "asset_reachable", "mime_type_valid", "file_size_valid",
    "github_pr_exists", "figma_url_format",
    "glb_magic_bytes", "glb_version", "glb_has_rig", "glb_polygon_budget",
    "audio_sample_rate", "audio_channels", "audio_bit_depth",
    "image_max_width", "image_max_height", "image_min_width", "image_min_height",
  ]);
  const hasHardFailure = failed.some(c => hardFailNames.has(c.name));

  let suggested_decision_reason: string | undefined;
  let failure_summary: string | undefined;

  if (!passed) {
    failure_summary = failed.map(c => c.message).join("; ");
    if (failed.some(c => c.name === "asset_reachable"))                                  suggested_decision_reason = "missing_files";
    else if (failed.some(c => c.name === "mime_type_valid" || c.name === "file_size_valid")) suggested_decision_reason = "requirements_not_met";
    else if (failed.some(c => c.name.startsWith("github_pr")))                           suggested_decision_reason = "requirements_not_met";
    else                                                                                  suggested_decision_reason = "quality_issue";
  }

  return { passed, auto_reject: hasHardFailure, checks, suggested_decision_reason, failure_summary };
}

// ---------------------------------------------------------------------------
// Main handler — FIX 11: Deno.serve() replaces deprecated std serve()
// ---------------------------------------------------------------------------
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const authHeader    = req.headers.get("Authorization") ?? "";
    const anonClient    = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: authError } = await anonClient.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const { assetUrl, deliverableType: bodyDeliverableType, taskId, submissionId } = await req.json();
    if (!assetUrl) {
      return new Response(JSON.stringify({ error: "assetUrl is required" }), {
        status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // FIX 12: single serviceClient — reused for both spec fetch and auto-reject writes
    // FIX 14: warn + spec_skipped check if taskId is absent
    // FIX 13: contributor_id resolved from submission row for notification targeting
    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    let specConstraints: SpecConstraints = {};
    let deliverableType: string          = bodyDeliverableType ?? "file";
    const specSkippedChecks: VerificationCheck[] = [];

    if (!taskId) {
      console.warn("verify-submission: taskId not provided — deep-spec checks skipped");
      specSkippedChecks.push({
        name:    "spec_skipped",
        passed:  true,
        message: "taskId not provided — task spec constraints not evaluated",
      });
    } else {
      const { data: taskRow } = await serviceClient
        .from("tasks")
        .select("deliverable_type, spec_constraints")
        .eq("id", taskId)
        .single();
      if (taskRow) {
        if (taskRow.deliverable_type) deliverableType = taskRow.deliverable_type;
        if (taskRow.spec_constraints && typeof taskRow.spec_constraints === "object") {
          specConstraints = taskRow.spec_constraints as SpecConstraints;
        }
      }
    }

    // Surface checks
    let surfaceChecks: VerificationCheck[];
    if (deliverableType === "pr")           surfaceChecks = await checkGitHubPR(assetUrl);
    else if (deliverableType === "figma_link") surfaceChecks = await checkFigmaLink(assetUrl);
    else                                    surfaceChecks = await checkAssetReachability(assetUrl, deliverableType);

    // Deep-spec checks — parallel
    const deepChecksSettled = await Promise.allSettled([
      deliverableType === "3d_model"     ? checkGLBSpecs(assetUrl, specConstraints)   : Promise.resolve([]),
      deliverableType === "audio"        ? checkAudioSpecs(assetUrl, specConstraints) : Promise.resolve([]),
      deliverableType === "design_asset" ? checkImageSpecs(assetUrl, specConstraints) : Promise.resolve([]),
    ]);
    const deepChecks: VerificationCheck[] = deepChecksSettled.flatMap(r =>
      r.status === "fulfilled"
        ? r.value
        : [{ name: "deep_spec_check", passed: false, message: `Deep spec checker threw: ${r.reason}` }]
    );

    const allChecks = [...surfaceChecks, ...deepChecks, ...specSkippedChecks];
    const result    = buildResult(allChecks);

    // Auto-reject DB writes
    if (result.auto_reject && submissionId && taskId) {
      // FIX 13: resolve contributor_id from the submission row
      let contributorId: string | null = null;
      const { data: subRow } = await serviceClient
        .from("submissions")
        .select("contributor_id")
        .eq("id", submissionId)
        .single();
      if (subRow) contributorId = (subRow as Record<string, unknown>).contributor_id as string ?? null;

      const { data: task } = await serviceClient.from("tasks").select("project_id").eq("id", taskId).single();
      let hostId: string | null = null;
      if (task?.project_id) {
        const { data: project } = await serviceClient.from("projects").select("host_id").eq("id", task.project_id).single();
        hostId = project?.host_id ?? null;
      }

      const writes = await Promise.allSettled([
        serviceClient.from("decisions").insert({
          submission_id:    submissionId,
          host_id:          hostId,
          decision_reason:  result.suggested_decision_reason ?? "quality_issue",
          review_notes:     result.failure_summary ?? "Automated verification failed",
          structured_feedback: result.checks,
          approved_payout:  0,
        }),
        serviceClient.from("tasks").update({ status: "revision_requested" }).eq("id", taskId),
        serviceClient.from("audit_log").insert({
          actor_id: hostId ?? user.id,
          task_id:  taskId,
          action:   "verification_failed",
          payload:  { submissionId, failure_summary: result.failure_summary, checks: result.checks },
        }),
        // FIX 13: notify the contributor, not the verifier (user.id)
        ...(contributorId ? [serviceClient.from("notifications").insert({
          user_id: contributorId,
          type:    "verification_failed",
          task_id: taskId,
          read:    false,
        })] : []),
      ]);

      writes.forEach((w, i) => {
        if (w.status === "rejected") console.error(`auto-reject write[${i}] failed:`, w.reason);
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
