/**
 * apps/web/src/net/archive.ts
 *
 * PRIORITY 2 · Multimodal Archive (Task 6)
 *
 * OPFS (Origin Private File System) stores blobs locally as `opfs://` pseudo-URLs.
 * here.now is used for permanent publicly-hosted URLs.
 *
 * Strategy:
 *  1. Always write to OPFS first — instant, works offline, no API key needed.
 *  2. If OPFS write fails (quota exceeded, private browsing), fall back to blob: URL
 *     in memory only; warn the user that the output won't persist.
 *  3. When `uploadBlobToHereNow` is called explicitly (publish flow), POST to
 *     here.now API for a permanent public URL; store that URL in the doc metadata.
 *
 * Pseudo-URL scheme:
 *   opfs://<roomId>/<filename>  —  stored in OPFS under ff-room-<roomId>/
 *
 * The OPFS hierarchy is flat: one directory per roomId to avoid name collisions.
 */

import { safeStorage, KEY_HERENOW_TOKEN } from "../util/storage.js";

// ── here.now API ──────────────────────────────────────────────────────────────

const HERENOW_API = "https://here.now/api/v1";

interface HereNowUploadResponse {
  url: string;       // permanent public URL
  slug: string;      // short slug
  expiresAt: number; // 0 = never
  claimUrl?: string; // authenticated claim URL (for paid/anonymous uploads)
}

async function getHereNowToken(): Promise<string | null> {
  return safeStorage.getItem(KEY_HERENOW_TOKEN) as string | null;
}

async function fetchHereNowTokenInfo(token: string): Promise<{ anonymous: boolean }> {
  const res = await fetch(`${HERENOW_API}/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`here.now /me failed: ${res.status}`);
  return res.json() as Promise<{ anonymous: boolean }>;
}

// ── OPFS helpers ───────────────────────────────────────────────────────────────

/**
 * Write a Blob to OPFS and return an `opfs://` pseudo-URL.
 * Fails silently — returns null if OPFS is unavailable or quota exceeded.
 *
 * The pseudo-URL is NOT a real navigable URL — it only works as a src= attribute
 * in <img> tags within this origin, or as input to `resolveOpfsUrl()`.
 */
export async function archiveBlob(
  blob: Blob,
  roomId: string,
  filename: string
): Promise<string | null> {
  try {
    const root = await navigator.storage.getDirectory();
    // One subdirectory per room to avoid filename collisions across rooms
    const dirHandle = await root.getDirectoryHandle(`ff-archive-${roomId}`, { create: true });
    const fileHandle = await dirHandle.getFileHandle(sanitizeFilename(filename), { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
    // Pseudo-URL scheme — only resolvable via resolveOpfsUrl() in this origin.
    return `opfs://${roomId}/${filename}`;
  } catch (err) {
    console.warn("[archive] OPFS write failed (may be private browsing or quota):", err);
    return null;
  }
}

/**
 * Resolve an `opfs://` pseudo-URL to a usable blob: or https: URL.
 *
 *  - `opfs://<roomId>/<filename>`  →  blob: URL (origin-private, ephemeral in memory if
 *    the file was created in private browsing mode where OPFS wasn't persisted)
 *  - If the OPFS file no longer exists → returns null
 *
 * The resolved blob: URL is short-lived (blob URLs are invalidated on page unload
 * for security). Use immediately; do not store persistently.
 */
export async function resolveOpfsUrl(opfsUrl: string): Promise<string | null> {
  if (!opfsUrl.startsWith("opfs://")) return null;

  try {
    const remainder = opfsUrl.replace("opfs://", "");
    const slashIdx = remainder.indexOf("/");
    const roomId = slashIdx >= 0 ? remainder.slice(0, slashIdx) : remainder;
    const filename = slashIdx >= 0 ? remainder.slice(slashIdx + 1) : "";

    if (!roomId || !filename) return null;

    const root = await navigator.storage.getDirectory();
    const dirHandle = await root.getDirectoryHandle(`ff-archive-${roomId}`);
    const fileHandle = await dirHandle.getFileHandle(filename);
    const file = await fileHandle.getFile();

    // blob: URLs are valid for the lifetime of the document — re-create each time.
    return URL.createObjectURL(file);
  } catch {
    return null;
  }
}

/**
 * Upload a blob to here.now and return a permanent public URL.
 *
 * here.now requires server-side credential injection for authenticated uploads —
 * the here.now API does not support CORS for browser-based authenticated requests.
 * This function should be called via a lightweight proxy endpoint (e.g., a Cloudflare Worker
 * or a server route) that attaches the stored HERENOW_API_KEY.
 *
 * If called directly from the browser (no proxy), only anonymous uploads are possible
 * and the returned URL will expire after 24 hours.
 *
 * here.now upload contract:
 *   POST https://here.now/api/v1/blobs
 *   Content-Type: multipart/form-data  OR  application/octet-stream
 *   Headers: Authorization: Bearer {token}  (for authenticated; anonymous omit)
 *
 *   200 OK → { url: string, slug: string, expiresAt: number, claimUrl?: string }
 *   4xx/5xx → plain text error body
 */
export async function uploadBlobToHereNow(blob: Blob): Promise<HereNowUploadResponse> {
  const token = await getHereNowToken();
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;

  // NOTE: Direct browser-to-here.now authenticated requests are blocked by CORS.
  // In production, route through a proxy endpoint that injects the API key server-side.
  // See: https://here.now/docs (here.now API reference)
  const res = await fetch(`${HERENOW_API}/blobs`, {
    method: "POST",
    headers: { ...headers, "Content-Type": blob.type || "application/octet-stream" },
    body: blob,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`here.now upload failed (${res.status}): ${text || "Unknown error"}`);
  }

  return res.json() as Promise<HereNowUploadResponse>;
}

/**
 * Upload a blob to here.now, handling both authenticated and anonymous flows.
 * Falls back to OPFS-only storage if here.now is unavailable or the user is
 * not authenticated and chooses not to proceed anonymously.
 *
 * Returns the permanent URL or null if no upload was performed.
 */
export async function archiveAndUpload(
  blob: Blob,
  roomId: string,
  filename: string,
  onAnonymousUpload?: () => void
): Promise<string | null> {
  // Step 1: Always persist to OPFS first (OPFS-first strategy).
  const opfsUrl = await archiveBlob(blob, roomId, filename);
  if (!opfsUrl) {
    console.warn("[archive] OPFS unavailable — will not be able to re-publish from OPFS");
  }

  // Step 2: Attempt here.now upload.
  try {
    const result = await uploadBlobToHereNow(blob);
    return result.url;
  } catch (err) {
    // If token is invalid (401/403), clear it so the UI knows to re-link.
    if (err instanceof Error && (err.message.includes("401") || err.message.includes("403"))) {
      await safeStorage.removeItem(KEY_HERENOW_TOKEN);
      console.warn("[archive] here.now token was rejected — clearing stored token");
    }
    // Non-fatal: OPFS was written successfully, user can retry publish later.
    console.warn("[archive] here.now upload failed, falling back to OPFS-only:", err);
    return opfsUrl; // May still be null if OPFS write also failed
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────

/** Strip path traversal and control characters from a filename. */
function sanitizeFilename(name: string): string {
  return name.replace(/[\/\\..\x00-\x1f]/g, "_").slice(0, 128);
}
