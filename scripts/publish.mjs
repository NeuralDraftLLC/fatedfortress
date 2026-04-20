#!/usr/bin/env node
/**
 * scripts/publish.mjs — here.now deployment script.
 *
 * FIXES APPLIED:
 *   B4: Refactored createZip() into two clean passes:
 *       Pass 1 — write all local file entries, record per-file offsets and CRC values.
 *       Pass 2 — write central directory using the offsets recorded in Pass 1.
 *       Previously, the CD loop referenced `header` from the outer scope (wrong file's
 *       header) and re-accumulated cdOffset on top of already-accumulated values,
 *       producing incorrect relative offsets for every file after the first.
 *
 *   Additional: makeCrc32Table() hoisted to module scope (was called per-file).
 *               Each file's data is read once and reused across both passes.
 *
 * Usage: HERENOW_TOKEN=… node scripts/publish.mjs [--staging]
 */

import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const HERE_NOW_API = "https://api.here.now/v1";
const HERE_NOW_TOKEN = process.env.HERENOW_TOKEN ?? "";

// ✅ FIX B4: Hoisted to module scope — built once, reused for every file's CRC.
const CRC32_TABLE = makeCrc32Table();

async function build() {
  console.log("[publish] Building web app...");
  const { execSync } = await import("child_process");
  try {
    // Produces apps/web/dist — the only input to createZip (static deploy bundle).
    execSync("npx vite build", {
      cwd: join(ROOT, "apps/web"),
      stdio: "inherit",
    });
    console.log("[publish] Build complete");
  } catch {
    console.error("[publish] Build failed");
    process.exit(1);
  }
}

function collectFiles(dir, prefix = "") {
  const entries = readdirSync(dir);
  const files = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const relPath = prefix ? `${prefix}/${entry}` : entry;
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...collectFiles(fullPath, relPath));
    } else {
      files.push({ path: relPath, fullPath });
    }
  }
  return files;
}

function makeCrc32Table() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
}

