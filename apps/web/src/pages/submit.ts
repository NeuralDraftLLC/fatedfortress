/**
 * apps/web/src/pages/submit.ts — Contributor upload + submit flow.
 *
 * Refactored: all Supabase calls go through data.ts, UI through components.ts.
 * Pages own only mount logic, event binding, and state — never data access.
 */

import { requireAuth } from "../auth/middleware.js";
import { getTask, getSubmissionCount } from "../net/data.js";
import { createPresignedUploadUrl, uploadToFortressStorage, validateFile } from "../net/storage.js";
import { getCurrentUserId } from "../net/data.js";
import type { DeliverableType } from "@fatedfortress/protocol";
import { Btn, ToastContainer, showToast, Spinner, escHtml } from "../ui/components.js";

const ALL_DELIVERABLE_TYPES: DeliverableType[] = [
  "file", "pr", "code_patch", "design_asset", "text", "audio", "video", "3d_model", "figma_link",
];

export async function mountSubmit(container: HTMLElement, taskId: string): Promise<() => void> {
  await requireAuth();

  const userId = await getCurrentUserId();
  if (!userId) return () => {};

  // ── Data layer ────────────────────────────────────────────────────────────
  let task;
  try {
    task = await getTask(taskId);
  } catch {
    container.innerHTML = `
      ${ToastContainer()}
      <div style="padding: 24px;">
        ${Spinner({ label: "Loading task..." })}
      </div>`;
    showToast(container, "Task not found.", "error");
    return () => {};
  }

  const existingCount = await getSubmissionCount(taskId, userId);
  const revisionNumber = existingCount + 1;

  // ── Render ───────────────────────────────────────────────────────────────────
  container.innerHTML = `
    ${ToastContainer()}
    <div class="ff-shell">
      <div class="ff-main" style="max-width:720px; margin:0 auto; padding:32px;">
        <h1 class="ff-h1">${escHtml(task.project?.title ?? "Project")}</h1>
        <p class="ff-subtitle">${escHtml(String(task.description ?? ""))}</p>

        <div class="ff-kpi__label" style="margin: 24px 0 12px;">DELIVERABLE_TYPE</div>
        <div class="type-chips" style="display:flex; flex-wrap:wrap; gap:8px; margin-bottom:20px;">
          ${ALL_DELIVERABLE_TYPES.map(t => `
            <button class="type-chip${t === "file" ? " active" : ""}" data-type="${t}" style="
              background:${t === "file" ? "var(--ff-ink)" : "transparent"};
              color:${t === "file" ? "var(--ff-paper)" : "var(--ff-ink)"};
              border:1px solid var(--ff-ink);
              padding:8px 16px;
              font-family:var(--ff-font-mono);
              font-size:11px;
              text-transform:uppercase;
              cursor:pointer;
            ">${t}</button>
          `).join("")}
        </div>

        <div id="dropzone" class="dropzone" role="button" tabindex="0" style="
          border:2px dashed var(--ff-ink);
          padding:48px;
          text-align:center;
          cursor:pointer;
          margin-bottom:16px;
        ">
          <div id="dropzone-inner">
            <p style="font-family:var(--ff-font-mono); font-size:13px;">
              Drop your deliverable here, or
              <button id="browse-btn" type="button" style="
                background:none; border:none; color:var(--ff-gold);
                font-family:var(--ff-font-mono); text-decoration:underline; cursor:pointer;
              ">browse</button>
            </p>
            <p class="hint" style="font-family:var(--ff-font-mono); font-size:11px; color:var(--ff-muted); margin-top:8px;">Max 500MB · Any file type</p>
          </div>
          <div id="progress" class="hidden">
            <div id="progress-fill" style="height:4px; background:var(--ff-ink); width:0%; transition:width 0.2s;"></div>
            <p id="progress-text" style="font-family:var(--ff-font-mono); font-size:12px; margin-top:8px;">Uploading… 0%</p>
            <button id="cancel-upload-btn" type="button" style="
              margin-top:8px; background:none; border:1px solid var(--ff-ink);
              font-family:var(--ff-font-mono); font-size:11px; padding:4px 10px; cursor:pointer;
            ">CANCEL</button>
          </div>
          <div id="verify-status" class="hidden">
            ${Spinner({ label: "Verifying...", size: "sm" })}
          </div>
        </div>
        <input type="file" id="file-input" class="sr-only" />

        <p id="hint-text" class="hint" style="font-family:var(--ff-font-mono); font-size:12px; color:var(--ff-muted); margin-bottom:20px;">Upload a file to continue</p>
        <p id="status-msg" class="hidden" style="font-family:var(--ff-font-mono); font-size:12px; color:var(--ff-error); margin-bottom:12px;"></p>

        <div id="submit-success" class="hidden" style="margin-top:20px; padding:16px; border:1px solid var(--ff-success); font-family:var(--ff-font-mono); font-size:13px;">
          <strong style="color:var(--ff-success);">Submit confirmed.</strong> Task is in review.
          <span id="submit-success-msg" style="display:block; margin-top:4px; color:var(--ff-muted);"></span>
          <a href="/tasks" style="display:inline-block; margin-top:12px; font-family:var(--ff-font-mono); font-size:12px; text-decoration:underline;">← BACK_TO_TASKS</a>
        </div>

        <div style="margin-top:20px;">
          ${Btn({ label: "SUBMIT FOR REVIEW", variant: "primary", id: "submit-btn", disabled: true })}
        </div>
      </div>
    </div>`;

  // ── DOM refs ───────────────────────────────────────────────────────────────
  const $dropzone      = container.querySelector<HTMLElement>("#dropzone")!;
  const $dropzoneInner = container.querySelector<HTMLElement>("#dropzone-inner")!;
  const $progress      = container.querySelector<HTMLElement>("#progress")!;
  const $progressFill  = container.querySelector<HTMLElement>("#progress-fill")!;
  const $progressText  = container.querySelector<HTMLElement>("#progress-text")!;
  const $verifyStatus  = container.querySelector<HTMLElement>("#verify-status")!;
  const $fileInput     = container.querySelector<HTMLInputElement>("#file-input")!;
  const $submitBtn     = container.querySelector<HTMLButtonElement>("#submit-btn")!;
  const $hintText      = container.querySelector<HTMLElement>("#hint-text")!;
  const $statusMsg     = container.querySelector<HTMLElement>("#status-msg")!;
  const $successEl     = container.querySelector<HTMLElement>("#submit-success")!;
  const $successMsgEl  = container.querySelector<HTMLElement>("#submit-success-msg")!;

  // ── Local state ─────────────────────────────────────────────────────────────
  let selectedFile: File | null = null;
  let selectedType: DeliverableType = "file";
  let uploadAbortController: AbortController | null = null;

  // ── Helpers ──────────────────────────────────────────────────────────────────
  function showError(msg: string): void {
    $statusMsg.textContent = msg;
    $statusMsg.classList.remove("hidden");
  }

  function showPhase(phase: "idle" | "uploading" | "verifying"): void {
    $dropzoneInner.classList.toggle("hidden", phase !== "idle");
    $progress.classList.toggle("hidden", phase !== "uploading");
    $verifyStatus.classList.toggle("hidden", phase !== "verifying");
  }

  function resetDropzone(): void {
    showPhase("idle");
    $submitBtn.disabled = true;
    $hintText.textContent = "Upload a file to continue";
    $hintText.classList.remove("hidden");
    $statusMsg.classList.add("hidden");
    $fileInput.value = "";
  }

  function selectFile(file: File): void {
    const v = validateFile(file, 500);
    if (v.ok !== true) { showError(v.error ?? "Invalid file"); return; }
    selectedFile = file;
    $hintText.textContent = `${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB)`;
    $hintText.classList.remove("hidden");
    $submitBtn.disabled = false;
    $statusMsg.classList.add("hidden");
  }

  function rebindBrowse(): void {
    container.querySelector("#browse-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      $fileInput.click();
    });
    $fileInput.addEventListener("change", () => {
      const f = $fileInput.files?.[0];
      if (f) selectFile(f);
    });
  }

  // ── Dropzone ────────────────────────────────────────────────────────────────
  $dropzone.addEventListener("click", () => { if (!$dropzoneInner.classList.contains("hidden")) $fileInput.click(); });
  $dropzone.addEventListener("dragover", (e) => { e.preventDefault(); $dropzone.style.borderColor = "var(--ff-gold)"; });
  $dropzone.addEventListener("dragleave", () => { $dropzone.style.borderColor = ""; });
  $dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    $dropzone.style.borderColor = "";
    const f = (e as DragEvent).dataTransfer?.files?.[0];
    if (f) selectFile(f);
  });
  rebindBrowse();

  // ── Cancel upload ────────────────────────────────────────────────────────────
  container.querySelector("#cancel-upload-btn")?.addEventListener("click", () => {
    uploadAbortController?.abort();
    resetDropzone();
    $hintText.textContent = "Upload cancelled. Select a file to try again.";
  });

  // ── Type chips ──────────────────────────────────────────────────────────────
  container.querySelectorAll(".type-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      container.querySelectorAll(".type-chip").forEach(c => {
        (c as HTMLElement).style.background = "transparent";
        (c as HTMLElement).style.color = "var(--ff-ink)";
      });
      const el = chip as HTMLElement;
      el.style.background = "var(--ff-ink)";
      el.style.color = "var(--ff-paper)";
      selectedType = el.dataset.type as DeliverableType;
    });
  });

  // ── Submit ───────────────────────────────────────────────────────────────────
  $submitBtn.addEventListener("click", async () => {
    if (!selectedFile) return;
    $submitBtn.disabled = true;
    $hintText.textContent = "Uploading…";
    $statusMsg.classList.add("hidden");

    try {
      const presigned = await createPresignedUploadUrl(taskId, userId, selectedFile.name, selectedFile.type, selectedType);

      showPhase("uploading");
      uploadAbortController = new AbortController();

      const uploadedAssetUrl = await uploadToFortressStorage(presigned, selectedFile, (pct) => {
        $progressFill.style.width = `${pct}%`;
        $progressText.textContent = `Uploading… ${pct}%`;
      }, uploadAbortController.signal);

      showPhase("verifying");

      const supabase = (await import("../auth/index.js")).getSupabase();
      const { data: submitResult, error: submitError } = await supabase.functions.invoke("submit-task", {
        body: { taskId, assetUrl: uploadedAssetUrl },
      });

      if (submitError) throw submitError;
      const sr = submitResult as Record<string, unknown>;

      if (!sr?.success) {
        throw new Error((sr?.message as string) ?? "Submission failed.");
      }

      showPhase("idle");
      $dropzoneInner.classList.add("hidden");
      $submitBtn.disabled = true;
      $hintText.classList.add("hidden");

      $successEl.classList.remove("hidden");
      $successMsgEl.textContent = (sr?.message as string) ?? "Submission received. AI review in progress.";

    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return; // cancelled — resetDropzone already called
      console.error("submit error:", err);
      showError(err instanceof Error ? err.message : "Submission failed. Please try again.");
      resetDropzone();
      $submitBtn.disabled = false;
    }
  });

  return () => { uploadAbortController?.abort(); };
}
