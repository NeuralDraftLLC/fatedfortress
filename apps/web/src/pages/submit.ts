/**
 * apps/web/src/pages/submit.ts — Contributor upload + submit flow.
 *
 * Sacred objects: Task, Submission, Decision
 *
 * Flow:
 * 1. Contributor uploads deliverable to R2 via presigned URL
 * 2. invoke VERIFY_SUBMISSION (edge function or Cloudflare Worker)
 * 3. If auto_reject: insert decisions row (quality_issue), notify contributor
 *    type=verification_failed, task goes to revision_requested — never reaches host queue
 * 4. If passed: submission row created, task → under_review, host notified
 */

import { getSupabase } from "../auth/index.js";
import { requireAuth } from "../auth/middleware.js";
import type { Task, DeliverableType, VerificationResult } from "@fatedfortress/protocol";
import { createPresignedUploadUrl, uploadToR2, validateFile } from "../net/storage.js";

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

const ALL_DELIVERABLE_TYPES: DeliverableType[] = [
  "file", "pr", "code_patch", "design_asset", "text",
  "audio", "video", "3d_model", "figma_link",
];

export async function mountSubmit(container: HTMLElement, taskId: string): Promise<() => void> {
  requireAuth();

  const supabase = getSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return () => {};

  // ── Fetch task ──────────────────────────────────────────────────────────
  const { data: task } = await supabase
    .from("tasks")
    .select("*, project:projects(title, host_id)")
    .eq("id", taskId)
    .single();

  if (!task) {
    container.innerHTML = `<div class="submit-page"><p>Task not found.</p></div>`;
    return () => {};
  }

  const t = task as Record<string, unknown>;

  // ── Render ────────────────────────────────────────────────────────────────
  container.innerHTML = `
    <div class="submit-page">
      <header class="submit-header">
        <a href="/tasks" class="back-link">← Back to tasks</a>
        <h1 class="submit-title">Submit Deliverable</h1>
        <p class="submit-project">${escHtml(t.project?.title ?? "")}</p>
      </header>

      <div class="submit-task-info">
        <h2 class="submit-task-title">${escHtml(t.title as string)}</h2>
        <p class="submit-task-desc">${escHtml((t.description as string) ?? "")}</p>
        <div class="submit-task-meta">
          <span class="meta-chip">Payout: $${t.payout_min}–$${t.payout_max}</span>
          ${t.ambiguity_score ? `<span class="meta-chip">Ambiguity: ${(+t.ambiguity_score > 0.7) ? "High" : +t.ambiguity_score > 0.4 ? "Medium" : "Low"}</span>` : ""}
          ${t.estimated_minutes ? `<span class="meta-chip">Est: ${t.estimated_minutes}min</span>` : ""}
        </div>
      </div>

      <div class="submit-dropzone" id="dropzone">
        <div class="submit-dropzone__inner" id="dropzone-inner">
          <div class="submit-dropzone__icon">📎</div>
          <p class="submit-dropzone__text">Drop your deliverable here, or <button class="submit-browse-btn" id="browse-btn">browse</button></p>
          <p class="submit-dropzone__hint">Max 500MB · Any file type</p>
          <input type="file" id="file-input" class="hidden" />
        </div>
        <div class="submit-dropzone__progress hidden" id="upload-progress">
          <div class="progress-bar"><div class="progress-bar__fill" id="progress-fill"></div></div>
          <p class="progress-text" id="progress-text">Uploading...</p>
        </div>
        <div class="submit-dropzone__verify hidden" id="verify-status">
          <div class="spinner"></div>
          <p id="verify-text">Running verification...</p>
        </div>
      </div>

      <div class="submit-deliverable-type">
        <label>Deliverable type</label>
        <div class="type-chips">
          ${ALL_DELIVERABLE_TYPES.map(type => `
            <button class="type-chip${type === "file" ? " active" : ""}" data-type="${type}">${typeLabel(type)}</button>
          `).join("")}
        </div>
      </div>

      <div class="submit-actions">
        <button class="btn btn--primary btn--lg" id="submit-btn" disabled>Submit Deliverable</button>
        <p class="submit-actions__hint" id="submit-hint">Upload a file to continue</p>
      </div>

      <div class="submit-status hidden" id="submit-status">
        <div class="submit-success hidden" id="submit-success">
          <h3>Submitted!</h3>
          <p>Your deliverable has been submitted for review. You'll be notified when the host makes a decision.</p>
          <a href="/tasks" class="btn btn--ghost">Back to Tasks</a>
        </div>
        <div class="submit-error hidden" id="submit-error">
          <h3>Submission failed</h3>
          <p id="submit-error-msg"></p>
          <button class="btn btn--ghost" id="retry-btn">Try again</button>
        </div>
        <div class="submit-verification-fail hidden" id="submit-verification-fail">
          <h3>Verification failed</h3>
          <p id="verification-fail-msg"></p>
          <button class="btn btn--ghost" id="retry-verification-btn">Fix and resubmit</button>
        </div>
      </div>
    </div>
  `;

  // ── State ──────────────────────────────────────────────────────────────
  let selectedFile: File | null = null;
  let selectedType: DeliverableType = "file";
  let uploadedAssetUrl: string | null = null;

  const $dropzone = container.querySelector("#dropzone") as HTMLElement;
  const $dropzoneInner = container.querySelector("#dropzone-inner") as HTMLElement;
  const $progress = container.querySelector("#upload-progress") as HTMLElement;
  const $progressFill = container.querySelector("#progress-fill") as HTMLElement;
  const $progressText = container.querySelector("#progress-text") as HTMLElement;
  const $verifyStatus = container.querySelector("#verify-status") as HTMLElement;
  const $verifyText = container.querySelector("#verify-text") as HTMLElement;
  const $submitBtn = container.querySelector("#submit-btn") as HTMLButtonElement;
  const $hint = container.querySelector("#submit-hint") as HTMLElement;
  const $status = container.querySelector("#submit-status") as HTMLElement;
  const $success = container.querySelector("#submit-success") as HTMLElement;
  const $error = container.querySelector("#submit-error") as HTMLElement;
  const $verifyFail = container.querySelector("#submit-verification-fail") as HTMLElement;
  const $errorMsg = container.querySelector("#submit-error-msg") as HTMLElement;
  const $verifyFailMsg = container.querySelector("#verification-fail-msg") as HTMLElement;
  const $fileInput = container.querySelector("#file-input") as HTMLInputElement;

  // ── File selection ─────────────────────────────────────────────────────
  function selectFile(file: File): void {
    selectedFile = file;
    const validation = validateFile(file, 500); // 500MB limit per Section 3.3
    if (!validation.ok) {
      showError(validation.error);
      return;
    }

    $dropzoneInner.innerHTML = `
      <div class="file-selected">
        <span class="file-selected__name">${escHtml(file.name)}</span>
        <span class="file-selected__size">${(file.size / 1024 / 1024).toFixed(2)} MB</span>
        <button class="file-selected__clear" id="clear-file">×</button>
      </div>
    `;
    $submitBtn.disabled = false;
    $hint.textContent = "Ready to submit";

    container.querySelector("#clear-file")?.addEventListener("click", (e) => {
      e.stopPropagation();
      resetDropzone();
    });
  }

  function resetDropzone(): void {
    selectedFile = null;
    uploadedAssetUrl = null;
    $dropzoneInner.innerHTML = `
      <div class="submit-dropzone__icon">📎</div>
      <p class="submit-dropzone__text">Drop your deliverable here, or <button class="submit-browse-btn" id="browse-btn">browse</button></p>
      <p class="submit-dropzone__hint">Max 500MB · Any file type</p>
    `;
    $dropzoneInner.classList.remove("hidden");
    $progress.classList.add("hidden");
    $verifyStatus.classList.add("hidden");
    $submitBtn.disabled = true;
    $hint.textContent = "Upload a file to continue";
    $status.classList.add("hidden");
    $fileInput.value = "";
    rebindBrowse();
  }

  function rebindBrowse(): void {
    container.querySelector("#browse-btn")?.addEventListener("click", onBrowseClick);
    $fileInput.addEventListener("change", onFileInputChange);
  }

  function onBrowseClick(e: Event): void {
    e.stopPropagation();
    $fileInput.click();
  }

  function onFileInputChange(): void {
    const file = $fileInput.files?.[0];
    if (file) selectFile(file);
  }

  $dropzone.addEventListener("click", () => {
    if (!$dropzoneInner.classList.contains("hidden")) $fileInput.click();
  });

  $dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    $dropzone.classList.add("dragover");
  });

  $dropzone.addEventListener("dragleave", () => {
    $dropzone.classList.remove("dragover");
  });

  $dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    $dropzone.classList.remove("dragover");
    const file = e.dataTransfer?.files?.[0];
    if (file) selectFile(file);
  });

  rebindBrowse();

  // ── Type chips ───────────────────────────────────────────────────────
  container.querySelectorAll(".type-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      container.querySelectorAll(".type-chip").forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
      selectedType = (chip as HTMLElement).dataset.type as DeliverableType;
    });
  });

  // ── Submit ─────────────────────────────────────────────────────────────
  $submitBtn.addEventListener("click", async () => {
    if (!selectedFile) return;
    $submitBtn.disabled = true;
    $hint.textContent = "Uploading...";

    try {
      // 1. Get presigned URL
      const presigned = await createPresignedUploadUrl(
        taskId,
        user.id,
        selectedFile.name,
        selectedFile.type,
        selectedType
      );

      // 2. Upload to R2
      $dropzoneInner.classList.add("hidden");
      $progress.classList.remove("hidden");
      $progressFill.style.width = "0%";

      uploadedAssetUrl = await uploadToR2(presigned, selectedFile, (pct) => {
        $progressFill.style.width = `${pct}%`;
        $progressText.textContent = `Uploading... ${pct}%`;
      });

      $progressFill.style.width = "100%";
      $progressText.textContent = "Verifying...";

      // 3. Create submission row FIRST (needed for verify-submission to have a real UUID FK)
      //    payment_intent_id is updated by stripe-payment capture on approval; initially null.
      const { data: submission, error: submitError } = await supabase
        .from("submissions")
        .insert({
          task_id: taskId,
          contributor_id: user.id,
          asset_url: uploadedAssetUrl,
          deliverable_type: selectedType,
          revision_number: 1,
        } as Record<string, unknown>)
        .select()
        .single();

      if (submitError || !submission) {
        throw new Error(submitError?.message ?? "Failed to create submission row");
      }

      const submissionId = (submission as Record<string, unknown>).id as string;

      // 4. VERIFY_SUBMISSION — runs before submission reaches host queue
      const verifyResult = await runVerification(submissionId, uploadedAssetUrl, selectedType);

      if (verifyResult.auto_reject) {
        await handleAutoReject(verifyResult, submissionId);
        return;
      }

      // 5. Passed verification — transition task to under_review, notify host
      await finalizeSubmission(submissionId, uploadedAssetUrl, selectedType);

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Submission failed";
      showError(msg);
    }
  });

  async function runVerification(
    submissionId: string,
    assetUrl: string,
    deliverableType: DeliverableType
  ): Promise<VerificationResult> {
    $progress.classList.add("hidden");
    $verifyStatus.classList.remove("hidden");
    $verifyText.textContent = "Running verification...";

    try {
      const { data, error } = await supabase.functions.invoke<VerificationResult>("verify-submission", {
        body: { submissionId, assetUrl, deliverableType },
      });

      if (error || !data) {
        // Verification service unavailable — fail open, let host review manually
        return {
          passed: true,
          checks: { format_valid: true, size_within_limit: true, not_empty: true, mime_matches_type: true },
          auto_reject: false,
        };
      }

      return data;
    } catch {
      // Fail open — let host handle manually
      return {
        passed: true,
        checks: { format_valid: true, size_within_limit: true, not_empty: true, mime_matches_type: true },
        auto_reject: false,
      };
    }
  }

  async function handleAutoReject(result: VerificationResult, submissionId: string): Promise<void> {
    // Look up the project's host_id so the decision row has a valid FK reference
    const { data: taskRow } = await supabase
      .from("tasks")
      .select("project:projects(host_id)")
      .eq("id", taskId)
      .single();

    const hostId = (taskRow?.project as Record<string, unknown>)?.host_id as string | null;

    // Insert decisions row (quality_issue) so the auto-reject is audited
    const { error: decisionError } = await supabase.from("decisions").insert({
      submission_id: submissionId,
      host_id: hostId ?? "00000000-0000-0000-0000-000000000000",
      decision_reason: result.suggested_decision_reason ?? "quality_issue",
      review_notes: result.failure_summary ?? "Automated verification failed",
      structured_feedback: null,
    } as Record<string, unknown>);

    if (decisionError) console.error("Auto-reject decision insert failed:", decisionError);

    // Transition task back to revision_requested
    await supabase
      .from("tasks")
      .update({ status: "revision_requested" } as Record<string, unknown>)
      .eq("id", taskId);

    // Audit log — verification_failed
    await supabase.from("audit_log").insert({
      actor_id: user.id,
      task_id: taskId,
      action: "verification_failed",
      payload: {
        assetUrl: uploadedAssetUrl,
        deliverableType: selectedType,
        checks: result.checks,
        failure_summary: result.failure_summary,
      },
    } as Record<string, unknown>);

    // Notify contributor
    await supabase.from("notifications").insert({
      user_id: user.id,
      type: "verification_failed",
      task_id: taskId,
    } as Record<string, unknown>);

    // Show verification failure UI
    $verifyStatus.classList.add("hidden");
    $verifyFail.classList.remove("hidden");
    $success.classList.add("hidden");
    $error.classList.add("hidden");
    $verifyFailMsg.textContent = result.failure_summary ?? "Your submission failed automated verification.";
  }

  async function finalizeSubmission(submissionId: string, assetUrl: string, deliverableType: DeliverableType): Promise<void> {
    // Transition task to under_review
    await supabase
      .from("tasks")
      .update({
        status: "under_review",
        submitted_at: new Date().toISOString(),
      } as Record<string, unknown>)
      .eq("id", taskId);

    // Audit log
    await supabase.from("audit_log").insert({
      actor_id: user.id,
      task_id: taskId,
      action: "submitted",
      payload: { submissionId, assetUrl, deliverableType },
    } as Record<string, unknown>);

    // Notify host
    await supabase.from("notifications").insert({
      user_id: t.project?.host_id,
      type: "submission_received",
      task_id: taskId,
    } as Record<string, unknown>);

    $verifyStatus.classList.add("hidden");
    $status.classList.remove("hidden");
    $success.classList.remove("hidden");
    $error.classList.add("hidden");
    $verifyFail.classList.add("hidden");
  }

  function showError(msg: string): void {
    $progress.classList.add("hidden");
    $verifyStatus.classList.add("hidden");
    $status.classList.remove("hidden");
    $success.classList.add("hidden");
    $error.classList.remove("hidden");
    $verifyFail.classList.add("hidden");
    $errorMsg.textContent = msg;
    $submitBtn.disabled = false;
    $hint.textContent = "Ready to submit";
  }

  container.querySelector("#retry-btn")?.addEventListener("click", () => {
    $status.classList.add("hidden");
    $success.classList.add("hidden");
    $error.classList.add("hidden");
    $verifyFail.classList.add("hidden");
    resetDropzone();
  });

  container.querySelector("#retry-verification-btn")?.addEventListener("click", () => {
    $status.classList.add("hidden");
    $success.classList.add("hidden");
    $error.classList.add("hidden");
    $verifyFail.classList.add("hidden");
    resetDropzone();
  });

  return () => {};
}

function typeLabel(type: string): string {
  const map: Record<string, string> = {
    file: "File", pr: "Pull Request", code_patch: "Code Patch",
    design_asset: "Design Asset", text: "Text",
    audio: "Audio", video: "Video", "3d_model": "3D Model", figma_link: "Figma Link",
  };
  return map[type] ?? type;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
