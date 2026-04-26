/**
 * supabase/functions/asset-sanitizer/index.ts
 *
 * Pillar 3: Malware + steganography sanitization pipeline.
 *
 * Flow:
 *   1. Fetch file from Supabase Storage
 *   2. Route by file type:
 *      GLB  → VirusTotal scan → Railway GLB turntable worker → MP4 URL
 *      PNG  → VirusTotal scan → Railway re-encode worker → clean PNG URL
 *      WAV  → VirusTotal scan → Railway re-encode worker → clean WAV URL
 *      other → VirusTotal scan → pass-through (no re-encode needed)
 *   3. Write proxy_video_url to submissions row (GLB only)
 *   4. Return sanitized file URL
 *
 * VirusTotal is used (instead of ClamAV) because:
 *   - It has a verified free public API (10-15 req/min on free tier)
 *   - No self-hosting required
 *   - Accepts file uploads via multipart POST
 *
 * Railway workers are used for heavy re-encoding (instead of Deno edge) because:
 *   - Deno isolate memory limit is 150MB; large GLB files risk OOM
 *   - Railway workers have configurable RAM (up to 8GB)
 *   - GLB → MP4 turntable render requires Three.js headless which is memory-intensive
 *
 * POST body:
 * {
 *   submissionId: string
 *   fileUrl: string          // Supabase Storage URL of the submitted file
 *   fileType: "3d_model" | "image" | "audio" | "other"
 * }
 *
 * Response:
 * {
 *   cleanUrl: string          // URL of the sanitized / re-encoded file
 *   proxyVideoUrl?: string    // MP4 turntable URL (GLB only)
 *   virusTotalResult?: { malicious: boolean; score: number }
 * }
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin":  Deno.env.get("ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const VIRUSTOTAL_API_KEY = Deno.env.get("VIRUSTOTAL_API_KEY") ?? "";
const RAILWAY_GLBTURNTABLE_URL = Deno.env.get("RAILWAY_GLBTURNTABLE_URL") ?? "";
const RAILWAY_REENCODE_URL = Deno.env.get("RAILWAY_REENCODE_URL") ?? "";
const SUBMISSION_BUCKET = "submissions";

interface SanitizerRequest {
  submissionId: string;
  fileUrl: string;
  fileType: "3d_model" | "image" | "audio" | "other";
}

interface VirusTotalResult {
  malicious: boolean;
  score: number;
  details?: string;
}

// ─── VirusTotal scan ─────────────────────────────────────────────────────────

async function scanWithVirusTotal(fileBuffer: ArrayBuffer, filename: string): Promise<VirusTotalResult> {
  if (!VIRUSTOTAL_API_KEY) {
    // No API key configured — skip scan in development
    return { malicious: false, score: 0, details: "VIRUSTOTAL_API_KEY not set — scan skipped" };
  }

  const form = new FormData();
  form.append("file", new Blob([fileBuffer]), filename);

  const res = await fetch("https://www.virustotal.com/api/v3/files", {
    method: "POST",
    headers: {
      "x-apikey": VIRUSTOTAL_API_KEY,
    },
    body: form,
  });

  if (!res.ok) {
    // 429 rate limit — treat as safe pass with warning
    if (res.status === 429) {
      return { malicious: false, score: 0, details: "VirusTotal rate-limited — passed without scan" };
    }
    throw new Error(`VirusTotal upload failed: ${res.status} ${await res.text().then(t => t.slice(0, 100))}`);
  }

  const { data } = await res.json() as { data: { id: string } };
  const analysisRes = await fetch(`https://www.virustotal.com/api/v3/analyses/${data.id}`, {
    headers: { "x-apikey": VIRUSTOTAL_API_KEY },
  });

  if (!analysisRes.ok) {
    throw new Error(`VirusTotal analysis fetch failed: ${analysisRes.status}`);
  }

  const { data: analysis } = await analysisRes.json() as {
    data: {
      attributes: {
        last_analysis_stats: { malicious: number; suspicious: number; undetected: number; harmless: number };
        last_analysis_results: Record<string, { category: string; result: string }>;
      };
    };
  };

  const stats = analysis.attributes.last_analysis_stats;
  const score = stats.malicious * 3 + stats.suspicious * 2;
  const malicious = stats.malicious > 0 || stats.suspicious > 2;

  return {
    malicious,
    score,
    details: `malicious=${stats.malicious} suspicious=${stats.suspicious} harmless=${stats.harmless} undetected=${stats.undetected}`,
  };
}

// ─── Railway worker calls ─────────────────────────────────────────────────────

// Perplexity: GLB worker now returns { success, data: number[], contentType }
// We reconstruct the bytes and upload to Supabase Storage here (edge function has the service role key)
async function renderGLBTurntable(glbBuffer: ArrayBuffer): Promise<ArrayBuffer> {
  if (!RAILWAY_GLBTURNTABLE_URL) throw new Error("RAILWAY_GLBTURNTABLE_URL not configured");

  const res = await fetch(RAILWAY_GLBTURNTABLE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: glbBuffer,
  });

  if (!res.ok) throw new Error(`GLB turntable worker failed: ${res.status}`);
  const json = await res.json() as { success: boolean; data?: number[]; error?: string };
  if (!json.success) throw new Error(`GLB worker error: ${json.error}`);

  // Perplexity: Reconstruct MP4 bytes from JSON-safe number[] and return for upload
  return new Uint8Array(json.data as number[]).buffer;
}

async function reencodeFile(buffer: ArrayBuffer, mimeType: string): Promise<ArrayBuffer> {
  if (!RAILWAY_REENCODE_URL) {
    // No re-encode worker configured — return original
    return buffer;
  }

  const res = await fetch(RAILWAY_REENCODE_URL, {
    method: "POST",
    headers: {
      "Content-Type": mimeType,
      "X-Target-Mime": mimeType === "image/png" ? "image/png" : "audio/wav",
    },
    body: buffer,
  });

  if (!res.ok) {
    throw new Error(`Re-encode worker failed: ${res.status}`);
  }

  return res.arrayBuffer();
}

// ─── Main handler ────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const { submissionId, fileUrl, fileType } = await req.json() as SanitizerRequest;

    if (!submissionId || !fileUrl || !fileType) {
      return Response.json({ error: "submissionId, fileUrl, and fileType are required" }, {
        status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // ── Step 1: Download file from Supabase Storage ─────────────────────────
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const storage = createClient(supabaseUrl, serviceRoleKey);

    const fileResponse = await storage.storage.from(SUBMISSION_BUCKET).download(fileUrl.replace(/.*\/storage\/v1\/object\/public\//, ""));
    if (fileResponse.error) {
      throw new Error(`Storage download failed: ${fileResponse.error.message}`);
    }
    const fileBuffer = await fileResponse.data.arrayBuffer();
    const filename = fileUrl.split("/").pop() ?? "file";

    // ── Step 2: VirusTotal scan ────────────────────────────────────────────
    const vtResult = await scanWithVirusTotal(fileBuffer, filename);
    if (vtResult.malicious) {
      // Log to audit and return rejection
      return Response.json({
        error: "MALWARE_DETECTED",
        message: `File flagged by VirusTotal: ${vtResult.details}`,
        cleanUrl: null,
      }, {
        status: 422, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // ── Step 3: Route by type ───────────────────────────────────────────────
    let cleanUrl = fileUrl;  // default: pass-through
    let proxyVideoUrl: string | undefined;

    if (fileType === "3d_model") {
      // Perplexity: GLB worker returns MP4 bytes → upload to Supabase Storage here
      const mp4Buffer = await renderGLBTurntable(fileBuffer);
      const mp4Name = `proxy_${submissionId}.mp4`;
      const { error: mp4Error } = await storage.storage
        .from(SUBMISSION_BUCKET).upload(mp4Name, mp4Buffer, { contentType: "video/mp4" });
      if (mp4Error) throw new Error(`MP4 upload failed: ${mp4Error.message}`);
      const { data: mp4UrlData } = storage.storage.from(SUBMISSION_BUCKET).getPublicUrl(mp4Name);
      proxyVideoUrl = mp4UrlData.publicUrl;
    } else if (fileType === "image") {
      // Re-encode PNG through Railway to strip EXIF + steganography
      const cleaned = await reencodeFile(fileBuffer, "image/png");
      // Upload cleaned file back to storage
      const cleanName = `clean_${submissionId}.png`;
      const { error: uploadError } = await storage.storage
        .from(SUBMISSION_BUCKET)
        .upload(cleanName, cleaned, { contentType: "image/png" });
      if (uploadError) throw new Error(`Clean file upload failed: ${uploadError.message}`);
      const { data: uploadData } = storage.storage.from(SUBMISSION_BUCKET).getPublicUrl(cleanName);
      cleanUrl = uploadData.publicUrl;
    } else if (fileType === "audio") {
      // Re-encode WAV through Railway to strip any embedded artifacts
      const cleaned = await reencodeFile(fileBuffer, "audio/wav");
      const cleanName = `clean_${submissionId}.wav`;
      const { error: uploadError } = await storage.storage
        .from(SUBMISSION_BUCKET)
        .upload(cleanName, cleaned, { contentType: "audio/wav" });
      if (uploadError) throw new Error(`Clean file upload failed: ${uploadError.message}`);
      const { data: uploadData } = storage.storage.from(SUBMISSION_BUCKET).getPublicUrl(cleanName);
      cleanUrl = uploadData.publicUrl;
    }
    // else: other type — pass-through, no re-encode needed

    // ── Step 4: Update submission row with proxy_video_url (GLB only) ──────
    if (fileType === "3d_model" && proxyVideoUrl) {
      const { error: updateErr } = await storage
        .from("submissions")
        .update({ proxy_video_url: proxyVideoUrl })
        .eq("id", submissionId);
      if (updateErr) {
        console.error("Failed to update proxy_video_url:", updateErr);
        // Non-fatal — the MP4 was generated, just the DB column didn't update
      }
    }

    return Response.json({
      cleanUrl,
      proxyVideoUrl,
      virusTotalResult: vtResult,
    }, {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("asset-sanitizer error:", err);
    return Response.json({
      error: "SANITIZER_ERROR",
      message: err instanceof Error ? err.message : String(err),
    }, {
      status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
