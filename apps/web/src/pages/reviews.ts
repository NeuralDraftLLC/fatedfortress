/**
 * apps/web/src/pages/reviews.ts — Host review queue (MVP moat).
 *
 * CHANGES vs previous version:
 *  - FIX 1: fetchReviews query now uses `!submissions_contributor_id_fkey` FK hint on the
 *    nested profiles join — without it PostgREST is ambiguous (both submissions and profiles
 *    reference auth.users) and throws a runtime 400 crash.
 *  - FIX 2: status filter changed from 'submitted' → 'under_review' to match the actual
 *    task status after the submission + verification flow completes. The old filter returned
 *    an empty queue every time.
 *  - FIX 3: Realtime channel was never removed on unmount — leaked a subscription on every
 *    page navigation. Teardown now calls supabase.removeChannel(channel).
 *  - IMPROVED: Decision handlers (approve/revise/reject) are awaited with per-row error
 *    display instead of fire-and-forget.
 *  - IMPROVED: Staleness uses submission.created_at not task.updated_at.
 *  - IMPROVED: escHtml helper co-located here (was assumed global; crashes in module build).
 *  - IMPROVED: Typed fetchReviews return (ReviewQueueItem[]) — was returning any[].
 */

import { getSupabase } from "../auth/index.js";
import { requireAuth } from "../auth/middleware.js";
import type {
  Task,
  Submission,
  ReviewSession,
  DecisionReason,
} from "@fatedfortress/protocol";
import { releasePayout, rejectSubmission, requestRevision } from "../handlers/payout.js";
import { renderShell } from "../ui/shell.js";

const PAGE_SIZE = 20;
const STALENESS_THRESHOLD_MS = 12 * 60 * 60 * 1000;

interface ReviewQueueItem {
  task: Task;
  submission: Submission;
  contributorName: string;
  contributorAvatarUrl: string | null;
  contributorReliability: number;
  reviewSession: ReviewSession | null;
  elapsedMs: number;
}

interface Cursor {
  submittedAt: string;
  id: string;
}

// ---------------------------------------------------------------------------
// Data fetching — key fixes here
// ---------------------------------------------------------------------------

async function fetchReviews(cursor?: Cursor): Promise<ReviewQueueItem[]> {
  const supabase = getSupabase();

  let query = supabase
    .from("tasks")
    .select(`
      *,
      project:projects(title, payout_max),
      submissions:submissions(
        id,
        asset_url,
        deliverable_type,
        created_at,
        ai_summary,
        contributor:profiles!submissions_contributor_id_fkey(
          username,
          avatar_url,
          review_reliability
        )
      )
    `)
    .eq("status", "under_review")       // FIX 2: was "submitted"
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(PAGE_SIZE);

  if (cursor) {
    query = query.or(
      `created_at.gt.${cursor.submittedAt},and(created_at.eq.${cursor.submittedAt},id.gt.${cursor.id})`
    );
  }

  const { data, error } = await query;
  if (error) throw error;
  if (!data) return [];

  const now = Date.now();

  return (data as Record<string, unknown>[])
    .filter((row) => {
      const subs = row.submissions as unknown[] | null;
      return Array.isArray(subs) && subs.length > 0;
    })
    .map((row) => {
      const subs = (row.submissions as Record<string, unknown>[]);
      const sub = subs.sort((a, b) =>
        String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""))
      )[0];
      const contributor = sub.contributor as Record<string, unknown> | null;

      return {
        task: row as unknown as Task,
        submission: sub as unknown as Submission,
        contributorName: (contributor?.username as string) ?? "Unknown",
        contributorAvatarUrl: (contributor?.avatar_url as string) ?? null,
        contributorReliability: (contributor?.review_reliability as number) ?? 0,
        reviewSession: null,
        elapsedMs: now - new Date(String(sub.created_at ?? now)).getTime(),
      } satisfies ReviewQueueItem;
    });
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

