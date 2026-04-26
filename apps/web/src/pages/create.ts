/**
 * apps/web/src/pages/create.ts — Host project creation + SCOPE button.
 *
 * Sacred objects: Task, Submission, Decision
 *
 * Flow:
 * 1. Host fills brief (title, description, projectType, references, budget range)
 * 2. Host clicks SCOPE → generateScopedTasks(intent) → ScopedTask[] + readmeDraft + folderStructure
 * 3. Host reviews tasks + payouts
 * 4. [NEW — roadmap 1.2] FUND_PROJECT step:
 *    - Shows total max payout, platform fee, max hold on card
 *    - If Stripe Connect not set up → nudge to connect in-context
 *    - Confirms host understands escrow before publish
 * 5. Host confirms → activateProject + createProjectWallet → /project/:id
 */

import { getSupabase } from "../auth/index.js";
import { requireAuth } from "../auth/middleware.js";
import { generateScopedTasks } from "../handlers/scope.js";
import type { ScopedTask } from "@fatedfortress/protocol";
import { renderShell } from "../ui/shell.js";
import { insertAuditEntry, persistScopedProject, updateTaskPayout, activateProject, createProjectWallet, getInsertedTasks } from "../net/data.js";
import { escHtml } from "../ui/components.js";

// ─── Payout math (shared with tasks.ts, roadmap 1.2 / 1.3) ─────────────────

const PLATFORM_FEE_BPS = 1000; // 10%

function computeTotalFundingRequired(tasks: ScopedTask[]): {
  totalMaxPayout: number;
  platformFee: number;
  maxHold: number;
} {
  const totalMaxPayout = parseFloat(
    tasks.reduce((sum, t) => sum + t.payoutMax, 0).toFixed(2)
  );
  const platformFee = parseFloat(
    (totalMaxPayout * PLATFORM_FEE_BPS / 10_000).toFixed(2)
  );
  // The hold is the full totalMaxPayout — fee is deducted from that at capture
  const maxHold = totalMaxPayout;
  return { totalMaxPayout, platformFee, maxHold };
}

