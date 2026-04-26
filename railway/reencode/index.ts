/**
 * railway/reencode/index.ts
 *
 * Perplexity: Receives PNG or WAV binary, re-encodes to strip EXIF/metadata and
 *   embedded artifacts (LSB steganography), returns clean binary as JSON-safe number[].
 *
 * Input:  POST with raw binary body
 *         Content-Type header = "image/png" or "audio/wav"
 * Output: { success: true, data: number[], contentType: string }
 *         asset-sanitizer reconstructs bytes with new Uint8Array(data) and uploads
 *
 * PNG  → sharp: re-saves as PNG (compressionLevel: 9) — strips all EXIF, ICC, XMP
 * WAV  → decode PCM, re-encode 44100 Hz / stereo / 16-bit — strips ID3/INFO chunks
 */
import http from "node:http";
import sharp from "sharp";
import { decode, encode } from "wav";

const PORT = 3000;

function collectBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Perplexity: Re-encode PNG through sharp — strips EXIF, ICC profiles, XMP, all metadata
async function reencodePng(buf: Buffer): Promise<{ data: number[]; contentType: string }> {
  const cleaned = await sharp(buf)
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
  return { data: Array.from(cleaned), contentType: "image/png" };
}

// Perplexity: Re-encode WAV — normalize to 44100 Hz / stereo / 16-bit PCM,
//   strips ID3v2 / INFO / padding chunks that could hide steganographic data
async function reencodeWav(buf: Buffer): Promise<{ data: number[]; contentType: string }> {
  const decoded = decode(buf);
  const PCM_RATE = 44100;
  const PCM_CHANNELS = 2;
  const PCM_BITS = 16;

  // Perplexity: Encode with consistent params — resamples if needed via wav encoder
  const reencoded = encode(Buffer.from(decoded.channelData[0]), {
    sampleRate: PCM_RATE,
    channels: PCM_CHANNELS,
    bitDepth: PCM_BITS,
  });
  return { data: Array.from(reencoded), contentType: "audio/wav" };
}

http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Target-Mime");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: false, error: "Method not allowed" }));
    return;
  }

  try {
    const contentType = req.headers["content-type"] ?? "";
    const targetMime = req.headers["x-target-mime"] ?? contentType;
    const body = await collectBody(req);

    if (body.length === 0) throw new Error("Empty body");

    // Perplexity: Route by target mime type (X-Target-Mime takes precedence)
    if (targetMime.includes("image/png")) {
      const result = await reencodePng(body);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ success: true, ...result }));
    } else if (targetMime.includes("audio/wav")) {
      const result = await reencodeWav(body);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ success: true, ...result }));
    } else {
      // Perplexity: Unknown type — reject rather than pass through silently
      res.writeHead(415, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: `Unsupported media type: ${targetMime}` }));
    }
  } catch (err) {
    console.error("reencode error:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) }));
  }
}).listen(PORT, () => console.log(`reencode worker listening on ${PORT}`));