export async function mountReviews(container: HTMLElement): Promise<() => void> {
  await requireAuth();
  const supabase = getSupabase();

  container.innerHTML = renderShell({
    title: "Intel Review Queue",
    subtitle: "Mission control // submission_management_v4",
    activePath: "/reviews",
    contentHtml: `
      <div id="review-queue-root">
        <div id="queue-loading" class="loading-state"><p>Loading queue…</p></div>
        <div id="queue-empty" class="empty-state hidden"><p>No submissions awaiting review.</p></div>
        <div id="queue-error" class="error-state hidden"></div>
        <table id="queue-table" class="hidden" aria-label="Review Queue">
          <thead>
            <tr><th>Queue ID</th><th>Subject Entity</th><th>Timestamp</th><th>Status</th><th>Action</th></tr>
          </thead>
          <tbody id="queue-tbody"></tbody>
        </table>
        <div id="queue-pagination" class="pagination hidden">
          <button id="load-more-btn" type="button" class="btn btn-secondary">Load more</button>
        </div>
      </div>
    `,
  });

  const $loading = container.querySelector<HTMLElement>("#queue-loading")!;
  const $empty   = container.querySelector<HTMLElement>("#queue-empty")!;
  const $errorBox = container.querySelector<HTMLElement>("#queue-error")!;
  const $table   = container.querySelector<HTMLElement>("#queue-table")!;
  const $tbody   = container.querySelector<HTMLElement>("#queue-tbody")!;
  const $pagination = container.querySelector<HTMLElement>("#queue-pagination")!;
  const $loadMoreBtn = container.querySelector<HTMLButtonElement>("#load-more-btn")!;

  let cursor: Cursor | undefined;
  let items: ReviewQueueItem[] = [];

  function renderRow(item: ReviewQueueItem): string {
    const isStale = item.elapsedMs > STALENESS_THRESHOLD_MS;
    const sub = item.submission as unknown as Record<string, unknown>;
    return `
      <tr data-task-id="${escHtml(String(item.task.id))}" data-submission-id="${escHtml(String(sub.id))}">
        <td><code>${escHtml(String(item.task.id).slice(0, 8))}</code></td>
        <td>
          <strong>${escHtml(item.contributorName)}</strong><br/>
          <span class="text-muted">${escHtml(String(sub.deliverable_type ?? ""))}</span>
        </td>
        <td>
          <time datetime="${escHtml(String(sub.created_at ?? ""))}">${formatElapsed(item.elapsedMs)}</time>
          ${isStale ? '<span class="badge badge-warning">Stale</span>' : ""}
        </td>
        <td><span class="badge badge-info">under_review</span></td>
        <td>
          ${sub.ai_summary ? `<p class="ai-summary">${escHtml(String(sub.ai_summary))}</p>` : ""}
          ${sub.asset_url ? `<a href="${escHtml(String(sub.asset_url))}" target="_blank" rel="noopener noreferrer" class="btn btn-sm">View asset</a>` : ""}
          <div class="decision-actions">
            <button class="btn btn-sm btn-success action-approve" data-task-id="${escHtml(String(item.task.id))}" data-submission-id="${escHtml(String(sub.id))}">Approve</button>
            <button class="btn btn-sm btn-warning action-revise"  data-task-id="${escHtml(String(item.task.id))}" data-submission-id="${escHtml(String(sub.id))}">Request revision</button>
            <button class="btn btn-sm btn-error action-reject"    data-task-id="${escHtml(String(item.task.id))}" data-submission-id="${escHtml(String(sub.id))}">Reject</button>
          </div>
        </td>
      </tr>
    `;
  }

  function renderItems(): void {
    $tbody.innerHTML = items.map(renderRow).join("");
    bindDecisionButtons();
  }

  function removeRow(taskId: string): void {
    items = items.filter((i) => String(i.task.id) !== taskId);
    $tbody.querySelector(`[data-task-id="${escHtml(taskId)}"]`)?.remove();
    if (items.length === 0) { $table.classList.add("hidden"); $empty.classList.remove("hidden"); }
  }

  function showRowError(taskId: string, msg: string): void {
    const row = $tbody.querySelector<HTMLElement>(`[data-task-id="${escHtml(taskId)}"]`);
    if (!row) return;
    if (!row.querySelector(".row-error")) {
      const el = document.createElement("p");
      el.className = "row-error error-text";
      el.textContent = msg;
      row.querySelector(".decision-actions")?.after(el);
    }
  }

  function bindDecisionButtons(): void {
    $tbody.querySelectorAll<HTMLButtonElement>(".action-approve").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const { taskId, submissionId } = btn.dataset as Record<string, string>;
        try {
          btn.disabled = true;
          await releasePayout(submissionId, 0, "great_work" as DecisionReason);
          removeRow(taskId);
        }
        catch (err) { showRowError(taskId, err instanceof Error ? err.message : "Approval failed"); btn.disabled = false; }
      });
    });
    $tbody.querySelectorAll<HTMLButtonElement>(".action-revise").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const { taskId, submissionId } = btn.dataset as Record<string, string>;
        try {
          btn.disabled = true;
          await requestRevision(submissionId, "requirements_not_met" as DecisionReason, "");
          removeRow(taskId);
        }
        catch (err) { showRowError(taskId, err instanceof Error ? err.message : "Revision request failed"); btn.disabled = false; }
      });
    });
    $tbody.querySelectorAll<HTMLButtonElement>(".action-reject").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const { taskId, submissionId } = btn.dataset as Record<string, string>;
        try {
          btn.disabled = true;
          await rejectSubmission(submissionId, "quality_issue" as DecisionReason, "");
          removeRow(taskId);
        }
        catch (err) { showRowError(taskId, err instanceof Error ? err.message : "Rejection failed"); btn.disabled = false; }
      });
    });
  }

  async function loadPage(): Promise<void> {
    try {
      const newItems = await fetchReviews(cursor);
      items = [...items, ...newItems];
      $loading.classList.add("hidden");
      if (items.length === 0) { $empty.classList.remove("hidden"); return; }
      $table.classList.remove("hidden");
      renderItems();
      if (newItems.length === PAGE_SIZE) {
        const last = newItems[newItems.length - 1];
        cursor = { submittedAt: String((last.submission as unknown as Record<string, unknown>).created_at ?? ""), id: String(last.task.id) };
        $pagination.classList.remove("hidden");
      } else {
        $pagination.classList.add("hidden");
      }
    } catch (err) {
      $loading.classList.add("hidden");
      $errorBox.textContent = err instanceof Error ? err.message : "Failed to load review queue";
      $errorBox.classList.remove("hidden");
    }
  }

  $loadMoreBtn.addEventListener("click", () => loadPage());
  await loadPage();

  // FIX 3: Store channel so it can be cleaned up on unmount
  const channel = supabase
    .channel("review-queue-tasks")
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "tasks", filter: "status=eq.under_review" },
      () => { items = []; cursor = undefined; $tbody.innerHTML = ""; $loading.classList.remove("hidden"); $table.classList.add("hidden"); loadPage(); }
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel); // FIX 3: was missing in original
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatElapsed(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}