export async function mountCreate(container: HTMLElement): Promise<() => void> {
  await requireAuth();

  const supabase = getSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return () => {};

  container.innerHTML = renderShell({
    title: "FORGE_SCREEN",
    subtitle: "INPUT_NEURAL_BLUEPRINT_STRING_HERE...",
    activePath: "/create",
    contentHtml: `
      <div class="ff-grid">
        <!-- LEFT: parameters -->
        <section class="ff-panel" style="grid-column: span 3;">
          <div class="ff-kpi__label">FORGE_PARAMETERS</div>
          <form class="ff-form" id="create-form" style="margin-top:12px">
            <div style="margin-bottom:12px">
              <label for="project-title">PROJECT_TITLE</label>
              <input class="ff-input" type="text" id="project-title" required placeholder="Landing page redesign" maxlength="120" />
            </div>
            <div style="margin-bottom:12px">
              <label for="project-type">PROJECT_TYPE</label>
              <select class="ff-select" id="project-type" required>
                <option value="">Select type...</option>
                <option value="code">Code / Engineering</option>
                <option value="design">Design</option>
                <option value="writing">Writing / Copy</option>
                <option value="audio">Audio / Music</option>
                <option value="video">Video / Animation</option>
                <option value="3d">3D / Modeling</option>
                <option value="general">General</option>
              </select>
            </div>
            <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom:12px">
              <div>
                <label for="budget-min">BUDGET_MIN</label>
                <input class="ff-input" type="number" id="budget-min" min="1" step="0.01" placeholder="100.00" required />
              </div>
              <div>
                <label for="budget-max">BUDGET_MAX</label>
                <input class="ff-input" type="number" id="budget-max" min="1" step="0.01" placeholder="500.00" required />
              </div>
            </div>
            <div style="margin-bottom:12px">
              <label for="target-timeline">TARGET_TIMELINE</label>
              <input class="ff-input" type="text" id="target-timeline" placeholder="2 weeks / end of month" />
            </div>
            <div style="margin-bottom:12px">
              <label>REFERENCE_FILES</label>
              <div id="file-list" class="ff-subtitle"></div>
              <button type="button" class="ff-btn" style="background: var(--ff-paper); color: var(--ff-ink); margin-top:10px" id="add-ref-btn">ADD_REFERENCE</button>
              <input type="file" id="ref-input" class="hidden" multiple accept="image/*,.pdf,.txt,.md" />
            </div>
          </form>
        </section>

        <!-- CENTER: vision stream + drop zone -->
        <section class="ff-panel" style="grid-column: span 6;">
          <div class="ff-kpi__label">VISION_STREAM_FEED</div>
          <textarea class="ff-textarea" id="project-description" form="create-form" required placeholder="Describe what you need, context, goals, constraints..." maxlength="2000"></textarea>
          <div class="ff-subtitle" style="margin-top:6px"><span id="desc-count">0</span>/2000</div>

          <div class="ff-panel" style="margin-top:12px">
            <div class="ff-kpi__label">DROP_ZONE</div>
            <div class="ff-subtitle" style="margin-top:8px">Drag &amp; drop refs (stub UI)</div>
          </div>
        </section>

        <!-- RIGHT: system readout + heavy action -->
        <section class="ff-panel" style="grid-column: span 3; display:flex; flex-direction:column; gap:12px;">
          <div class="ff-kpi__label">SYSTEM_READOUT</div>
          <div class="ff-subtitle" id="forge-readout" style="white-space:pre-wrap;">
            [INIT] WAITING_FOR_USER_SIGNAL_
          </div>

          <div class="ff-panel">
            <div class="ff-kpi__label">OPERATOR_COUNT</div>
            <div style="font-family: var(--ff-font-mono); font-weight:900; font-size: 20px;" id="operator-count">—</div>
            <div class="ff-subtitle">tasks generated</div>
          </div>

          <div class="ff-panel">
            <div class="ff-kpi__label">PROGRESS</div>
            <div style="border:1px solid var(--ff-ink); height: 10px; width: 100%; margin-top:8px">
              <div id="forge-progress-bar" style="height:100%; width:0%; background: var(--ff-ink)"></div>
            </div>
            <div class="ff-subtitle" style="margin-top:8px" id="forge-progress-text">0%</div>
          </div>

          <button class="ff-btn" id="scope-btn" type="button">
            <span class="btn-text">FORGE_BLUEPRINT</span>
            <span class="btn-loading hidden">FORGING...</span>
          </button>
          <button class="ff-btn" id="save-draft-btn" type="button" style="background:var(--ff-paper);color:var(--ff-ink)">
            SAVE_AS_DRAFT
          </button>
        </section>
      </div>

      <!-- Full-screen generation phase overlay -->
      <div id="forge-overlay" class="hidden" style="
        position:fixed; inset:0; z-index:60;
        background: var(--ff-ink); color: var(--ff-paper);
        padding: 24px; font-family: var(--ff-font-mono);
        display:flex; flex-direction:column; gap: 12px;">
        <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--ff-paper); padding-bottom:10px;">
          <div style="font-weight:900; letter-spacing:0.2em;">FORGE_BLUEPRINT</div>
          <div style="font-size:10px; opacity:0.8;">INTEL_CLASSIFIED · GENERATION_PHASE</div>
        </div>
        <div style="font-size:12px; opacity:0.85;" id="forge-overlay-status">FORGING...</div>
        <div style="border:1px solid var(--ff-paper); height: 12px;">
          <div id="forge-overlay-bar" style="height:100%; width:0%; background: var(--ff-paper);"></div>
        </div>
        <div style="font-size:10px; opacity:0.8;" id="forge-overlay-meta">operator_count: —</div>
        <div style="flex:1; border:1px solid var(--ff-paper); padding:12px; white-space:pre-wrap; font-size:11px;" id="forge-overlay-log">[BOOT] scope_worker ready</div>
      </div>

      <!-- Scoped task preview (step 3) -->
      <div class="ff-panel hidden" id="scoped-preview" style="margin-top:16px">
        <div id="scoped-readme"></div>
        <div id="scoped-structure" style="margin-top:10px"></div>
        <h2 class="ff-h1" style="font-size:16px;margin-top:16px">Generated Tasks</h2>
        <p class="ff-subtitle">Review and set final payouts, then continue to funding.</p>
        <div id="scoped-tasks" style="margin-top:10px"></div>
        <div style="display:flex; gap:10px; margin-top:14px">
          <button class="ff-btn" style="background: var(--ff-paper); color: var(--ff-ink); flex:1" id="re-scope-btn">REGENERATE</button>
          <button class="ff-btn" style="flex:1" id="fund-step-btn">
            REVIEW_FUNDING →
          </button>
        </div>
      </div>

      <!-- ── Retry-exhausted fallback (Pillar 2) — shown when AI fails all 3 retries ── -->
      <div class="ff-panel hidden" id="ai-fallback-panel" style="margin-top:16px; border:2px solid var(--ff-warning);">
        <div class="ff-kpi__label" style="margin-bottom:16px;">AI_SCOPING_FAILED</div>
        <p class="ff-subtitle" id="ai-fallback-warning" style="
          font-family:var(--ff-font-mono);font-size:12px;line-height:1.7;
          margin-bottom:16px;padding:12px;border:1px solid var(--ff-warning);">
        </p>
        <p class="ff-subtitle" style="margin-bottom:16px;line-height:1.7;">
          You can still create this project manually:
        </p>
        <div style="display:flex;gap:10px;">
          <button class="ff-btn" id="manual-continue-btn" type="button" style="flex:1">
            ADD_TASKS_MANUALLY
          </button>
          <button class="ff-btn" style="flex:1;background:var(--ff-paper);color:var(--ff-ink)" id="ai-fallback-discard-btn">
            DISCARD_PROJECT
          </button>
        </div>
      </div>

      <!-- ── Fund Project step (roadmap 1.2) — shown after task review ── -->
      <div class="ff-panel hidden" id="fund-project-panel" style="margin-top:16px; border:2px solid var(--ff-ink);">
        <div class="ff-kpi__label" style="margin-bottom:16px;">FUND_PROJECT</div>

        <p class="ff-subtitle" style="font-family:var(--ff-font-mono);font-size:12px;line-height:1.7;margin-bottom:20px;">
          We've calculated the maximum possible payout for this scope.<br/>
          We'll pre-authorize this amount when a contributor claims a task — using a
          <strong>hotel-style hold</strong> on your card. You are <em>not</em> charged until
          work is approved.
        </p>

        <!-- Funding breakdown -->
        <div id="fund-breakdown" style="
          font-family:var(--ff-font-mono);font-size:13px;
          display:flex;flex-direction:column;gap:8px;
          border:1px solid var(--ff-muted);padding:16px;margin-bottom:20px;
        ">
          <div style="display:flex;justify-content:space-between;">
            <span style="color:var(--ff-muted);">TASK_TOTAL_MAX_PAYOUT</span>
            <span id="fund-total" style="font-weight:900;">$—</span>
          </div>
          <div style="display:flex;justify-content:space-between;">
            <span style="color:var(--ff-muted);">PLATFORM_FEE (10%)</span>
            <span id="fund-fee" style="color:var(--ff-muted);">$—</span>
          </div>
          <div style="border-top:1px solid var(--ff-muted);padding-top:8px;display:flex;justify-content:space-between;">
            <span>MAX_HOLD_ON_CARD</span>
            <span id="fund-hold" style="font-weight:900;">$—</span>
          </div>
        </div>

        <!-- Tooltip-style hold explainer -->
        <div style="
          font-family:var(--ff-font-mono);font-size:11px;color:var(--ff-muted);
          border-left:2px solid var(--ff-muted);padding-left:10px;margin-bottom:20px;
          line-height:1.6;
        ">
          ⓘ A hold is not a charge. Funds are reserved so contributors never work for
          phantom money. If a task expires or is rejected after failed checks, the hold
          is released automatically.
        </div>

        <!-- Stripe Connect nudge (shown if not connected) -->
        <div id="stripe-connect-nudge" class="hidden" style="
          background:var(--ff-paper);border:1px solid var(--ff-ink);
          padding:14px;margin-bottom:16px;font-family:var(--ff-font-mono);font-size:12px;
        ">
          <div style="font-weight:900;margin-bottom:6px;">⚡ CONNECT_PAYOUT_ACCOUNT_REQUIRED</div>
          <div style="color:var(--ff-muted);margin-bottom:12px;">
            You need a Stripe Connect account to receive payouts when hosts fund tasks.
            This takes ~2 minutes.
          </div>
          <a href="/settings?section=stripe-connect&return=/create" class="ff-btn" style="text-decoration:none;display:inline-block;">
            CONNECT_STRIPE_ACCOUNT
          </a>
        </div>

        <!-- Actions -->
        <div style="display:flex;gap:10px;">
          <button class="ff-btn" style="background:var(--ff-paper);color:var(--ff-ink);flex:1" id="fund-back-btn">
            ← BACK_TO_TASKS
          </button>
          <button class="ff-btn" style="flex:1" id="publish-btn">
            <span class="publish-text">FUND_AND_PUBLISH</span>
            <span class="publish-loading hidden">PUBLISHING...</span>
          </button>
        </div>
        <div id="publish-error" class="hidden" style="margin-top:10px;font-family:var(--ff-font-mono);font-size:11px;color:var(--ff-error);"></div>
      </div>
    `,
  });

  // ── State ─────────────────────────────────────────────────────────
  let generatedTasks: ScopedTask[] = [];
  let generatedReadme = "";
  let generatedFolderStructure: string[] = [];
  let projectId: string | null = null;
  let references: string[] = [];
  let persistedTaskRows: Array<{ id: string; payout_min: number; payout_max: number; title: string }> = [];

  // ── Element refs ─────────────────────────────────────────────────
  const $form = container.querySelector("#create-form") as HTMLFormElement;
  const $scopeBtn = container.querySelector("#scope-btn") as HTMLButtonElement;
  const $btnText = container.querySelector(".btn-text") as HTMLElement;
  const $btnLoading = container.querySelector(".btn-loading") as HTMLElement;
  const $preview = container.querySelector("#scoped-preview") as HTMLElement;
  const $fundPanel = container.querySelector("#fund-project-panel") as HTMLElement;
  const $fallbackPanel = container.querySelector("#ai-fallback-panel") as HTMLElement;
  const $taskList = container.querySelector("#scoped-tasks") as HTMLElement;
  const $readme = container.querySelector("#scoped-readme") as HTMLElement;
  const $structure = container.querySelector("#scoped-structure") as HTMLElement;

  // ── Scope button ─────────────────────────────────────────────────
  $scopeBtn.addEventListener("click", async () => {
    if (!$scopeBtn.disabled) await handleScope();
  });

  // ── Task review → Fund step transition ───────────────────────────
  container.querySelector("#fund-step-btn")?.addEventListener("click", () => {
    // Save any edited payouts first
    syncPayoutEdits();
    showFundStep();
  });

  // ── Fund step back ───────────────────────────────────────────────
  container.querySelector("#fund-back-btn")?.addEventListener("click", () => {
    $fundPanel.classList.add("hidden");
    $preview.classList.remove("hidden");
  });

  // ── Publish (from fund step) ─────────────────────────────────────
  container.querySelector("#publish-btn")?.addEventListener("click", handlePublish);

  // ── Save as Draft (Pillar 2) ─────────────────────────────────────
  container.querySelector("#save-draft-btn")?.addEventListener("click", handleSaveDraft);

  // ── AI fallback: manual continue ─────────────────────────────────
  container.querySelector("#manual-continue-btn")?.addEventListener("click", () => {
    $fallbackPanel.classList.add("hidden");
    $fundPanel.classList.remove("hidden");
  });

  // ── AI fallback: discard ───────────────────────────────────────
  container.querySelector("#ai-fallback-discard-btn")?.addEventListener("click", () => {
    window.location.href = "/dashboard";
  });

  // ── Regenerate ───────────────────────────────────────────────────
  container.querySelector("#re-scope-btn")?.addEventListener("click", handleScope);

  // ── Description counter ──────────────────────────────────────────
  const $descTextarea = container.querySelector("#project-description") as HTMLTextAreaElement;
  $descTextarea.addEventListener("input", () => {
    (container.querySelector("#desc-count") as HTMLElement).textContent = String($descTextarea.value.length);
  });

  // ── Reference file picker ─────────────────────────────────────────
  const $refInput = container.querySelector("#ref-input") as HTMLInputElement;
  const $fileList = container.querySelector("#file-list") as HTMLElement;

  container.querySelector("#add-ref-btn")?.addEventListener("click", () => $refInput.click());

  $refInput.addEventListener("change", () => {
    const files = Array.from($refInput.files ?? []);
    for (const f of files) {
      if (!references.includes(f.name)) references.push(f.name);
    }
    $fileList.textContent = references.length ? references.join(", ") : "";
    $refInput.value = "";
  });

  // ── Handle SCOPE ─────────────────────────────────────────────────
  // Called when "FORGE_BLUEPRINT" is clicked.

  // ── Save as Draft (Pillar 2) ──────────────────────────────────────
  // Saves the form inputs as a draft project without running AI scoping.
  // Project stays in 'draft' status until host publishes manually.
  async function handleSaveDraft(): Promise<void> {
    const title = ($form.querySelector("#project-title") as HTMLInputElement).value.trim();
    const description = ($descTextarea as HTMLTextAreaElement).value.trim();
    const projectType = ($form.querySelector("#project-type") as HTMLSelectElement).value;
    const budgetMin = parseFloat(($form.querySelector("#budget-min") as HTMLInputElement).value);
    const budgetMax = parseFloat(($form.querySelector("#budget-max") as HTMLInputElement).value);
    const targetTimeline = ($form.querySelector("#target-timeline") as HTMLInputElement).value.trim();

    if (!title || !description || !projectType || isNaN(budgetMin) || isNaN(budgetMax) || budgetMin <= 0 || budgetMax < budgetMin) {
      alert("Please fill in all required fields correctly");
      return;
    }

    try {
      projectId = crypto.randomUUID();
      const { error: persistErr } = await supabase.rpc("persist_scoped_project", {
        p_project_id: projectId,
        p_host_id: user.id,
        p_title: title,
        p_description: description,
        p_references_urls: references,
        p_readme_draft: "",
        p_folder_structure: [],
        p_tasks: [],  // No tasks yet — draft only
      });

      if (persistErr) throw new Error(`Save draft failed: ${persistErr.message}`);

      window.location.href = `/project/${projectId}?draft=1`;
    } catch (err: unknown) {
      alert(`Save draft failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  }

  // ── Handle SCOPE ─────────────────────────────────────────────────
  async function handleScope(): Promise<void> {
    const title = ($form.querySelector("#project-title") as HTMLInputElement).value.trim();
    const description = ($descTextarea as HTMLTextAreaElement).value.trim();
    const projectType = ($form.querySelector("#project-type") as HTMLSelectElement).value;
    const budgetMin = parseFloat(($form.querySelector("#budget-min") as HTMLInputElement).value);
    const budgetMax = parseFloat(($form.querySelector("#budget-max") as HTMLInputElement).value);
    const targetTimeline = ($form.querySelector("#target-timeline") as HTMLInputElement).value.trim();

    if (!title || !description || !projectType || isNaN(budgetMin) || isNaN(budgetMax) || budgetMin <= 0 || budgetMax < budgetMin) {
      alert("Please fill in all required fields correctly");
      return;
    }

    setLoading(true);
    startForgeOverlay();

    // Reset state on re-scope
    $fundPanel.classList.add("hidden");
    $preview.classList.add("hidden");

    try {
      projectId = crypto.randomUUID();

      const result = await generateScopedTasks({
        projectId,
        title,
        description,
        projectType,
        referenceUrls: references,
        budgetRange: { min: budgetMin, max: budgetMax },
        targetTimeline: targetTimeline || undefined,
      });

      generatedTasks = result.tasks ?? [];
      generatedReadme = result.readmeDraft;
      generatedFolderStructure = result.folderStructure ?? [];

      // ── Pillar 2: AI failed all retries — show fallback UI ─────────────────
      if (!result.scoped) {
        const $warning = container.querySelector("#ai-fallback-warning") as HTMLElement;
        if ($warning) $warning.textContent = result.warning ?? "AI task generation failed after 3 attempts.";
        stopForgeOverlay();
        setLoading(false);
        $fallbackPanel.classList.remove("hidden");
        return;
      }

      if (generatedTasks.length === 0) {
        throw new Error("No tasks generated");
      }

      const taskJson = generatedTasks.map((t) => ({
        title: t.title,
        description: t.description,
        deliverable_type: t.deliverableType,
        payout_min: t.payoutMin,
        payout_max: t.payoutMax,
        ambiguity_score: t.ambiguityScore,
        estimated_minutes: t.estimatedMinutes,
      }));

      const { data: persistedProjectId, error: persistErr } = await supabase.rpc("persist_scoped_project", {
        p_project_id: projectId,
        p_host_id: user.id,
        p_title: title,
        p_description: description,
        p_references_urls: references,
        p_readme_draft: generatedReadme,
        p_folder_structure: generatedFolderStructure,
        p_tasks: taskJson,
      });

      if (persistErr || !persistedProjectId) {
        throw new Error(`Persist failed: ${persistErr?.message ?? "unknown error"}`);
      }

      persistedTaskRows = await getInsertedTasks(projectId);

      renderTaskPreview();
      $preview.classList.remove("hidden");
      $form.classList.add("hidden");
    } catch (err: unknown) {
      alert(`SCOPE failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      stopForgeOverlay();
      setLoading(false);
    }
  }

  // ── Show Fund Project step ────────────────────────────────────────
  function showFundStep(): void {
    // Recompute totals from current payout inputs
    const $inputs = $taskList.querySelectorAll<HTMLInputElement>(".task-payout-input");
    const currentPayouts: number[] = [];
    $inputs.forEach(inp => {
      const v = parseFloat(inp.value);
      currentPayouts.push(isNaN(v) ? 0 : v);
    });

    // Use actual edited maxes for the hold calculation
    const editedMax = generatedTasks.map((t, i) => {
      const edited = currentPayouts[i] ?? t.payoutMax;
      return { ...t, payoutMax: edited };
    });

    const { totalMaxPayout, platformFee, maxHold } = computeTotalFundingRequired(editedMax);

    const $total = container.querySelector("#fund-total") as HTMLElement;
    const $fee = container.querySelector("#fund-fee") as HTMLElement;
    const $hold = container.querySelector("#fund-hold") as HTMLElement;

    $total.textContent = `$${totalMaxPayout.toFixed(2)}`;
    $fee.textContent = `$${platformFee.toFixed(2)}`;
    $hold.textContent = `$${maxHold.toFixed(2)}`;

    // Check Stripe Connect status — show nudge if not connected
    checkStripeConnectStatus();

    $preview.classList.add("hidden");
    $fundPanel.classList.remove("hidden");
  }

  async function checkStripeConnectStatus(): Promise<void> {
    const $nudge = container.querySelector("#stripe-connect-nudge") as HTMLElement;
    try {
      const { data: profile } = await supabase
        .from("profiles")
        .select("stripe_charges_enabled")
        .eq("id", user.id)
        .single();

      const connected = (profile as { stripe_charges_enabled?: boolean } | null)?.stripe_charges_enabled === true;
      $nudge.classList.toggle("hidden", connected);

      // Disable publish button if not connected
      const $publishBtn = container.querySelector("#publish-btn") as HTMLButtonElement;
      if (!connected) {
        $publishBtn.disabled = true;
        $publishBtn.title = "Connect your Stripe account first";
      } else {
        $publishBtn.disabled = false;
        $publishBtn.title = "";
      }
    } catch {
      // Non-fatal — don't block the step
      $nudge.classList.add("hidden");
    }
  }

  // ── Sync payout edits from inputs into generatedTasks ────────────
  function syncPayoutEdits(): void {
    const $inputs = $taskList.querySelectorAll<HTMLInputElement>(".task-payout-input");
    $inputs.forEach((inp, i) => {
      const val = parseFloat(inp.value);
      if (!isNaN(val) && generatedTasks[i]) {
        generatedTasks[i].payoutMax = Math.min(
          Math.max(val, generatedTasks[i].payoutMin),
          generatedTasks[i].payoutMax
        );
      }
    });
  }

  // ── Handle Publish (from Fund step) ──────────────────────────────
  async function handlePublish(): Promise<void> {
    if (!projectId) return;

    const $publishBtn = container.querySelector("#publish-btn") as HTMLButtonElement;
    const $publishText = container.querySelector(".publish-text") as HTMLElement;
    const $publishLoading = container.querySelector(".publish-loading") as HTMLElement;
    const $publishError = container.querySelector("#publish-error") as HTMLElement;

    $publishBtn.disabled = true;
    $publishText.classList.add("hidden");
    $publishLoading.classList.remove("hidden");
    $publishError.classList.add("hidden");

    try {
      // Persist any last payout edits
      const $payoutInputs = $taskList.querySelectorAll(".task-payout-input") as NodeListOf<HTMLInputElement>;

      for (let i = 0; i < $payoutInputs.length; i++) {
        const input = $payoutInputs[i];
        const task = generatedTasks[i];
        const payout = parseFloat(input.value);
        if (!isNaN(payout) && task && payout >= task.payoutMin && payout <= task.payoutMax) {
          await updateTaskPayout(input.dataset.taskId!, payout);
        }
      }

      await activateProject(projectId);
      await createProjectWallet(projectId);
      await insertAuditEntry({ actor_id: user.id, project_id: projectId, action: "task_published", payload: { count: generatedTasks.length } });

      window.location.href = `/project/${projectId}`;
    } catch (err: unknown) {
      $publishError.textContent = `Publish failed: ${err instanceof Error ? err.message : "Unknown error"}`;
      $publishError.classList.remove("hidden");
      $publishBtn.disabled = false;
      $publishText.classList.remove("hidden");
      $publishLoading.classList.add("hidden");
    }
  }

  // ── Render task preview ───────────────────────────────────────────
  function renderTaskPreview(): void {
    if (generatedReadme) {
      $readme.innerHTML = `
        <h3>README Draft</h3>
        <pre class="readme-draft">${escHtml(generatedReadme)}</pre>
      `;
    }

    if (generatedFolderStructure.length > 0) {
      $structure.innerHTML = `
        <h3>Suggested Folder Structure</h3>
        <ul class="folder-structure">
          ${generatedFolderStructure.map(f => `<li>${escHtml(f)}</li>`).join("")}
        </ul>
      `;
    }

    $taskList.innerHTML = generatedTasks.map((t, i) => {
      const row = persistedTaskRows[i];
      const taskId = row?.id ? String(row.id) : "";
      return `
      <div class="scoped-task">
        <div class="scoped-task__header">
          <span class="scoped-task__number">${i + 1}</span>
          <h3 class="scoped-task__title">${escHtml(t.title)}</h3>
          <span class="scoped-task__type">${escHtml(t.deliverableType)}</span>
          <span class="scoped-task__time">~${t.estimatedMinutes}min</span>
          <span class="scoped-task__role">${escHtml(t.suggestedRole)}</span>
          <span class="scoped-task__ambiguity ambiguity--${t.ambiguityScore > 0.7 ? "high" : t.ambiguityScore > 0.4 ? "med" : "low"}">
            ${t.ambiguityScore > 0.7 ? "High" : t.ambiguityScore > 0.4 ? "Med" : "Low"} ambiguity
          </span>
        </div>
        <p class="scoped-task__desc">${escHtml(t.description)}</p>
        <div class="scoped-task__payout">
          <label>Payout ($${t.payoutMin}–$${t.payoutMax})</label>
          <input type="number" class="task-payout-input"
            data-task-id="${escHtml(taskId)}"
            value="${((t.payoutMin + t.payoutMax) / 2).toFixed(2)}"
            min="${t.payoutMin}" max="${t.payoutMax}" step="0.01" />
        </div>
      </div>
    `}).join("");
  }

  function setLoading(loading: boolean): void {
    $scopeBtn.disabled = loading;
    $btnText.classList.toggle("hidden", loading);
    $btnLoading.classList.toggle("hidden", !loading);
  }

  // ── Forge overlay ────────────────────────────────────────────────
  let forgeTimer: ReturnType<typeof setInterval> | null = null;
  let forgeProgress = 0;

  function startForgeOverlay(): void {
    const $overlay = container.querySelector("#forge-overlay") as HTMLElement | null;
    if (!$overlay) return;
    $overlay.classList.remove("hidden");
    forgeProgress = 0;
    updateForgeProgress(0);
    const $log = container.querySelector("#forge-overlay-log") as HTMLElement | null;
    const $status = container.querySelector("#forge-overlay-status") as HTMLElement | null;
    if ($log) $log.textContent = "[BOOT] scope_worker ready\n[NET] invoking scope-tasks...\n";
    if ($status) $status.textContent = "FORGING...";

    if (forgeTimer) clearInterval(forgeTimer);
    forgeTimer = setInterval(() => {
      if (forgeProgress < 90) {
        forgeProgress += Math.max(1, Math.floor((90 - forgeProgress) / 12));
        updateForgeProgress(forgeProgress);
      }
    }, 120);
  }

  function stopForgeOverlay(): void {
    if (forgeTimer) clearInterval(forgeTimer);
    forgeTimer = null;
    const $overlay = container.querySelector("#forge-overlay") as HTMLElement | null;
    if ($overlay) $overlay.classList.add("hidden");
  }

  function updateForgeProgress(pct: number): void {
    const $bar = container.querySelector("#forge-progress-bar") as HTMLElement | null;
    const $txt = container.querySelector("#forge-progress-text") as HTMLElement | null;
    const $obar = container.querySelector("#forge-overlay-bar") as HTMLElement | null;
    const $meta = container.querySelector("#forge-overlay-meta") as HTMLElement | null;
    if ($bar) $bar.style.width = `${pct}%`;
    if ($txt) $txt.textContent = `${pct}%`;
    if ($obar) $obar.style.width = `${pct}%`;
    if ($meta) $meta.textContent = `operator_count: ${generatedTasks.length || "—"}`;
  }

  return () => {};
}
