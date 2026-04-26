/**
 * Railway worker entry point: glb-turntable/index.ts
 *
 * Receives GLB binary via POST, renders an MP4 turntable video,
 * uploads to Supabase Storage, returns the public URL.
 *
 * NOTE: This is a scaffold. Full implementation requires:
 *   - gl npm package (headless WebGL) or @sparticuz/chromium
 *   - mp4-muxer for MP4 encoding
 *   - @supabase/supabase-js for storage uploads
 *
 * See README.md for full architecture notes.
 */

import { createClient } from "@supabase/supabase-js";

const STORAGE_BUCKET = process.env.STORAGE_BUCKET ?? "submissions";

interface TurntableResult {
  videoUrl: string;
  frameCount: number;
  durationMs: number;
}

/**
 * Renders a GLB buffer as an MP4 turntable.
 * Replace this stub with actual Three.js + MP4 muxer implementation.
 */
async function renderGLBTurntable(glbBuffer: Buffer, outputFilename: string): Promise<TurntableResult> {
  // TODO: implement with gl + Three.js + mp4-muxer
  // For now, echo back a placeholder response so the pipeline can be tested
  console.warn("GLB turntable: using stub implementation — replace before production");

  const stubUrl = `https://placeholder.supabase.co/storage/v1/object/public/${STORAGE_BUCKET}/turntable_${outputFilename}.mp4`;
  return {
    videoUrl: stubUrl,
    frameCount: 120,
    durationMs: 2000,
  };
}

export { renderGLBTurntable };

// Railway worker HTTP handler
export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const contentType = req.headers.get("content-type") ?? "";

  let glbBuffer: ArrayBuffer;
  let filename = "model.glb";

  if (contentType.includes("application/octet") || contentType.includes("model/gltf")) {
    glbBuffer = await req.arrayBuffer();
  } else {
    // Assume multipart or JSON { fileUrl: string }
    try {
      const json = await req.json() as { fileUrl?: string; filename?: string };
      if (!json.fileUrl) return new Response("fileUrl required", { status: 400 });
      const fileRes = await fetch(json.fileUrl);
      glbBuffer = await fileRes.arrayBuffer();
      filename = json.filename ?? "model.glb";
    } catch {
      return new Response("Invalid request body", { status: 400 });
    }
  }

  try {
    const result = await renderGLBTurntable(Buffer.from(glbBuffer), filename);
    return Response.json(result);
  } catch (err) {
    console.error("Turntable render error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500 }
    );
  }
}
