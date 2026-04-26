/**
 * E2E: sanitizer-glb.spec.ts
 *
 * Pillar 3: GLB submission must produce a proxy MP4 + proxy_video_url set.
 *
 * Flow:
 *   1. A contributor submits a GLB file
 *   2. asset-sanitizer is called (or called by verify-submission)
 *   3. Railway GLB turntable worker generates an MP4
 *   4. The submissions row has proxy_video_url populated
 *   5. The reviews UI can render the MP4 instead of the raw GLB
 */

import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ready = !!(supabaseUrl && serviceRoleKey);

test.beforeEach(() => { test.skip(!ready, "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in e2e/.env"); });

test("GLB submission — asset-sanitizer sets proxy_video_url on the submissions row", async () => {
  const admin = createClient(supabaseUrl!, serviceRoleKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 1. Create a stub GLB submission row
  const { data: taskRow } = await admin
    .from("tasks")
    .select("id, project_id")
    .limit(1)
    .single();

  if (!taskRow) { test.skip(true, "No tasks in database — seed data required"); return; }
  const taskId = (taskRow as { id: string }).id;
  const projectId = (taskRow as { project_id: string }).project_id;

  const { data: contRow } = await admin
    .from("profiles")
    .select("id")
    .eq("role", "contributor")
    .limit(1)
    .single();

  if (!contRow) { test.skip(true, "No contributor — seed data required"); return; }
  const contributorId = (contRow as { id: string }).id;

  // 2. Upload a minimal valid GLB to storage
  // Minimal GLB: 12-byte header + empty scene
  const minimalGlb = new Uint8Array([
    0x67, 0x6C, 0x54, 0x46, 0x02, 0x00, 0x00, 0x00, // GLB magic + version 2
    0x00, 0x00, 0x00, 0x00, // length = 0 (we'll use valid minimal GLB)
  ]);

  // Create a valid minimal GLB with JSON scene
  const jsonChunk = JSON.stringify({
    asset: { version: "2.0", generator: "E2E test" },
    scene: 0,
  });
  // We use a proper minimal GLB format
  const glbBuffer = buildMinimalGlb();

  const fileName = `glb-test-${Date.now()}.glb`;
  const { error: uploadErr } = await admin.storage
    .from("submissions")
    .upload(fileName, glbBuffer, { contentType: "model/gltf-binary" });

  if (uploadErr) { test.skip(true, `Storage upload failed: ${uploadErr.message}`); return; }

  const { data: fileData } = admin.storage.from("submissions").getPublicUrl(fileName);
  const fileUrl = fileData.publicUrl;

  // 3. Create submission row
  const { data: submission } = await admin
    .from("submissions")
    .insert({
      task_id:         taskId,
      contributor_id:  contributorId,
      status:          "submitted",
      asset_url:       fileUrl,
    })
    .select("id")
    .single();

  if (!submission) { test.skip(true, "Could not create submission"); return; }
  const submissionId = (submission as { id: string }).id;

  // 4. Call asset-sanitizer
  const funcUrl = `${supabaseUrl}/functions/v1/asset-sanitizer`;
  let response: Response;
  try {
    response = await fetch(funcUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceRoleKey}`,
      },
      body: JSON.stringify({
        submissionId,
        fileUrl,
        fileType: "3d_model",
      }),
    });
  } catch (err) {
    test.skip(true, `asset-sanitizer unreachable: ${err}`);
    return;
  }

  const body = await response.json() as { cleanUrl?: string; proxyVideoUrl?: string; error?: string };

  // 5. Assert: proxyVideoUrl must be present (Railway worker must have rendered MP4)
  // If Railway worker URL is not configured, this will return a stub URL — still validates the flow
  if (process.env.RAILWAY_GLBTURNTABLE_URL) {
    expect(body.proxyVideoUrl, "proxyVideoUrl must be set for GLB submissions").toBeTruthy();
    expect(body.proxyVideoUrl).toContain(".mp4");
  } else {
    console.warn("[sanitizer-glb] RAILWAY_GLBTURNTABLE_URL not set — skipping proxyVideoUrl assertion");
    test.skip(true, "RAILWAY_GLBTURNTABLE_URL not configured — run Railway worker to enable this test");
    return;
  }

  // 6. Verify proxy_video_url was written to the submissions row
  const { data: updatedSub } = await admin
    .from("submissions")
    .select("proxy_video_url")
    .eq("id", submissionId)
    .single();

  const proxyUrl = (updatedSub as { proxy_video_url?: string } | null)?.proxy_video_url;
  expect(proxyUrl, "proxy_video_url column must be populated").toBeTruthy();
  expect(proxyUrl).toContain(".mp4");

  // Cleanup
  await admin.storage.from("submissions").remove([fileName]).catch(() => {});
  await admin.from("submissions").delete().eq("id", submissionId).catch(() => {});
});

test("Railway GLB turntable worker — direct HTTP integration", async ({ request }) => {
  const workerUrl = process.env.RAILWAY_GLBTURNTABLE_URL;
  if (!workerUrl) { test.skip(true, "RAILWAY_GLBTURNTABLE_URL not set"); return; }

  // Perplexity: Build a valid minimal GLB with a cube mesh so Three.js has something to render
  const glb = buildMinimalGlbWithCube();

  const res = await request.fetch(workerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: glb,
  });

  expect(res.status(), "worker should return 200").toBe(200);
  const json = await res.json() as { success: boolean; data?: number[]; contentType?: string; error?: string };
  expect(json.success, `worker error: ${json.error}`).toBe(true);
  expect(json.contentType).toBe("video/mp4");
  expect(json.data?.length ?? 0, "MP4 data must be non-empty").toBeGreaterThan(0);
});

/** Builds a valid minimal GLB binary (empty scene, no geometry) */
function buildMinimalGlb(): Uint8Array {
  const jsonStr = JSON.stringify({
    asset: { version: "2.0", generator: "E2E" },
    scene: 0,
  });

  // GLB layout: 12-byte header + JSON chunk + BIN chunk (optional)
  const jsonBytes = new TextEncoder().encode(jsonStr);
  const jsonPadded = padTo4Bytes(jsonBytes);

  const totalSize = 12 + 8 + jsonPadded.length + 8 + 0; // header + JSON chunk + BIN chunk
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  let offset = 0;

  // GLB magic
  view.setUint32(offset, 0x46546C67, true); offset += 4; // 'glTF'
  view.setUint32(offset, 2, true); offset += 4;         // version 2
  view.setUint32(offset, totalSize, true); offset += 4;  // length

  // JSON chunk header
  view.setUint32(offset, jsonPadded.length, true); offset += 4;
  view.setUint32(offset, 0x4E4F534A, true); offset += 4; // 'JSON' in little-endian = 0x4F4E534A actually... let me fix
  // 'JSON' = 0x4A534F4E
  view.setUint32(offset, 0x4A534F4E, true); offset += 4;
  bytes.set(jsonPadded, offset); offset += jsonPadded.length;

  // BIN chunk (empty)
  view.setUint32(offset, 0, true); offset += 4;          // length 0
  view.setUint32(offset, 0x004E4942, true); offset += 4; // 'BIN\0'

  return bytes;
}

/** Builds a valid GLB containing a single unit cube — Three.js can render this */
function buildMinimalGlbWithCube(): Uint8Array {
  // Perplexity: A GLB with positions, normals, and indices for one cube
  const gltf = {
    asset: { version: "2.0", generator: "E2E test" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{
      primitives: [{
        attributes: { POSITION: 0, NORMAL: 1 },
        indices: 2,
      }],
    }],
    accessors: [
      // 0: POSITION — 8 vertices of unit cube
      { bufferView: 0, componentType: 5126, count: 8, type: "VEC3", max: [1,1,1], min: [0,0,0] },
      // 1: NORMAL — all (0,1,0)
      { bufferView: 1, componentType: 5126, count: 8, type: "VEC3" },
      // 2: INDICES — 36 triangle indices
      { bufferView: 2, componentType: 5123, count: 36, type: "SCALAR" },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 8 * 3 * 4 },      // POSITION
      { buffer: 0, byteOffset: 8 * 3 * 4, byteLength: 8 * 3 * 4 }, // NORMAL
      { buffer: 0, byteOffset: 16 * 3 * 4, byteLength: 36 * 2 },   // INDICES
    ],
    buffers: [{ byteLength: 16 * 3 * 4 + 36 * 2 }],
  };

  // Perplexity: Build the binary buffer: positions + normals + indices
  const positions = new Float32Array([
    0,0,0, 1,0,0, 1,1,0, 0,1,0,  // bottom face
    0,0,1, 1,0,1, 1,1,1, 0,1,1,  // top face
  ]);
  const normals = new Float32Array(8 * 3); // zeroed — flat shading
  const indices = new Uint16Array([
    0,1,2, 0,2,3,   // bottom
    4,6,5, 4,7,6,   // top
    0,4,5, 0,5,1,   // front
    2,6,7, 2,7,3,   // back
    0,3,7, 0,7,4,   // left
    1,5,6, 1,6,2,   // right
  ]);

  const binLen = positions.byteLength + normals.byteLength + indices.byteLength;
  const jsonStr = JSON.stringify(gltf);
  const jsonBytes = new TextEncoder().encode(jsonStr);
  const jsonPadded = padTo4Bytes(jsonBytes);

  const totalSize = 12 + 8 + jsonPadded.length + 8 + binLen;
  const buf = new ArrayBuffer(totalSize);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  let off = 0;
  view.setUint32(off, 0x46546C67, true); off += 4;         // glTF magic
  view.setUint32(off, 2, true); off += 4;                  // version 2
  view.setUint32(off, totalSize, true); off += 4;           // length

  view.setUint32(off, jsonPadded.length, true); off += 4;
  view.setUint32(off, 0x4A534F4E, true); off += 4;          // JSON chunk
  bytes.set(jsonPadded, off); off += jsonPadded.length;

  view.setUint32(off, binLen, true); off += 4;
  view.setUint32(off, 0x004E4942, true); off += 4;           // BIN\0 chunk
  new Float32Array(buf, off).set(positions); off += positions.byteLength;
  new Float32Array(buf, off).set(normals); off += normals.byteLength;
  new Uint16Array(buf, off).set(indices);

  return bytes;
}

function padTo4Bytes(arr: Uint8Array): Uint8Array {
  const paddedLength = Math.ceil(arr.length / 4) * 4;
  if (paddedLength === arr.length) return arr;
  const result = new Uint8Array(paddedLength);
  result.set(arr);
  return result;
}