function crc32(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * ✅ FIX B4: Rewritten with two clean passes.
 *
 * Pass 1: For each file, build the local file header + data, push to `parts`,
 *         and record the file's { localHeaderOffset, nameBytes, data, crc }
 *         for use in Pass 2.
 *
 * Pass 2: Build central directory entries using the recorded offsets from Pass 1.
 *         `cdOffset` is set once to the total byte length after Pass 1 —
 *         it is never mutated inside the CD loop.
 */
function createZip(distPath) {
  console.log("[publish] Creating ZIP archive...");
  const files = collectFiles(distPath);
  console.log(`[publish] Found ${files.length} files`);

  const parts = [];
  // Metadata recorded during Pass 1 for use in Pass 2
  const fileRecords = [];
  let currentOffset = 0;

  // ── Pass 1: Local file headers + data ──────────────────────────────────────
  for (const file of files) {
    // ✅ FIX B4: Each file's data is read exactly once and cached in fileRecords.
    const data = readFileSync(file.fullPath);
    const nameBytes = Buffer.from(file.path, "utf8");
    const nameLen = nameBytes.length;
    const fileCrc = crc32(data);

    const localHeader = Buffer.alloc(30 + nameLen);
    localHeader.writeUInt32LE(0x04034b50, 0);   // local file header signature
    localHeader.writeUInt16LE(20, 4);            // version needed (2.0)
    localHeader.writeUInt16LE(0, 6);             // general purpose bit flag
    localHeader.writeUInt16LE(0, 8);             // compression method (stored)
    localHeader.writeUInt16LE(0, 10);            // last mod time
    localHeader.writeUInt16LE(0, 12);            // last mod date
    localHeader.writeUInt32LE(fileCrc, 14);      // CRC-32
    localHeader.writeUInt32LE(data.length, 18);  // compressed size
    localHeader.writeUInt32LE(data.length, 22);  // uncompressed size
    localHeader.writeUInt16LE(nameLen, 26);      // file name length
    localHeader.writeUInt16LE(0, 28);            // extra field length
    nameBytes.copy(localHeader, 30);

    // Record the byte offset of this local file header BEFORE pushing
    const localHeaderOffset = currentOffset;

    parts.push(localHeader, data);
    currentOffset += localHeader.length + data.length;

    // Save everything needed for Pass 2 — no second readFileSync call needed
    fileRecords.push({ nameBytes, data, fileCrc, localHeaderOffset });
  }

  // ── Pass 2: Central directory ───────────────────────────────────────────────
  // ✅ FIX B4: cdStartOffset is set once from accumulated Pass 1 output.
  //    It is never modified inside this loop. Each CD entry reads its
  //    localHeaderOffset from the record captured in Pass 1.
  const cdStartOffset = currentOffset;
  const cdEntries = [];

  for (const record of fileRecords) {
    const { nameBytes, data, fileCrc, localHeaderOffset } = record;
    const nameLen = nameBytes.length;

    const cdEntry = Buffer.alloc(46 + nameLen);
    cdEntry.writeUInt32LE(0x02014b50, 0);            // central directory signature
    cdEntry.writeUInt16LE(20, 4);                     // version made by
    cdEntry.writeUInt16LE(20, 6);                     // version needed
    cdEntry.writeUInt16LE(0, 8);                      // general purpose bit flag
    cdEntry.writeUInt16LE(0, 10);                     // compression method (stored)
    cdEntry.writeUInt16LE(0, 12);                     // last mod time
    cdEntry.writeUInt16LE(0, 14);                     // last mod date
    cdEntry.writeUInt32LE(fileCrc, 16);               // CRC-32
    cdEntry.writeUInt32LE(data.length, 20);           // compressed size
    cdEntry.writeUInt32LE(data.length, 24);           // uncompressed size
    cdEntry.writeUInt16LE(nameLen, 28);               // file name length
    cdEntry.writeUInt16LE(0, 30);                     // extra field length
    cdEntry.writeUInt16LE(0, 32);                     // file comment length
    cdEntry.writeUInt16LE(0, 34);                     // disk number start
    cdEntry.writeUInt16LE(0, 36);                     // internal file attributes
    cdEntry.writeUInt32LE(0, 38);                     // external file attributes
    cdEntry.writeUInt32LE(localHeaderOffset, 42);     // ✅ offset of local file header
    nameBytes.copy(cdEntry, 46);

    cdEntries.push(cdEntry);
  }

  const cdData = Buffer.concat(cdEntries);
  const cdSize = cdData.length;

  // EOCD links the contiguous bytes: [...localRecords..., cdData] so unzip can
  // find CD start via cdStartOffset (PK\x05\x06 trailer per APPNOTE.TXT).
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);          // end of central directory signature
  eocd.writeUInt16LE(0, 4);                    // disk number
  eocd.writeUInt16LE(0, 6);                    // disk with start of CD
  eocd.writeUInt16LE(files.length, 8);         // number of CD entries on this disk
  eocd.writeUInt16LE(files.length, 10);        // total number of CD entries
  eocd.writeUInt32LE(cdSize, 12);             // size of central directory
  eocd.writeUInt32LE(cdStartOffset, 16);      // offset of start of CD
  eocd.writeUInt16LE(0, 20);                   // comment length

  // Final layout: local headers+data | central directory | end-of-CD record
  const zip = Buffer.concat([...parts, cdData, eocd]);
  console.log(`[publish] ZIP: ${files.length} files, ${(zip.length / 1024).toFixed(1)} KB`);
  return zip;
}

async function publishToHereNow(zipBuffer) {
  if (!HERE_NOW_TOKEN) {
    console.warn("[publish] HERENOW_TOKEN not set — skipping upload");
    return null;
  }

  console.log("[publish] Uploading to here.now...");
  const response = await fetch(`${HERE_NOW_API}/publish`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${HERE_NOW_TOKEN}`,
      "Content-Type": "application/zip",
      "X-Client": "fatedfortress",
      "X-App-Name": "fatedfortress",
    },
    body: zipBuffer,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`here.now upload failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  return data.url ?? data.publishUrl ?? null;
}

async function main() {
  const env = process.argv.includes("--staging") ? "staging" : "production";
  console.log(`[publish] Starting publish (${env})...`);

  await build();

  const distPath = join(ROOT, "apps/web/dist");
  if (!existsSync(distPath)) {
    console.error(`[publish] dist/ not found at ${distPath}`);
    process.exit(1);
  }

  const zipBuffer = createZip(distPath);
  const url = await publishToHereNow(zipBuffer);

  if (url) {
    console.log(`\n✅ Published! URL: ${url}`);
  } else {
    console.log("\n⚠️  Skipped upload (no HERENOW_TOKEN).");
    console.log("   To deploy: set HERENOW_TOKEN and run again.");
  }
}

main().catch(console.error);
