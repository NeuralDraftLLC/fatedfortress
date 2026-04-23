/**
 * supabase/functions/supabase-storage-upload/index.ts
 *
 * Generates presigned PUT URLs for Supabase Storage using the Storage API.
 * No external S3 signing needed — uses Supabase Storage's built-in signed URL.
 *
 * Key structure mirrors the old R2 setup:
 *   deliverables/{taskId}/{contributorId}/{timestamp}_{filename}   <- task uploads
 *   portfolio/{userId}/{timestamp}_{filename}                       <- profile portfolio
 *
 * No secrets required beyond SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
 */

import { createClient, type User, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

async function resolveAuth(req: Request) {
  const authHeader = req.headers.get("Authorization") ?? "";
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return { kind: "none" as const };
  const token = m[1];
  if (serviceKey && token === serviceKey) return { kind: "service" as const };
  if (!supabaseUrl || !anonKey) return { kind: "none" as const };
  const supabase = createClient(supabaseUrl, anonKey);
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return { kind: "none" as const };
  return { kind: "user" as const, user, token };
}

function serviceRoleClient(): SupabaseClient {
  if (!supabaseUrl || !serviceKey) throw new Error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set");
  return createClient(supabaseUrl, serviceKey);
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  const auth = await resolveAuth(req);
  if (auth.kind !== "user") {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
  const { user } = auth;
  const admin = serviceRoleClient();

  try {
    const body = await req.json();
    const {
      taskId, contributorId, userId, fileName, contentType,
      deliverableType = "file", isPortfolio = false,
    } = body as {
      taskId?: string; contributorId?: string; userId?: string;
      fileName?: string; contentType?: string;
      deliverableType?: string; isPortfolio?: boolean;
    };

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
        .from("tasks").select("claimed_by,status").eq("id", taskId ?? "").maybeSingle();
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
        return new Response(JSON.stringify({ error: "Task is not in a state that allows upload" }), {
          status: 403, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
    }

    const safeName = sanitizeName(fileName);
    const timestamp = Date.now();
    const resolvedContentType = contentType && contentType !== "application/octet-stream"
      ? contentType : inferContentType(safeName);

    let objectKey: string;
    if (isPortfolio) {
      objectKey = `portfolio/${sanitizeName(userId ?? "")}/${timestamp}_${safeName}`;
    } else {
      objectKey = `deliverables/${sanitizeName(taskId ?? "")}/${sanitizeName(contributorId ?? "")}/${timestamp}_${safeName}`;
    }

    const expiresAt = Math.floor(Date.now() / 1000) + 3600;

    const { data: signData, error: signErr } = await admin.storage
      .from("fortress").createSignedUploadUrl(objectKey);

    if (signErr || !signData?.url) {
      return new Response(JSON.stringify({ error: signErr?.message || "Failed to create signed URL" }), {
        status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const assetUrl = `${supabaseUrl}/storage/v1/object/public/fortress/${objectKey}`;

    return new Response(
      JSON.stringify({ uploadUrl: signData.url, assetUrl, key: objectKey, expiresAt: expiresAt * 1000 }),
      { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("supabase-storage-upload error:", err);
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : "Internal error" }), {
      status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});