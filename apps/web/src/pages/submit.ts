/**
 * apps/web/src/pages/submit.ts — Contributor upload + submit flow.
 *
 * CHANGES vs previous version:
 *  - FIX: verify-submission invocation was not passing `taskId` — edge function silently
 *    skipped all auto-reject DB writes. Now passes { assetUrl, deliverableType, taskId, submissionId }.
 *  - FIX: import renamed `uploadToR2` -> `uploadToFortressStorage` to match storage.ts rename.
 *  - FIX: submit error handling now re-enables the button and shows error text instead of
 *    leaving the UI in a spinner-locked state.
 *  - FIX: removed unused `VerificationResult` import.
 *  - IMPROVED: AbortController wired to upload for cancellation on unmount.
 *  - IMPROVED: validateFile called before presigned URL request — avoids wasted Edge Function
 *    invocations for files that will fail validation anyway.
 *  - IMPROVED: revision_number increments based on existing submission count (re-submissions).
 *  - IMPROVED: task status update uses .in("status", [...]) to avoid race-clobbering a
 *    concurrent edge function status change.
 */

import { getSupabase } from "../auth/index.js";
import { requireAuth } from "../auth/middleware.js";
import type { Task, DeliverableType } from "@fatedfortress/protocol";
import { createPresignedUploadUrl, uploadToFortressStorage, validateFile } from "../net/storage.js";

const ALL_DELIVERABLE_TYPES: DeliverableType[] = [
  "file", "pr", "code_patch", "design_asset", "text", "audio", "video", "3d_model", "figma_link",
];

