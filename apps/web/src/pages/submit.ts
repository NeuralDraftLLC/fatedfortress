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

      // Create submission row FIRST — edge function needs a real UUID FK
      const { data: submission, error: submitError } = await supabase
        .from("submissions")
        .insert({
          task_id: taskId, contributor_id: user.id,
          asset_url: uploadedAssetUrl, deliverable_type: selectedType,
          revision_number: revisionNumber,
        } as Record<string, unknown>)
        .select()
        .single();

      if (submitError || !submission) throw submitError ?? new Error("Failed to create submission record");

      // FIX: was missing taskId — edge function skipped all auto-reject DB writes
      const { data: verifyResult, error: verifyError } = await supabase.functions.invoke("verify-submission", {
        body: { assetUrl: uploadedAssetUrl, deliverableType: selectedType, taskId, submissionId: submission.id },
      });
      if (verifyError) throw verifyError;

      $verifyStatus.classList.add("hidden");

      if (verifyResult?.auto_reject) {
        window.location.hash = "#/tasks?status=rejected";
        return;
      }

      // IMPROVED: guard against race with edge function status change
      await supabase.from("tasks").update({ status: "under_review" }).eq("id", taskId).in("status", ["open", "revision_requested"]);
      window.location.hash = `#/project/${(task.project as Record<string, unknown>)?.id ?? taskId}`;

    } catch (err) {
      // FIX: re-enable button and surface error instead of leaving UI locked
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