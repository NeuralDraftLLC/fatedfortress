/**
 * supabase/functions/r2-upload-url/index.ts
 *
 * Generates presigned PUT (upload) and GET (download) URLs for Cloudflare R2
 * using AWS Signature V4 — no external signing library, pure Web Crypto API.
 *
 * Key structure:
 *   deliverables/{taskId}/{contributorId}/{timestamp}_{filename}   <- task uploads
 *   portfolio/{userId}/{timestamp}_{filename}                       <- profile portfolio
 *
 * Secrets required (all via Deno.env):
 *   CLOUDFLARE_R2_ACCOUNT_ID   — from Cloudflare dashboard URL
 *   R2_BUCKET_NAME              — e.g. "fortress-deliverables"
 *   R2_ACCESS_KEY_ID            — from R2 -> Manage API Tokens
 *   R2_SECRET_ACCESS_KEY        — from R2 -> Manage API Tokens
 *   R2_PUBLIC_BASE_URL         — e.g. "https://pub-xxxxxxxx.r2.dev"
 */

import { resolveAuth, serviceRoleClient } from "../_shared/auth.ts";

const R2_ACCOUNT_ID  = Deno.env.get("CLOUDFLARE_R2_ACCOUNT_ID")!;
const R2_BUCKET     = Deno.env.get("R2_BUCKET_NAME")!;
const R2_ACCESS_KEY = Deno.env.get("R2_ACCESS_KEY_ID")!;
const R2_SECRET_KEY = Deno.env.get("R2_SECRET_ACCESS_KEY")!;
const R2_PUBLIC_BASE = Deno.env.get("R2_PUBLIC_BASE_URL")!;

const REGION = "auto";
const SERVICE = "s3";
const URL_EXPIRY_SECS = 3600;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ---------------------------------------------------------------------------
// AWS Signature V4 — pure Web Crypto API
// ---------------------------------------------------------------------------

async function hmacSha256(key: Uint8Array, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}