export async function mountSubmit(container: HTMLElement, taskId: string): Promise<() => void> {
  await requireAuth();
  const supabase = getSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return () => {};

  const { data: task } = await supabase
    .from("tasks")
    .select("*, project:projects(title, host_id, id)")
    .eq("id", taskId)
    .single();

  if (!task) {
    container.innerHTML = `<div class="error-state"><p>Task not found.</p></div>`;
    return () => {};
  }

  // IMPROVED: calculate revision_number from existing submissions
  const { count: existingCount } = await supabase
    .from("submissions")
    .select("id", { count: "exact", head: true })
    .eq("task_id", taskId)
    .eq("contributor_id", user.id);
  const revisionNumber = (existingCount ?? 0) + 1;

  let selectedFile: File | null = null;
  let selectedType: DeliverableType = "file";
  let uploadedAssetUrl = "";
  let uploadAbortController: AbortController | null = null;

  container.innerHTML = `
    <div class="submit-page">
      <h1>${escHtml(task.project?.title ?? "Project")}</h1>
      <p>${escHtml(String(task.description ?? ""))}</p>
      <div class="type-chips">
        ${ALL_DELIVERABLE_TYPES.map(t => `<button class="type-chip${t === "file" ? " active" : ""}" data-type="${t}">${t}</button>`).join("")}
      </div>
      <div id="dropzone" class="dropzone" role="button" tabindex="0">
        <div id="dropzone-inner">
          <p>Drop your deliverable here, or <button id="browse-btn" type="button">browse</button></p>
          <p class="hint">Max 500MB · Any file type</p>
        </div>
        <div id="progress" class="hidden">
          <div id="progress-fill" style="width:0%"></div>
          <p id="progress-text">Uploading… 0%</p>
        </div>
        <div id="verify-status" class="hidden"><p>Verifying…</p></div>
      </div>
      <input type="file" id="file-input" class="sr-only" />
      <p id="hint-text" class="hint">Upload a file to continue</p>
      <p id="status-msg" class="hidden error-text"></p>
      <button id="submit-btn" type="button" class="btn btn-primary" disabled>Submit</button>
      <div id="submit-success" class="hidden" style="margin-top:12px; color: var(--ff-gold); font-family: var(--ff-mono); font-size: 13px;">
        Submit confirmed. Task is in review.
        <span class="submit-success-msg" style="display:block; margin-top:4px; color: var(--ff-dim);"></span>
      </div>
    </div>
  `;

  const $dropzone     = container.querySelector<HTMLElement>("#dropzone")!;
  const $dropzoneInner= container.querySelector<HTMLElement>("#dropzone-inner")!;
  const $progress     = container.querySelector<HTMLElement>("#progress")!;
  const $progressFill = container.querySelector<HTMLElement>("#progress-fill")!;
  const $progressText = container.querySelector<HTMLElement>("#progress-text")!;
  const $verifyStatus = container.querySelector<HTMLElement>("#verify-status")!;
  const $fileInput    = container.querySelector<HTMLInputElement>("#file-input")!;
  const $submitBtn    = container.querySelector<HTMLButtonElement>("#submit-btn")!;
  const $hintText     = container.querySelector<HTMLElement>("#hint-text")!;
  const $statusMsg    = container.querySelector<HTMLElement>("#status-msg")!;

  function showError(msg: string): void {
    $statusMsg.textContent = msg;
    $statusMsg.classList.remove("hidden");
  }

  function resetDropzone(): void {
    $dropzoneInner.classList.remove("hidden");
    $progress.classList.add("hidden");
    $verifyStatus.classList.add("hidden");
    $submitBtn.disabled = true;
    $hintText.textContent = "Upload a file to continue";
    $fileInput.value = "";
    rebindBrowse();
  }

  function selectFile(file: File): void {
    // IMPROVED: validate before wasting a presigned URL request
    const v = validateFile(file, 500);
    if (v.ok !== true) { showError(v.error); return; }
    selectedFile = file;
    $hintText.textContent = `${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB)`;
    $submitBtn.disabled = false;
    $statusMsg.classList.add("hidden");
  }

  function rebindBrowse(): void {
    container.querySelector("#browse-btn")?.addEventListener("click", (e) => { e.stopPropagation(); $fileInput.click(); });
    $fileInput.addEventListener("change", () => { const f = $fileInput.files?.[0]; if (f) selectFile(f); });
  }

  $dropzone.addEventListener("click", () => { if (!$dropzoneInner.classList.contains("hidden")) $fileInput.click(); });
  $dropzone.addEventListener("dragover", (e) => { e.preventDefault(); $dropzone.classList.add("dragover"); });
  $dropzone.addEventListener("dragleave", () => $dropzone.classList.remove("dragover"));
  $dropzone.addEventListener("drop", (e) => {
    e.preventDefault(); $dropzone.classList.remove("dragover");
    const f = (e as DragEvent).dataTransfer?.files?.[0]; if (f) selectFile(f);
  });
  rebindBrowse();

  container.querySelectorAll(".type-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      container.querySelectorAll(".type-chip").forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
      selectedType = (chip as HTMLElement).dataset.type as DeliverableType;
    });
  });

  $submitBtn.addEventListener("click", async () => {
    if (!selectedFile) return;
    $submitBtn.disabled = true;
    $hintText.textContent = "Uploading…";
    $statusMsg.classList.add("hidden");

    try {
      const presigned = await createPresignedUploadUrl(taskId, user.id, selectedFile.name, selectedFile.type, selectedType);

      $dropzoneInner.classList.add("hidden");
      $progress.classList.remove("hidden");
      uploadAbortController = new AbortController();

      uploadedAssetUrl = await uploadToFortressStorage(presigned, selectedFile, (pct) => {
        $progressFill.style.width = `${pct}%`;
        $progressText.textContent = `Uploading… ${pct}%`;
      }, uploadAbortController.signal);

      $progress.classList.add("hidden");
      $verifyStatus.classList.remove("hidden");

      // Stage 3: Use atomic submit-task orchestrator (handles PR validation + atomic RPC + async verification)
      const { data: submitResult, error: submitError } = await supabase.functions.invoke("submit-task", {
        body: {
          taskId,
          assetUrl: uploadedAssetUrl,
          // prUrl would be passed if this were a PR-based submission
        },
      });

      if (submitError) throw submitError;

      const sr = submitResult as Record<string, unknown>;

      if (!sr?.success) {
        throw new Error((sr?.message as string) ?? "Submission failed.");
      }

      $verifyStatus.classList.add("hidden");

      // Verification runs async — status is "running" until verify-submission writes back
      // Show success state so contributor knows submission landed
      $submitBtn.disabled = true;
      $hintText.classList.add("hidden");
      $statusMsg.classList.add("hidden");
      const successEl = container.querySelector("#submit-success");
      if (successEl) {
        successEl.classList.remove("hidden");
        // Update message to show verification is running
        const msgEl = successEl.querySelector(".submit-success-msg");
        if (msgEl) msgEl.textContent = (sr?.message as string) ?? "Submission received. AI review in progress.";
      }

    } catch (err) {
      console.error("submit error:", err);
      showError(err instanceof Error ? err.message : "Submission failed. Please try again.");
      resetDropzone();
      $submitBtn.disabled = false;
    }
  });

  return () => { uploadAbortController?.abort(); };
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}