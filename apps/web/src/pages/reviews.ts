/**
 * apps/web/src/pages/reviews.ts — Host review queue (MVP moat).
 *
 * Sacred objects: Task, Submission, Decision
 *
 * Review queue contract (Section 2.3):
 *   Primary sort: submitted_at ASC  (oldest first — prevents starvation)
 *   Secondary sort: payout_max DESC  (higher value within same age cohort)
 *   Page size: 20, cursor pagination via (submitted_at, id)
 *   Staleness badge: warning on items in under_review > 12h
 *   Realtime: subscribe to tasks for new under_review items
 *
 * Review decision → releasePayout / rejectSubmission / requestRevision
 * → decision_reason written to decisions table → review_reliability updated.
 */

import { getSupabase } from "../auth/index.js";
import { requireAuth } from "../auth/middleware.js";
import type {
  Task,
  Submission,
  ReviewSession,
  DecisionReason,
  StructuredFeedback,
} from "@fatedfortress/protocol";
import { releasePayout, rejectSubmission, requestRevision } from "../handlers/payout.js";
import { renderShell } from "../ui/shell.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAGE_SIZE = 20;
const STALENESS_THRESHOLD_MS = 12 * 60 * 60 * 1000; // 12 hours

type DecisionReasonOption = { value: DecisionReason; label: string };

const DECISION_REASONS: DecisionReasonOption[] = [
  { value: "great_work",           label: "Great work" },
  { value: "approved_fast_track",  label: "Approved fast" },
  { value: "requirements_not_met", label: "Requirements not met" },
  { value: "quality_issue",        label: "Quality issue" },
  { value: "scope_mismatch",       label: "Scope mismatch" },
  { value: "missing_files",        label: "Missing files" },
];

const FEEDBACK_DIMENSIONS: string[] = ["lighting", "timing", "quality", "style", "scope"];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ReviewQueueItem {
  task: Task;
  submission: Submission;
  contributorName: string;
  contributorReliability: number;
  reviewSession: ReviewSession | null;
  elapsedMs: number; // time since submission for staleness display
}