async function sha256Hex(data: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function isoTimestamp(): string {
  return new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
}

/**
 * Build a presigned R2 URL (PUT for upload, GET for download).
 * Uses AWS Signature V4 with Web Crypto API — no AWS SDK needed.
 */
async function buildPresignedUrl(
  objectKey: string,
  method: "PUT" | "GET",
  contentType: string,
  expiresAt: number
): Promise<{ url: string; expiresAt: number }> {
  const host = `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const now = new Date();
  const amzDate = isoTimestamp();
  const dateStamp = amzDate.slice(0, 8);

  // Expiry in seconds from now (minimum 5 minutes)
  const expirySecs = Math.max(300, Math.floor((expiresAt - now.getTime()) / 1000));
  const expiryEpoch = Math.floor(now.getTime() / 1000) + expirySecs;

  // Encode the object key path (AWS S3 style: encodeURIComponent for each path segment)
  const encodedKey = objectKey
    .split("/")
    .map((s) => encodeURIComponent(s).replace(/%2F/g, "/"))
    .join("/");
  const canonicalUriPath = `/${R2_BUCKET}/${encodedKey}`;

  // Credential scope
  const credential = `${R2_ACCESS_KEY}/${dateStamp}/${REGION}/${SERVICE}/aws4_request`;

  // Query parameters (must be sorted alphabetically)
  const queryParams: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": encodeURIComponent(credential),
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expirySecs),
    "X-Amz-SignedHeaders": "host",
  };

  const sortedQuery = Object.keys(queryParams)
    .sort()
    .map((k) => `${k}=${queryParams[k]}`)
    .join("&");

  // Headers (must be sorted alphabetically for canonical request)
  const headers: Record<string, string> = {
    host,
    "x-amz-date": amzDate,
  };
  if (method === "PUT") {
    headers["content-type"] = contentType;
  }

  const signedHeadersList = Object.keys(headers).sort().join(";");

  // Canonical request
  const canonicalRequest = [
    method,
    canonicalUriPath,
    sortedQuery,
    Object.keys(headers).sort().map((k) => `${k.toLowerCase()}:${headers[k]}`).join("\n") + "\n",
    signedHeadersList,
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const canonicalHash = await sha256Hex(canonicalRequest);

  // String to sign
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    `${dateStamp}/${REGION}/${SERVICE}/aws4_request`,
    canonicalHash,
  ].join("\n");

  // Signing key: AWS4-HMAC-SHA256(secret, date, region, service, "aws4_request")
  const k1 = await hmacSha256(new TextEncoder().encode("AWS4" + R2_SECRET_KEY), dateStamp);
  const k2 = await hmacSha256(k1, REGION);
  const k3 = await hmacSha256(k2, SERVICE);
  const k4 = await hmacSha256(k3, "aws4_request");
  const signature = await hmacSha256(k4, stringToSign);
  const signatureHex = Array.from(signature).map((b) => b.toString(16).padStart(2, "0")).join("");

  const url = `https://${host}${canonicalUriPath}?${sortedQuery}&X-Amz-Signature=${signatureHex}`;

  return { url, expiresAt: expiryEpoch * 1000 };
}

// ---------------------------------------------------------------------------
// Input validation helpers
// ---------------------------------------------------------------------------

const VALID_DELIVERABLE_TYPES = new Set([
  "file", "pr", "code_patch", "design_asset",
  "text", "audio", "video", "3d_model", "figma_link",
]);

function sanitizeName(name: string): string {
  return name.replace(/\x00/g, "").replace(/\.\./g, "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
}

function inferContentType(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    pdf: "application/pdf", png: "image/png", jpg: "image/jpeg",
    jpeg: "image/jpeg", webp: "image/webp", svg: "image/svg+xml",
    mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
    mp3: "audio/mpeg", wav: "audio/wav", glb: "model/gltf-binary",
    gltf: "model/gltf+json", zip: "application/zip",
    md: "text/markdown", txt: "text/plain", json: "application/json",
  };
  return map[ext ?? ""] ?? "application/octet-stream";
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  const auth = await resolveAuth(req);
  if (auth.kind !== "user") {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
  const { user } = auth;
  const admin = serviceRoleClient();

  try {
    const body = await req.json();
    const {
      taskId,
      contributorId,
      userId,
      fileName,
      contentType,
      deliverableType = "file",
      isPortfolio = false,
    } = body as {
      taskId?: string;
      contributorId?: string;
      userId?: string;
      fileName?: string;
      contentType?: string;
      deliverableType?: string;
      isPortfolio?: boolean;
    };

    // Validate
    if (!fileName || typeof fileName !== "string" || fileName.length > 200) {
      return new Response(JSON.stringify({ error: "Invalid or missing fileName" }), {
        status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    if (!isPortfolio && (!taskId || !contributorId)) {
      return new Response(JSON.stringify({ error: "taskId and contributorId required for deliverables" }), {
        status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    if (isPortfolio && !userId) {
      return new Response(JSON.stringify({ error: "userId required for portfolio uploads" }), {
        status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    if (!VALID_DELIVERABLE_TYPES.has(deliverableType ?? "")) {
      return new Response(JSON.stringify({ error: `Invalid deliverableType: ${deliverableType}` }), {
        status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    if (isPortfolio) {
      if (!userId || userId !== user.id) {
        return new Response(JSON.stringify({ error: "Invalid userId for portfolio upload" }), {
          status: 403, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
    } else {
      if (!contributorId || contributorId !== user.id) {
        return new Response(JSON.stringify({ error: "contributorId must match signed-in user" }), {
          status: 403, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
      const { data: task, error: taskErr } = await admin
        .from("tasks")
        .select("claimed_by,status")
        .eq("id", taskId ?? "")
        .maybeSingle();
      if (taskErr || !task) {
        return new Response(JSON.stringify({ error: "Task not found" }), {
          status: 404, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
      const t = task as { claimed_by: string | null; status: string };
      if (t.claimed_by !== user.id) {
        return new Response(JSON.stringify({ error: "Not the assignee for this task" }), {
          status: 403, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
      if (!["claimed", "revision_requested"].includes(t.status)) {
        return new Response(
          JSON.stringify({ error: "Task is not in a state that allows upload" }),
          { status: 403, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
        );
      }
    }

    const safeName = sanitizeName(fileName);
    const timestamp = Date.now();
    const resolvedContentType = contentType && contentType !== "application/octet-stream"
      ? contentType
      : inferContentType(safeName);

    // Build R2 object key
    let objectKey: string;
    if (isPortfolio) {
      objectKey = `portfolio/${sanitizeName(userId ?? "")}/${timestamp}_${safeName}`;
    } else {
      objectKey = `deliverables/${sanitizeName(taskId ?? "")}/${sanitizeName(contributorId ?? "")}/${timestamp}_${safeName}`;
    }

    const expiresAt = Date.now() + URL_EXPIRY_SECS * 1000;

    // Generate PUT (upload) URL
    const { url: uploadUrl } = await buildPresignedUrl(objectKey, "PUT", resolvedContentType, expiresAt);

    return new Response(
      JSON.stringify({
        uploadUrl,
        assetUrl: `${R2_PUBLIC_BASE}/${objectKey}`,
        key: objectKey,
        expiresAt,
      }),
      { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("r2-upload-url error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Internal error" }),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }
});
