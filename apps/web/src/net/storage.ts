/**
 * apps/web/src/net/storage.ts — Supabase Storage presigned URL generation for uploads.
 *
 * CHANGES vs previous version:
 *  - Renamed `uploadToR2` -> `uploadToFortressStorage` (backend is Supabase Storage, not Cloudflare R2)
 *  - Kept `uploadToR2` as a deprecated re-export alias so existing callers don't break immediately
 *  - Removed unused `getMyProfile` import
 *  - Added AbortSignal support to `uploadToFortressStorage` for cancellable uploads
 *  - `validateFile` now accepts optional `mimeAllowList` for client-side type enforcement
 *  - Interfaces now have proper closing braces (originals were missing them)
 */

import { getSupabase } from "../auth/index.js";
import type { DeliverableType } from "@fatedfortress/protocol";

export type { DeliverableType };

export interface PresignedUploadUrl {
  uploadUrl: string;   // PUT URL to upload the file
  assetUrl: string;    // Final public URL after upload
  key: string;         // Storage object key
  expiresAt: number;   // Unix timestamp when upload URL expires
}

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
    throw new Error(data?.error ?? "Failed to generate presigned upload URL");
  }

  return data as PresignedUploadUrl;
}

/**
 * Upload a file to Supabase Storage using a presigned PUT URL.
 *
 * @param presigned   - Result from createPresignedUploadUrl
 * @param file        - File to upload
 * @param onProgress  - Optional progress callback (0-100)
 * @param signal      - Optional AbortSignal for cancellation (NEW)
 */
export async function uploadToFortressStorage(
  presigned: PresignedUploadUrl,
  file: File,
  onProgress?: (pct: number) => void,
  signal?: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Upload aborted", "AbortError"));
      return;
    }

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

    xhr.addEventListener("error", () =>
      reject(new Error("Supabase Storage upload network error"))
    );

    xhr.addEventListener("abort", () =>
      reject(new DOMException("Upload aborted", "AbortError"))
    );

    signal?.addEventListener("abort", () => xhr.abort());

    xhr.open("PUT", presigned.uploadUrl);
    xhr.setRequestHeader("Content-Type", file.type);
    xhr.send(file);
  });
}

/** @deprecated Use uploadToFortressStorage. This alias will be removed once submit.ts is updated. */
export const uploadToR2 = uploadToFortressStorage;

/**
 * Validate a file before upload.
 *
 * @param file          - File to validate
 * @param maxSizeMb     - Maximum size in MB (default 100)
 * @param mimeAllowList - Optional MIME allow-list (NEW); skipped if empty/omitted
 */
export function validateFile(
  file: File,
  maxSizeMb = 100,
  mimeAllowList?: string[]
): { ok: true } | { ok: false; error: string } {
  if (file.size === 0) return { ok: false, error: "File is empty" };
  if (file.size > maxSizeMb * 1024 * 1024) return { ok: false, error: `File exceeds ${maxSizeMb}MB limit` };
  if (mimeAllowList?.length && !mimeAllowList.includes(file.type)) {
    return { ok: false, error: `File type "${file.type}" is not allowed` };
  }
  return { ok: true };
}

export async function createPortfolioUploadUrl(
  userId: string,
  fileName: string,
  contentType: string
): Promise<PresignedUploadUrl> {
  const { data, error } = await getSupabase()
    .functions
    .invoke("supabase-storage-upload", {
      body: { isPortfolio: true, userId, fileName, contentType, deliverableType: "file" as const },
    });

  if (error || !data?.uploadUrl) {
    throw new Error(data?.error ?? "Failed to generate portfolio upload URL");
  }

  return data as PresignedUploadUrl;
}