interface Cursor {
  submittedAt: string; // ISO string
  id: string;
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

export async function mountReviews(container: HTMLElement): Promise<() => void> {
  requireAuth();

  container.innerHTML = renderShell({
    title: "Intel Review Queue",
    subtitle: "Mission control // submission_management_v4",
    activePath: "/reviews",
    contentHtml: `
      <div class="ff-grid">
        <section class="ff-panel ff-panel--rust" style="grid-column: span 4;">
          <div class="ff-kpi__label">AVG_WAIT_TIME</div>
          <div class="ff-kpi__value" id="kpi-wait">--</div>
          <div class="ff-subtitle">minutes</div>
        </section>
        <section class="ff-panel" style="grid-column: span 4;">
          <div class="ff-kpi__label">CRITICAL_LOAD</div>
          <div class="ff-kpi__value" id="kpi-load">--</div>
          <div class="ff-subtitle">queue pressure</div>
        </section>
        <section class="ff-panel" style="grid-column: span 4;">
          <div class="ff-kpi__label">THROUGHPUT</div>
          <div class="ff-kpi__value" id="kpi-throughput">--</div>
          <div class="ff-subtitle">req/hr</div>
        </section>
      </div>

      <div class="ff-panel" style="margin-top:12px">
        <div style="display:flex; gap:8px; margin-bottom:12px; flex-wrap:wrap">
          <button class="ff-btn filter-btn active" data-filter="under_review" style="width:auto; padding:10px 12px; background:#1a1614; border-color: var(--ff-rust);">
            UNDER_REVIEW <span class="badge" id="count-under-review">0</span>
          </button>
          <button class="ff-btn filter-btn" data-filter="revision_requested" style="width:auto; padding:10px 12px; background:#1a1614; border-color: var(--ff-rust);">
            REVISION <span class="badge" id="count-revision">0</span>
          </button>
          <button class="ff-btn filter-btn" data-filter="paid" style="width:auto; padding:10px 12px; background:#1a1614; border-color: var(--ff-rust);">
            APPROVED <span class="badge" id="count-approved">0</span>
          </button>
        </div>

        <div class="reviews-empty hidden" id="reviews-empty">
          <p class="ff-subtitle">No submissions to review.</p>
        </div>

        <table class="ff-intel-table" style="width:100%; border-collapse: collapse; font-family: var(--ff-font-mono);">
          <thead>
            <tr>
              <th style="text-align:left; padding:10px; border:1px solid var(--ff-ink);">QUEUE_ID</th>
              <th style="text-align:left; padding:10px; border:1px solid var(--ff-ink);">SUBJECT_ENTITY</th>
              <th style="text-align:left; padding:10px; border:1px solid var(--ff-ink);">TIMESTAMP</th>
              <th style="text-align:left; padding:10px; border:1px solid var(--ff-ink);">STATUS</th>
              <th style="text-align:right; padding:10px; border:1px solid var(--ff-ink);">ACTION</th>
            </tr>
          </thead>
          <tbody id="reviews-list"></tbody>
        </table>

        <div id="reviews-load-more" style="display:none; margin-top:12px">
          <button class="ff-btn" style="background:#1a1614;border-color:var(--ff-rust); width:auto; padding:10px 12px" id="btn-load-more">LOAD_MORE</button>
        </div>

        <!-- Decision modal -->
        <div class="decision-modal hidden" id="decision-modal">
          <div class="decision-modal__backdrop"></div>
          <div class="decision-modal__panel">
            <h2 class="decision-modal__title" id="decision-modal-title">Make Decision</h2>
            <p class="decision-modal__task-title" id="decision-modal-task"></p>

            <div class="decision-modal__reason">
              <label for="decision-reason">Reason (required)</label>
              <select id="decision-reason" required>
                <option value="">Select a reason...</option>
                ${DECISION_REASONS.map(r => `<option value="${r.value}">${r.label}</option>`).join("")}
              </select>
            </div>

            <div class="decision-modal__notes">
              <label for="decision-notes">Notes (optional)</label>
              <textarea id="decision-notes" rows="3" placeholder="Explain your decision..."></textarea>
            </div>

            <div class="decision-modal__structured-feedback" id="structured-feedback-section">
              <label>Structured feedback (optional)</label>
              <div class="feedback-dimensions" id="feedback-dimensions">
                ${FEEDBACK_DIMENSIONS.map(d => `
                  <button class="feedback-dim-btn" data-dim="${d}">${d}</button>
                `).join("")}
              </div>
              <textarea id="structured-feedback-notes" rows="2" placeholder="Notes per dimension..."></textarea>
            </div>

            <div class="decision-modal__payout" id="decision-payout-row">
              <label for="decision-payout">Approved payout (within range)</label>
              <input type="number" id="decision-payout" step="0.01" min="0" placeholder="0.00" />
            </div>

            <div class="decision-modal__deadline" id="decision-deadline-row">
              <label for="decision-deadline">Revision deadline (optional)</label>
              <input type="datetime-local" id="decision-deadline" />
            </div>

            <div class="decision-modal__actions">
              <button class="ff-btn" style="width:auto; padding:10px 12px" id="action-approve">Approve &amp; Pay</button>
              <button class="ff-btn" style="width:auto; padding:10px 12px; background:#1a1614;border-color:var(--ff-rust)" id="action-revision">Request Revision</button>
              <button class="ff-btn" style="width:auto; padding:10px 12px; background:#1a1614;border-color:var(--ff-error); color: var(--ff-error)" id="action-reject">Reject</button>
              <button class="ff-btn" style="width:auto; padding:10px 12px; background:#1a1614;border-color:var(--ff-rust)" id="action-cancel">Cancel</button>
            </div>
          </div>
        </div>
      </div>
    `,
  });

  // ── State ──────────────────────────────────────────────────────────────
  let currentFilter: Task["status"] = "under_review";
  let items: ReviewQueueItem[] = [];
  let activeItem: ReviewQueueItem | null = null;
  let cursor: Cursor | null = null;
  let hasMore = false;
  let loadingMore = false;

  // Track selected structured feedback dimensions
  let selectedDimensions: string[] = [];

  const $list = container.querySelector("#reviews-list") as HTMLElement;
  const $empty = container.querySelector("#reviews-empty") as HTMLElement;
  const $loadMore = container.querySelector("#reviews-load-more") as HTMLElement;
  const $modal = container.querySelector("#decision-modal") as HTMLElement;

  // ── Supabase Realtime subscription ─────────────────────────────────────
  const supabase = getSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const channel = supabase
    .channel("reviews-queue-realtime")
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "tasks",
        filter: `status=eq.under_review`,
      },
      async (payload) => {
        // New under_review task for this host → re-fetch from top
        const task = payload.new as Record<string, unknown>;
        const { data: proj } = await supabase
          .from("projects")
          .select("host_id")
          .eq("id", task.project_id)
          .single();
        if (proj?.host_id === user.id) {
          // Prepend new item without full reload
          items = [];
          cursor = null;
          await fetchQueue();
        }
      }
    )
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "tasks",
      },
      async (payload) => {
        // Status change on a task we may be showing
        const task = payload.new as Record<string, unknown>;
        if (task.status === "paid" || task.status === "rejected") {
          // Remove acted-on items immediately
          items = items.filter(i => i.task.id !== task.id);
          render();
        }
      }
    )
    .subscribe();

  // ── Fetch review queue ─────────────────────────────────────────────────
  async function fetchQueue(append = false): Promise<void> {
    const supabase = getSupabase();

    // Build query: host's tasks in relevant statuses
    let query = supabase
      .from("tasks")
      .select(`
        *,
        project:projects(id, host_id, title),
        submissions:submissions(
          id,
          task_id,
          contributor_id,
          asset_url,
          deliverable_type,
          ai_summary,
          revision_number,
          created_at,
          updated_at,
          contributor:profiles(id, display_name, review_reliability)
        )
      `)
      .in("status", ["under_review", "revision_requested", "paid"])
      .order("submitted_at", { ascending: true })
      .order("payout_max", { ascending: false })
      .limit(PAGE_SIZE);

    // Apply cursor (submitted_at, id) for pagination
    if (cursor && append) {
      query = query
        .gt("submitted_at", cursor.submittedAt)
        .or(`submitted_at.eq.${cursor.submittedAt},id.gt.${cursor.id}`);
    }

    const { data: tasks, error } = await query;

    if (error || !tasks) return;

    // Filter to only this host's tasks (RLS handles security but we also filter client-side)
    const hostTasks = tasks.filter((t: any) => t.project?.host_id === user.id);

    const queueItems: ReviewQueueItem[] = hostTasks
      .map((t: any) => {
        const sub = Array.isArray(t.submissions)
          ? [...t.submissions].sort((a: any, b: any) =>
              b.created_at.localeCompare(a.created_at)
            )[0]
          : null;
        if (!sub) return null;
        return {
          task: toTask(t),
          submission: toSubmission(sub),
          contributorName: sub.contributor?.display_name ?? "Unknown",
          contributorReliability: sub.contributor?.review_reliability ?? 0,
          reviewSession: null,
          elapsedMs: t.submitted_at
            ? Date.now() - new Date(t.submitted_at).getTime()
            : 0,
        } as ReviewQueueItem;
      })
      .filter(Boolean) as ReviewQueueItem[];

    if (append) {
      items.push(...queueItems);
    } else {
      items = queueItems;
    }

    // Update cursor
    if (queueItems.length === PAGE_SIZE) {
      const last = queueItems[queueItems.length - 1];
      cursor = {
        submittedAt: new Date(last.task.submitted_at ?? Date.now()).toISOString(),
        id: last.task.id,
      };
      hasMore = true;
    } else {
      hasMore = false;
      cursor = null;
    }

    render();
  }

  // ── Render ───────────────────────────────────────────────────────────
  function render(): void {
    const filtered = items.filter(item => {
      if (currentFilter === "under_review") {
        return item.task.status === "under_review" || item.task.status === "submitted";
      }
      return item.task.status === currentFilter;
    });

    // Update badges
    const counts = {
      under_review: items.filter(i => i.task.status === "under_review" || i.task.status === "submitted").length,
      revision_requested: items.filter(i => i.task.status === "revision_requested").length,
      paid: items.filter(i => i.task.status === "paid").length,
    };

    (container.querySelector("#count-under-review") as HTMLElement).textContent = String(counts.under_review);
    (container.querySelector("#count-revision") as HTMLElement).textContent = String(counts.revision_requested);
    (container.querySelector("#count-approved") as HTMLElement).textContent = String(counts.paid);

    if (filtered.length === 0 && items.length === 0) {
      $list.innerHTML = "";
      $list.appendChild($empty);
      $empty.classList.remove("hidden");
      $loadMore.style.display = "none";
      return;
    }

    $empty.classList.add("hidden");
    $list.innerHTML = filtered.map(item => renderCard(item)).join("");

    // Load more button visibility
    $loadMore.style.display = hasMore ? "block" : "none";
    (container.querySelector("#btn-load-more") as HTMLButtonElement).disabled = loadingMore;

    attachCardListeners();
  }

  function attachCardListeners(): void {
    $list.querySelectorAll("tr[data-task-id]").forEach(row => {
      const taskId = (row as HTMLElement).dataset.taskId!;
      const submissionId = (row as HTMLElement).dataset.submissionId!;
      const item = itemById(taskId, submissionId);
      if (!item) return;

      row.querySelector(".btn--open-decision")?.addEventListener("click", () => openDecision(item));
      row.querySelector(".btn--view-session")?.addEventListener("click", () => openReviewSession(item));
    });
  }

  function renderCard(item: ReviewQueueItem): string {
    const elapsedMs = item.task.submitted_at
      ? Date.now() - item.task.submitted_at
      : item.elapsedMs;
    const elapsedMin = Math.floor(elapsedMs / 60000);
    const isStale = elapsedMs > STALENESS_THRESHOLD_MS;
    const urgency = isStale ? "urgent" : elapsedMs > 60 * 60 * 1000 ? "warning" : "";

    const queueId = `#SUB-${String(item.submission.id).slice(0, 4).toUpperCase()}-${String(item.task.id).slice(0, 2).toUpperCase()}`;
    const subject = (item.task.title ?? "").toUpperCase().replace(/\s+/g, "_").slice(0, 40);
    const ts = item.task.submitted_at ? new Date(item.task.submitted_at).toISOString().replace("T", " // ").slice(0, 16) : "—";
    const statusLabel = isStale ? "STALE_URGENT" : item.task.status.toUpperCase();
    const statusChip = `<span style="border:1px solid var(--ff-ink); padding:2px 6px; font-size:10px; font-weight:900;">${escHtml(statusLabel)}</span>`;

    return `
      <tr class="${urgency}" data-task-id="${item.task.id}" data-submission-id="${item.submission.id}">
        <td style="padding:10px; border:1px solid var(--ff-ink);">${escHtml(queueId)}</td>
        <td style="padding:10px; border:1px solid var(--ff-ink); font-weight:900; text-transform:uppercase;">
          ${escHtml(subject)}
          <div style="margin-top:4px; font-size:10px; color: var(--ff-muted);">${escHtml((item.task as any).project?.title ?? "")}</div>
        </td>
        <td style="padding:10px; border:1px solid var(--ff-ink); color: var(--ff-muted);">${escHtml(ts)}<div style="margin-top:4px; font-size:10px;">${elapsedMin < 1 ? "JUST_NOW" : `${elapsedMin}M_AGO`}</div></td>
        <td style="padding:10px; border:1px solid var(--ff-ink);">${statusChip}</td>
        <td style="padding:10px; border:1px solid var(--ff-ink); text-align:right;">
          <button class="ff-btn btn--open-decision" style="width:auto; padding:10px 12px;">START_REVIEW</button>
        </td>
      </tr>
    `;
  }

  function renderDeliverablePreview(sub: Submission): string {
    const type = sub.deliverable_type ?? "file";
    if (type === "text" || !sub.asset_url) {
      return `<div class="deliverable-preview deliverable-preview--text">
        <p>${escHtml(sub.ai_summary ?? "No summary")}</p>
        ${sub.asset_url ? `<a href="${escHtml(sub.asset_url)}" target="_blank">View asset</a>` : ""}
      </div>`;
    }
    if (sub.asset_url.match(/\.(jpg|jpeg|png|gif|webp|svg)$/i)) {
      return `<div class="deliverable-preview deliverable-preview--image">
        <img src="${escHtml(sub.asset_url)}" alt="Submitted asset" loading="lazy" />
        <a href="${escHtml(sub.asset_url)}" target="_blank">Open</a>
      </div>`;
    }
    return `<div class="deliverable-preview deliverable-preview--file">
      <a href="${escHtml(sub.asset_url)}" target="_blank">Download / View</a>
    </div>`;
  }

  function itemById(taskId: string, submissionId: string): ReviewQueueItem | undefined {
    return items.find(i => i.task.id === taskId && i.submission.id === submissionId);
  }

  // ── Decision modal ─────────────────────────────────────────────────────
  function openDecision(item: ReviewQueueItem): void {
    activeItem = item;
    selectedDimensions = [];
    (container.querySelector("#decision-modal-task") as HTMLElement).textContent = item.task.title;

    const payoutInput = container.querySelector("#decision-payout") as HTMLInputElement;
    payoutInput.value = String(
      item.task.approved_payout ?? ((item.task.payout_min + item.task.payout_max) / 2)
    );

    (container.querySelector("#decision-reason") as HTMLSelectElement).value = "";
    (container.querySelector("#decision-notes") as HTMLTextAreaElement).value = "";
    (container.querySelector("#structured-feedback-notes") as HTMLTextAreaElement).value = "";
    (container.querySelector("#decision-deadline") as HTMLInputElement).value = "";

    // Reset dimension buttons
    container.querySelectorAll(".feedback-dim-btn").forEach(btn => {
      (btn as HTMLButtonElement).classList.remove("active");
    });

    $modal.classList.remove("hidden");
  }

  function closeDecision(): void {
    $modal.classList.add("hidden");
    activeItem = null;
  }

  function buildStructuredFeedback(): StructuredFeedback[] | undefined {
    const notes = (container.querySelector("#structured-feedback-notes") as HTMLTextAreaElement).value.trim();
    if (selectedDimensions.length === 0 && !notes) return undefined;
    if (notes) {
      return selectedDimensions.map(dim => ({ dimension: dim, note: notes }));
    }
    return selectedDimensions.map(dim => ({ dimension: dim, note: "" }));
  }

  async function handleApprove(): Promise<void> {
    if (!activeItem) return;
    const reason = (container.querySelector("#decision-reason") as HTMLSelectElement).value as DecisionReason;
    const notes = (container.querySelector("#decision-notes") as HTMLTextAreaElement).value;
    const payoutStr = (container.querySelector("#decision-payout") as HTMLInputElement).value;
    const payout = parseFloat(payoutStr);

    if (!reason) { alert("Please select a reason"); return; }
    if (isNaN(payout) || payout <= 0) { alert("Invalid payout amount"); return; }
    if (payout < activeItem.task.payout_min || payout > activeItem.task.payout_max) {
      alert(`Payout must be between $${activeItem.task.payout_min} and $${activeItem.task.payout_max}`); return;
    }

    try {
      await releasePayout(activeItem.submission.id, payout, reason, notes || undefined, buildStructuredFeedback());
      closeDecision();
      items = items.filter(i => i.task.id !== activeItem!.task.id);
      render();
    } catch (err: any) {
      alert(`Approval failed: ${err.message}`);
    }
  }

  async function handleReject(): Promise<void> {
    if (!activeItem) return;
    const reason = (container.querySelector("#decision-reason") as HTMLSelectElement).value as DecisionReason;
    const notes = (container.querySelector("#decision-notes") as HTMLTextAreaElement).value;
    if (!reason) { alert("Please select a reason"); return; }

    try {
      await rejectSubmission(activeItem.submission.id, reason, notes, buildStructuredFeedback());
      closeDecision();
      items = items.filter(i => i.task.id !== activeItem!.task.id);
      render();
    } catch (err: any) {
      alert(`Rejection failed: ${err.message}`);
    }
  }

  async function handleRevision(): Promise<void> {
    if (!activeItem) return;
    const reason = (container.querySelector("#decision-reason") as HTMLSelectElement).value as DecisionReason;
    const notes = (container.querySelector("#decision-notes") as HTMLTextAreaElement).value;
    if (!reason) { alert("Please select a reason"); return; }

    try {
      const deadlineStr = (container.querySelector("#decision-deadline") as HTMLInputElement).value;
      const deadline = deadlineStr ? new Date(deadlineStr) : undefined;
      await requestRevision(activeItem.submission.id, reason, notes, buildStructuredFeedback(), deadline);
      closeDecision();
      items = items.filter(i => i.task.id !== activeItem!.task.id);
      render();
    } catch (err: any) {
      alert(`Revision request failed: ${err.message}`);
    }
  }

  async function openReviewSession(item: ReviewQueueItem): Promise<void> {
    alert("Review session: Y.js collab coming soon. Use the Review button for now.");
  }

  // ── Event bindings ──────────────────────────────────────────────────────
  container.querySelectorAll(".filter-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      container.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      currentFilter = (btn as HTMLElement).dataset.filter as Task["status"];
      items = [];
      cursor = null;
      fetchQueue();
    });
  });

  container.querySelector("#btn-load-more")?.addEventListener("click", async () => {
    if (!hasMore || loadingMore) return;
    loadingMore = true;
    (container.querySelector("#btn-load-more") as HTMLButtonElement).disabled = true;
    await fetchQueue(true);
    loadingMore = false;
  });

  // Dimension buttons
  container.querySelectorAll(".feedback-dim-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const dim = (btn as HTMLButtonElement).dataset.dim!;
      if (selectedDimensions.includes(dim)) {
        selectedDimensions = selectedDimensions.filter(d => d !== dim);
        (btn as HTMLButtonElement).classList.remove("active");
      } else {
        selectedDimensions.push(dim);
        (btn as HTMLButtonElement).classList.add("active");
      }
    });
  });

  $modal.querySelector(".decision-modal__backdrop")?.addEventListener("click", closeDecision);
  container.querySelector("#action-cancel")?.addEventListener("click", closeDecision);
  container.querySelector("#action-approve")?.addEventListener("click", handleApprove);
  container.querySelector("#action-reject")?.addEventListener("click", handleReject);
  container.querySelector("#action-revision")?.addEventListener("click", handleRevision);

  // ── Initial load ────────────────────────────────────────────────────────
  await fetchQueue();

  // ── Cleanup ────────────────────────────────────────────────────────────
  return () => {
    supabase.removeChannel(channel);
  };
}

