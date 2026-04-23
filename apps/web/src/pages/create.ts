/**
 * apps/web/src/pages/create.ts — Host project creation + SCOPE button.
 *
 * Sacred objects: Task, Submission, Decision
 *
 * Flow:
 * 1. Host fills brief (title, description, projectType, references, budget range)
 * 2. Host clicks SCOPE → generateScopedTasks(intent) → ScopedTask[] + readmeDraft + folderStructure
 * 3. Host reviews, edits payout within AI range, publishes
 * 4. Project status = 'active', project_wallet row created (deposited = 0)
 */

import { getSupabase } from "../auth/index.js";
import { requireAuth } from "../auth/middleware.js";
import { generateScopedTasks } from "../handlers/scope.js";
import type { ScopedTask } from "@fatedfortress/protocol";
import { renderShell } from "../ui/shell.js";

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

          <button class="ff-btn" id="scope-btn" type="button" style="margin-top:auto">
            <span class="btn-text">FORGE_BLUEPRINT</span>
            <span class="btn-loading hidden">FORGING...</span>
          </button>
        </section>
      </div>

      <!-- Full-screen generation phase overlay (high-contrast, keeps density) -->
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

      <div class="ff-panel hidden" id="scoped-preview" style="margin-top:16px">
        <div id="scoped-readme"></div>
        <div id="scoped-structure" style="margin-top:10px"></div>
        <h2 class="ff-h1" style="font-size:16px;margin-top:16px">Generated Tasks</h2>
        <p class="ff-subtitle">Review and set final payouts, then publish.</p>
        <div id="scoped-tasks" style="margin-top:10px"></div>
        <div style="display:flex; gap:10px; margin-top:14px">
          <button class="ff-btn" style="background: var(--ff-paper); color: var(--ff-ink); flex:1" id="re-scope-btn">REGENERATE</button>
          <button class="ff-btn" style="flex:1" id="publish-btn">PUBLISH_TASKS</button>
        </div>
      </div>
    `,
  });

  // ── State ─────────────────────────────────────────────────────────
  let generatedTasks: ScopedTask[] = [];
  let generatedReadme = "";
  let generatedFolderStructure: string[] = [];
  let projectId: string | null = null;
  let references: string[] = [];
  let persistedTaskRows: Array<Record<string, unknown>> = [];

  // ── Events ───────────────────────────────────────────────────────────
  const $form = container.querySelector("#create-form") as HTMLFormElement;
  const $scopeBtn = container.querySelector("#scope-btn") as HTMLButtonElement;
  const $btnText = container.querySelector(".btn-text") as HTMLElement;
  const $btnLoading = container.querySelector(".btn-loading") as HTMLElement;
  const $preview = container.querySelector("#scoped-preview") as HTMLElement;
  const $taskList = container.querySelector("#scoped-tasks") as HTMLElement;
  const $readme = container.querySelector("#scoped-readme") as HTMLElement;
  const $structure = container.querySelector("#scoped-structure") as HTMLElement;

  // Heavy action button triggers forge
  $scopeBtn.addEventListener("click", async () => {
    if (!$scopeBtn.disabled) await handleScope();
  });

  container.querySelector("#publish-btn")?.addEventListener("click", handlePublish);
  container.querySelector("#re-scope-btn")?.addEventListener("click", handleScope);

  const $descTextarea = container.querySelector("#project-description") as HTMLTextAreaElement;
  $descTextarea.addEventListener("input", () => {
    (container.querySelector("#desc-count") as HTMLElement).textContent = String($descTextarea.value.length);
  });

  // ── Handle SCOPE ────────────────────────────────────────────────────
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

    try {
      // Deterministic project id so SCOPE + DB persistence match
      projectId = crypto.randomUUID();

      // 1) Call SCOPE AI with ScopeProjectIntent (the "Moment")
      const result = await generateScopedTasks({
        projectId,
        title,
        description,
        projectType,
        referenceUrls: references,
        budgetRange: { min: budgetMin, max: budgetMax },
        targetTimeline: targetTimeline || undefined,
      });

      generatedTasks = result.tasks;
      generatedReadme = result.readmeDraft;
      generatedFolderStructure = result.folderStructure;

      if (generatedTasks.length === 0) {
        throw new Error("No tasks generated");
      }

      // 2) Persist blueprint artifacts + tasks atomically (single transaction)
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

      // Fetch inserted tasks to get real IDs for payout editing
      const { data: insertedTasks, error: tasksErr } = await supabase
        .from("tasks")
        .select("id, payout_min, payout_max, title")
        .eq("project_id", projectId)
        .order("created_at", { ascending: true });
      if (tasksErr) throw new Error(`Task fetch failed: ${tasksErr.message}`);
      persistedTaskRows = (insertedTasks ?? []) as Array<Record<string, unknown>>;

      // 3) Show preview
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

  // ── Handle Publish ───────────────────────────────────────────────────
  async function handlePublish(): Promise<void> {
    if (!projectId) return;

    const $payoutInputs = $taskList.querySelectorAll(".task-payout-input") as NodeListOf<HTMLInputElement>;
    const updates: Promise<unknown>[] = [];

    $payoutInputs.forEach((input, i) => {
      const taskId = input.dataset.taskId!;
      const payout = parseFloat(input.value);
      const task = generatedTasks[i];
      if (!isNaN(payout) && task && payout >= task.payoutMin && payout <= task.payoutMax) {
        updates.push(
          supabase
            .from("tasks")
            .update({
              status: "open",
              payout_max: payout,
              updated_at: new Date().toISOString(),
            } as Record<string, unknown>)
            .eq("id", taskId) as unknown as Promise<unknown>
        );
      }
    });

    await Promise.all(updates);

    // Publish project
    await supabase
      .from("projects")
      .update({ status: "active", updated_at: new Date().toISOString() } as Record<string, unknown>)
      .eq("id", projectId);

    // Create project_wallet row with deposited = 0 (Section 3.2)
    await supabase
      .from("project_wallet")
      .insert({ project_id: projectId, deposited: 0, locked: 0, released: 0 } as Record<string, unknown>);

    // Audit log
    await supabase.from("audit_log").insert({
      actor_id: user.id,
      task_id: null,
      action: "task_published",
      payload: { projectId, count: generatedTasks.length },
    } as Record<string, unknown>);

    window.location.href = `/project/${projectId}`;
  }

  // ── Render task preview ───────────────────────────────────────────────
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

  // ── Forge overlay (high-contrast generation phase) ─────────────────────
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
      // Fake progress up to 90% while awaiting the real result.
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

  container.querySelector("#add-ref-btn")?.addEventListener("click", () => {
    (container.querySelector("#ref-input") as HTMLInputElement)?.click();
  });

  return () => {};
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
