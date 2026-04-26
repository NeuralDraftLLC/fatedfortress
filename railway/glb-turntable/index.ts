/**
 * railway/glb-turntable/index.ts
 *
 * Receives raw GLB binary (POST), renders a 72-frame turntable MP4,
 * returns { success, data: number[], contentType }. No submodules.
 */
import http from "node:http";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { WebGLRenderTarget } from "three";
import { Muxer, ArrayBufferTarget } from "mp4-muxer";

const PORT = 3000;

// Perplexity: Helper — accumulate raw body chunks into a single Buffer
function collectBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Perplexity: Render 72 frames (360° turntable) from a Three.js scene to BGRA Uint8Arrays
function renderFrames(scene: import("three").Scene, renderer: import("three").WebGLRenderer): Uint8Array[] {
  const frames: Uint8Array[] = [];
  const W = 720, H = 720;

  for (let i = 0; i < 72; i++) {
    // Perplexity: Rotate 5° per frame around Y axis
    scene.rotation.y = (i / 72) * Math.PI * 2;
    renderer.render(scene, scene.children.find((c) => c.type === "PerspectiveCamera") as import("three").Camera);
    const pixels = new Uint8Array(W * H * 4);
    renderer.readRenderTargetPixels(new WebGLRenderTarget(W, H), 0, 0, W, H, pixels);
    frames.push(pixels);
  }
  return frames;
}

// Perplexity: Encode BGRA frame arrays into an MP4 using mp4-muxer
async function encodeMP4(frames: Uint8Array[], fps = 30): Promise<Uint8Array> {
  const W = 720, H = 720;
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "avc", width: W, height: H },
    fastStart: "in-memory",
  });

  const ctx = new (await import("mp4-muxer")).VideoFrameWriterContext(muxer, { timestampIncrement: 1000 / fps });
  for (const pixels of frames) {
    await ctx.addFrame(new Uint8Array(pixels));
  }
  ctx.finalize();
  return new Uint8Array(muxer.target.buffer);
}

// Perplexity: Full pipeline: parse GLB → render frames → encode MP4 → return bytes
async function processGLB(glbBuffer: Buffer): Promise<{ data: number[]; contentType: string }> {
  const loader = new GLTFLoader();

  // Perplexity: Parse GLB binary directly (no URL / no file system needed)
  const { scene } = await loader.parseAsync(glbBuffer, "");

  // Perplexity: Headless WebGL renderer — alpha for transparent background
  const renderer = new (await import("three")).WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(720, 720);

  // Perplexity: Center model and add basic lighting
  const box = new (await import("three")).Box3().setFromObject(scene);
  const center = box.getCenter(new (await import("three")).Vector3());
  scene.position.sub(center);
  scene.add(new (await import("three")).AmbientLight(0xffffff, 1.2));
  const dirLight = new (await import("three")).DirectionalLight(0xffffff, 1.0);
  dirLight.position.set(1, 2, 1);
  scene.add(dirLight);

  const frames = renderFrames(scene, renderer);
  renderer.dispose();
  const mp4 = await encodeMP4(frames);

  // Perplexity: Return MP4 bytes as JSON-safe number[] — asset-sanitizer reconstructs
  return { data: Array.from(mp4), contentType: "video/mp4" };
}

http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: false, error: "Method not allowed" }));
    return;
  }

  try {
    const glbBuffer = await collectBody(req);
    if (glbBuffer.length === 0) throw new Error("Empty GLB body");

    // Perplexity: GLB → turntable frames → MP4 bytes
    const { data, contentType } = await processGLB(glbBuffer);

    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ success: true, data, contentType }));
  } catch (err) {
    console.error("glb-turntable error:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) }));
  }
}).listen(PORT, () => console.log(`glb-turntable listening on ${PORT}`));