// ---------------------------------------------------------------------------
// Type mappers (Supabase returns snake_case)
// ---------------------------------------------------------------------------

function toTask(raw: any): Task {
  return {
    id: raw.id,
    project_id: raw.project_id,
    title: raw.title,
    description: raw.description,
    payout_min: parseFloat(raw.payout_min),
    payout_max: parseFloat(raw.payout_max),
    approved_payout: raw.approved_payout != null ? parseFloat(raw.approved_payout) : null,
    ambiguity_score: raw.ambiguity_score != null ? parseFloat(raw.ambiguity_score) : null,
    estimated_minutes: raw.estimated_minutes,
    task_access: raw.task_access,
    status: raw.status,
    claimed_by: raw.claimed_by,
    claimed_at: raw.claimed_at ? new Date(raw.claimed_at).getTime() : null,
    soft_lock_expires_at: raw.soft_lock_expires_at ? new Date(raw.soft_lock_expires_at).getTime() : null,
    submitted_at: raw.submitted_at ? new Date(raw.submitted_at).getTime() : null,
    reviewed_at: raw.reviewed_at ? new Date(raw.reviewed_at).getTime() : null,
    created_at: new Date(raw.created_at).getTime(),
    updated_at: raw.updated_at ? new Date(raw.updated_at).getTime() : new Date(raw.created_at).getTime(),
  };
}

function toSubmission(raw: any): Submission {
  return {
    id: raw.id,
    task_id: raw.task_id,
    contributor_id: raw.contributor_id,
    asset_url: raw.asset_url,
    deliverable_type: raw.deliverable_type,
    ai_summary: raw.ai_summary,
    revision_number: raw.revision_number ?? 1,
    created_at: new Date(raw.created_at).getTime(),
    updated_at: raw.updated_at ? new Date(raw.updated_at).getTime() : new Date(raw.created_at).getTime(),
  };
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
