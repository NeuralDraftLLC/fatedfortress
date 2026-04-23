/**
 * apps/web/src/net/storage.ts — Supabase Storage presigned URL generation for uploads.
 *
 * Uses Supabase Storage with signed upload URLs so large files never
 * pass through the app server. Extends archive.ts which handles OPFS.
 */

import { getSupabase } from "../auth/index.js";
import { getMyProfile } from "../auth/index.js";
import type { DeliverableType } from "@fatedfortress/protocol";

export type { DeliverableType };

// ---------------------------------------------------------------------------
// Presigned URL generation
// ---------------------------------------------------------------------------

export interface PresignedUploadUrl {
  uploadUrl: string;   // PUT URL to upload the file
  assetUrl: string;     // Final public URL after upload
  key: string;          // R2 object key
  expiresAt: number;    // Unix timestamp when upload URL expires
}

/**
 * Request a presigned PUT URL for uploading a deliverable to Supabase Storage.
 * Returns { uploadUrl, assetUrl, key, expiresAt }.
 */
export async function createPresignedUploadUrl(
  taskId: string,
  contributorId: string,
  fileName: string,
  contentType: string,
  deliverableType: DeliverableType
): Promise<PresignedUploadUrl> {
  const { data, error } = await getSupabase()
    .functions
    .invoke("supabase-storage-upload", {
      body: { taskId, contributorId, fileName, contentType, deliverableType },
    });

  if (error || !data?.uploadUrl) {
    throw new Error(data?.error || "Failed to generate presigned upload URL");
  }

  return data as PresignedUploadUrl;
}

/**
 * Upload a file to Supabase Storage using a presigned URL.
 * Returns the permanent asset URL on success.
 */
export async function uploadToR2(
  presigned: PresignedUploadUrl,
  file: File,
  onProgress?: (pct: number) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    });

    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(presigned.assetUrl);
      } else {
        reject(new Error(`Supabase Storage upload failed: ${xhr.status} ${xhr.statusText}`));
      }
    });

    xhr.addEventListener("error", () => reject(new Error("Supabase Storage upload network error")));

    xhr.open("PUT", presigned.uploadUrl);
    xhr.setRequestHeader("Content-Type", file.type);
    xhr.send(file);
  });
}

/**
 * Validate a file before upload (size + MIME type).
 */
export function validateFile(
  file: File,
  maxSizeMb = 100
): { ok: true } | { ok: false; error: string } {
  if (file.size === 0) {
    return { ok: false, error: "File is empty" };
  }
  if (file.size > maxSizeMb * 1024 * 1024) {
    return { ok: false, error: `File exceeds ${maxSizeMb}MB limit` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Portfolio uploads (for profile page)
// ---------------------------------------------------------------------------

export async function createPortfolioUploadUrl(
  userId: string,
  fileName: string,
  contentType: string
): Promise<PresignedUploadUrl> {
  const { data, error } = await getSupabase()
    .functions
    .invoke("supabase-storage-upload", {
      body: {
        isPortfolio: true,
        userId,
        fileName,
        contentType,
        deliverableType: "file" as const,
      },
    });

  if (error || !data?.uploadUrl) {
    throw new Error(data?.error || "Failed to generate portfolio upload URL");
  }

  return data as PresignedUploadUrl;
}
