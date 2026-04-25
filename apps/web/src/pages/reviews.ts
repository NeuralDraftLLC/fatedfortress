/**
 * apps/web/src/pages/reviews.ts — Host review queue (MVP moat).
 *
 * Three-column Crucible layout:
 *   LEFT  (280px) — scrollable queue of ReviewQueueItem cards
 *   CENTER (flex-1) — asset preview zone (image / audio / code / link)
 *   RIGHT  (320px) — contributor info, reliability, AI summary, decision panel
 *
 * All data-fetching, cursor pagination, realtime channel, and decision
 * handlers are preserved from the previous version.
 *
 * CHANGES vs previous version:
 *  - FIX 1: fetchReviews query uses `!submissions_contributor_id_fkey` FK hint
 *  - FIX 2: status filter 'submitted' → 'under_review'
 *  - FIX 3: Realtime channel teardown via supabase.removeChannel(channel)
 *  - FIX 4: Decision handlers call reviewSubmission() (review-submission edge fn)
 *  - UI:    Flat table replaced with three-column Crucible layout
 */

import { getSupabase } from "../auth/index.js";
import { requireAuth } from "../auth/middleware.js";
import type {
  Task,
  Submission,
  ReviewSession,
  DecisionReason,
} from "@fatedfortress/protocol";
import { reviewSubmission } from "../handlers/review.js";
import { renderShell } from "../ui/shell.js";
import { Spinner, EmptyState, Badge, escHtml } from "../ui/components.js";

const PAGE_SIZE = 20;
// Mark submissions as STALE after 12h in queue (badge only; no behavior change).
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
// Data fetching
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
    .eq("status", "under_review")
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
    title: "Review Queue",
    subtitle: "Crucible // submission_review_v4",
    activePath: "/reviews",
    contentHtml: `
      <div class="crucible" id="crucible-root">

        <!-- LEFT: Queue -->
        <div class="crucible__queue">
          <div class="ff-panel-header">
            <span id="queue-count-label">QUEUE</span>
            <span id="queue-loading-indicator" class="ff-badge ff-badge--neutral" style="display:none">LOADING</span>
          </div>
          <div class="crucible__queue-body" id="queue-list">
            ${Spinner({ label: "Loading queue..." })}
          </div>
          <div class="crucible__queue-footer" id="queue-footer" style="display:none">
            <button id="load-more-btn" class="ff-btn ff-btn--secondary ff-btn--sm" style="width:100%" type="button">LOAD MORE</button>
          </div>
        </div>

        <!-- CENTER: Asset Preview -->
        <div class="crucible__preview">
          <div class="ff-panel-header">
            <span id="preview-label">ASSET PREVIEW</span>
            <a id="preview-open-link" href="#" target="_blank" rel="noopener noreferrer"
               class="ff-badge ff-badge--neutral" style="display:none; text-decoration:none">OPEN ↗</a>
          </div>
          <div class="crucible__preview-body" id="preview-body">
            <div class="crucible-placeholder">
              <span>&#9632;&nbsp;SELECT SUBMISSION</span>
              <span style="font-size:9px; opacity:0.6">Choose a task from the queue to preview the asset</span>
            </div>
          </div>
        </div>

        <!-- RIGHT: Decision Panel -->
        <div class="crucible__decision">
          <div class="ff-panel-header">
            <span>ADJUDICATION</span>
          </div>
          <div class="crucible__decision-body" id="decision-body">
            <div class="crucible-placeholder">
              <span>&#9632;&nbsp;NO SELECTION</span>
            </div>
          </div>
          <div class="crucible__decision-footer" id="decision-footer" style="display:none">
            <div id="decision-error" class="ff-badge ff-badge--error" style="display:none"></div>
            <button id="btn-approve" class="ff-btn ff-btn--sm" style="width:100%; background:var(--ff-success-bg); color:var(--ff-success); border-color:var(--ff-success);" type="button">&#10003;&nbsp;APPROVE</button>
            <button id="btn-revise"  class="ff-btn ff-btn--secondary ff-btn--sm" style="width:100%;" type="button">&#9654;&nbsp;REQUEST REVISION</button>
            <button id="btn-reject"  class="ff-btn ff-btn--sm" style="width:100%; background:var(--ff-error-bg); color:var(--ff-error); border-color:var(--ff-error);" type="button">&#10007;&nbsp;REJECT</button>
          </div>
        </div>

      </div>
    `,
  });

  // ── DOM refs ───────────────────────────────────────────────────────────
  const $queueList      = container.querySelector<HTMLElement>("#queue-list")!;
  const $queueFooter    = container.querySelector<HTMLElement>("#queue-footer")!;
  const $loadMoreBtn    = container.querySelector<HTMLButtonElement>("#load-more-btn")!;
  const $queueCountLbl  = container.querySelector<HTMLElement>("#queue-count-label")!;
  const $loadingInd     = container.querySelector<HTMLElement>("#queue-loading-indicator")!;
  const $previewLabel   = container.querySelector<HTMLElement>("#preview-label")!;
  const $previewOpenLnk = container.querySelector<HTMLAnchorElement>("#preview-open-link")!;
  const $previewBody    = container.querySelector<HTMLElement>("#preview-body")!;
  const $decisionBody   = container.querySelector<HTMLElement>("#decision-body")!;
  const $decisionFooter = container.querySelector<HTMLElement>("#decision-footer")!;
  const $decisionError  = container.querySelector<HTMLElement>("#decision-error")!;
  const $btnApprove     = container.querySelector<HTMLButtonElement>("#btn-approve")!;
  const $btnRevise      = container.querySelector<HTMLButtonElement>("#btn-revise")!;
  const $btnReject      = container.querySelector<HTMLButtonElement>("#btn-reject")!;

  // ── State ─────────────────────────────────────────────────────────────────
  let cursor: Cursor | undefined;
  let items: ReviewQueueItem[] = [];
  let selectedItem: ReviewQueueItem | null = null;

  // ── Queue card renderer ──────────────────────────────────────────────────
  function renderQueueCard(item: ReviewQueueItem): string {
    const isStale = item.elapsedMs > STALENESS_THRESHOLD_MS;
    const sub = item.submission as unknown as Record<string, unknown>;
    const payout = `$${(item.task as unknown as Record<string,unknown>).payout_min ?? "?"}–$${(item.task as unknown as Record<string,unknown>).payout_max ?? "?"}`;
    const staleHtml = isStale ? Badge({ label: "STALE", variant: "warning" }) : "";
    return `
      <div class="review-card" data-task-id="${escHtml(String(item.task.id))}" role="button" tabindex="0"
           aria-label="Review submission for ${escHtml(item.task.title ?? String(item.task.id))}">
        <div class="review-card__task-title">${escHtml(item.task.title ?? String(item.task.id).slice(0, 8).toUpperCase())}</div>
        <div class="review-card__project">${escHtml(item.contributorName)}</div>
        <div style="display:flex; gap:6px; align-items:center; margin-top:6px; flex-wrap:wrap;">
          <span class="review-card__elapsed">${formatElapsed(item.elapsedMs)}</span>
          <span class="review-card__payout-range">${escHtml(payout)}</span>
          ${staleHtml}
        </div>
      </div>
    `;
  }

  // ── Asset preview renderer ───────────────────────────────────────────────
  function renderPreview(item: ReviewQueueItem): void {
    const sub = item.submission as unknown as Record<string, unknown>;
    const assetUrl = String(sub.asset_url ?? "");
    const deliverableType = String(sub.deliverable_type ?? "").toLowerCase();

    $previewLabel.textContent = deliverableType ? `ASSET · ${deliverableType.toUpperCase()}` : "ASSET PREVIEW";

    if (assetUrl) {
      $previewOpenLnk.href = assetUrl;
      $previewOpenLnk.style.display = "";
    } else {
      $previewOpenLnk.style.display = "none";
    }

    let html = "";
    if (!assetUrl) {
      html = `<div class="crucible-placeholder"><span>NO ASSET URL</span></div>`;
    } else if (deliverableType.includes("image") || /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(assetUrl)) {
      html = `<img src="${escHtml(assetUrl)}" alt="Submission asset" loading="lazy" />`;
    } else if (deliverableType.includes("audio") || /\.(mp3|wav|ogg|flac)$/i.test(assetUrl)) {
      html = `<audio controls src="${escHtml(assetUrl)}">Your browser does not support audio.</audio>`;
    } else if (deliverableType.includes("code") || deliverableType.includes("text")) {
      // Text/code assets are fetched and previewed inline, truncated at 8 000 chars.
      // The "OPEN ↗" link in the header always points to the full raw asset.
      html = `<pre data-asset-url="${escHtml(assetUrl)}">Loading code preview…<br/><a href="${escHtml(assetUrl)}" target="_blank" rel="noopener noreferrer" style="color:var(--ff-primary)">Open raw ↗</a></pre>`;
    } else {
      html = `
        <div class="crucible-placeholder" style="opacity:1">
          <span style="font-size:11px; color:var(--ff-ink); opacity:0.8; letter-spacing:0.06em;">${escHtml(deliverableType.toUpperCase() || "FILE")}</span>
          <a href="${escHtml(assetUrl)}" target="_blank" rel="noopener noreferrer"
             class="ff-btn ff-btn--secondary ff-btn--sm" style="margin-top:12px">OPEN ASSET ↗</a>
        </div>`;
    }

    $previewBody.innerHTML = html;

    // Async-fetch text/code assets and populate the <pre> inline.
    const pre = $previewBody.querySelector<HTMLPreElement>("pre[data-asset-url]");
    if (pre) {
      const url = pre.dataset.assetUrl!;
      fetch(url)
        .then(r => r.text())
        .then(text => {
          const truncated = text.length > 8000;
          pre.textContent = text.slice(0, 8000);
          if (truncated) {
            pre.textContent += "\n\n…[TRUNCATED — USE \u201cOPEN ↗\u201d ABOVE FOR FULL ASSET]";
          }
        })
        .catch(() => { pre.textContent = "Could not load asset."; });
    }
  }

  // ── Decision panel renderer ───────────────────────────────────────────────
  function renderDecisionPanel(item: ReviewQueueItem): void {
    const sub = item.submission as unknown as Record<string, unknown>;
    const reliabilityPct = Math.round(item.contributorReliability * 100);
    const aiSummary = String(sub.ai_summary ?? "");
    const deliverableType = String(sub.deliverable_type ?? "");

    $decisionBody.innerHTML = `
      <div class="crucible-stat">
        <span class="crucible-stat__label">Contributor</span>
        <span class="crucible-stat__value">${escHtml(item.contributorName)}</span>
      </div>

      <div class="crucible-stat">
        <span class="crucible-stat__label">Reliability</span>
        <span class="crucible-stat__value">${reliabilityPct}%</span>
        <div class="reliability-bar">
          <div class="reliability-bar__fill" style="width:${reliabilityPct}%"></div>
        </div>
      </div>

      <div class="crucible-stat">
        <span class="crucible-stat__label">Submitted</span>
        <span class="crucible-stat__value">${formatElapsed(item.elapsedMs)}</span>
      </div>

      ${deliverableType ? `
      <div class="crucible-stat">
        <span class="crucible-stat__label">Type</span>
        <span class="crucible-stat__value">${escHtml(deliverableType)}</span>
      </div>` : ""}

      ${aiSummary ? `
      <div class="crucible-stat">
        <span class="crucible-stat__label">AI Summary</span>
        <span class="crucible-stat__value" style="font-weight:400; font-size:12px; line-height:1.5; color:var(--ff-muted);">${escHtml(aiSummary)}</span>
      </div>` : ""}
    `;

    $decisionFooter.style.display = "";
    $decisionError.style.display = "none";
    $decisionError.textContent = "";

    // Rebind buttons for this item
    [$btnApprove, $btnRevise, $btnReject].forEach(b => { b.disabled = false; });
  }

  // ── Select item ───────────────────────────────────────────────────────────
  function selectItem(item: ReviewQueueItem): void {
    selectedItem = item;

    // Highlight active card
    $queueList.querySelectorAll(".review-card").forEach(c => c.classList.remove("active"));
    $queueList.querySelector(`[data-task-id="${escHtml(String(item.task.id))}"]`)?.classList.add("active");

    renderPreview(item);
    renderDecisionPanel(item);
  }

  // ── Remove item after decision ───────────────────────────────────────────────
  function removeItem(taskId: string): void {
    items = items.filter(i => String(i.task.id) !== taskId);
    $queueList.querySelector(`[data-task-id="${escHtml(taskId)}"]`)?.remove();
    $queueCountLbl.textContent = `QUEUE · ${items.length}`;

    // If the removed item was selected, clear center + right
    if (selectedItem && String(selectedItem.task.id) === taskId) {
      selectedItem = null;
      $previewBody.innerHTML = `<div class="crucible-placeholder"><span>&#9632;&nbsp;SELECT SUBMISSION</span></div>`;
      $previewLabel.textContent = "ASSET PREVIEW";
      $previewOpenLnk.style.display = "none";
      $decisionBody.innerHTML = `<div class="crucible-placeholder"><span>&#9632;&nbsp;NO SELECTION</span></div>`;
      $decisionFooter.style.display = "none";
    }

    if (items.length === 0) {
      $queueList.innerHTML = EmptyState({
        icon: "check_circle",
        title: "QUEUE CLEAR",
        description: "No submissions awaiting review.",
      });
    }
  }

  // ── Decision action ───────────────────────────────────────────────────────────
  async function handleDecision(
    verb: "approved" | "revision_requested" | "rejected",
    reason: DecisionReason
  ): Promise<void> {
    if (!selectedItem) return;
    const sub = selectedItem.submission as unknown as Record<string, unknown>;
    const submissionId = String(sub.id);
    const taskId = String(selectedItem.task.id);

    [$btnApprove, $btnRevise, $btnReject].forEach(b => { b.disabled = true; });
    $decisionError.style.display = "none";

    try {
      await reviewSubmission(submissionId, verb, reason, {});
      removeItem(taskId);
    } catch (err) {
      $decisionError.textContent = err instanceof Error ? err.message : "Decision failed";
      $decisionError.style.display = "";
      [$btnApprove, $btnRevise, $btnReject].forEach(b => { b.disabled = false; });
    }
  }

  $btnApprove.addEventListener("click", () => handleDecision("approved", "great_work" as DecisionReason));
  $btnRevise.addEventListener( "click", () => handleDecision("revision_requested", "requirements_not_met" as DecisionReason));
  $btnReject.addEventListener( "click", () => handleDecision("rejected", "quality_issue" as DecisionReason));

  // ── Render queue list ───────────────────────────────────────────────────────────
  function renderQueueList(newItems: ReviewQueueItem[]): void {
    if (items.length === 0 && newItems.length === 0) {
      $loadingInd.style.display = "none";
      $queueList.innerHTML = EmptyState({
        icon: "inbox",
        title: "QUEUE EMPTY",
        description: "No submissions awaiting review.",
      });
      $queueCountLbl.textContent = "QUEUE · 0";
      return;
    }

    const frag = document.createDocumentFragment();
    newItems.forEach(item => {
      const wrapper = document.createElement("div");
      wrapper.innerHTML = renderQueueCard(item);
      const card = wrapper.firstElementChild as HTMLElement;
      card.addEventListener("click", () => selectItem(item));
      card.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectItem(item); }
      });
      frag.appendChild(card);
    });

    if (items.length === newItems.length) {
      // First load — replace spinner
      $queueList.innerHTML = "";
    }
    $queueList.appendChild(frag);
    $queueCountLbl.textContent = `QUEUE · ${items.length}`;
    $loadingInd.style.display = "none";
  }

  // ── Load page ─────────────────────────────────────────────────────────────────
  async function loadPage(): Promise<void> {
    $loadingInd.style.display = "";
    try {
      const newItems = await fetchReviews(cursor);
      items = [...items, ...newItems];
      renderQueueList(newItems);

      if (newItems.length === PAGE_SIZE) {
        const last = newItems[newItems.length - 1];
        cursor = {
          submittedAt: String((last.submission as unknown as Record<string, unknown>).created_at ?? ""),
          id: String(last.task.id),
        };
        $queueFooter.style.display = "";
      } else {
        $queueFooter.style.display = "none";
      }
    } catch (err) {
      $loadingInd.style.display = "none";
      $queueList.innerHTML = `<div style="padding:16px; color:var(--ff-error); font-family:var(--ff-font-mono); font-size:12px;">${err instanceof Error ? escHtml(err.message) : "Failed to load review queue"}</div>`;
    }
  }

  $loadMoreBtn.addEventListener("click", () => loadPage());
  await loadPage();

  // ── Realtime — FIX 3: store channel for teardown ──────────────────────────
  const channel = supabase
    .channel("review-queue-tasks")
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "tasks", filter: "status=eq.under_review" },
      () => {
        items = [];
        cursor = undefined;
        selectedItem = null;
        $queueList.innerHTML = Spinner({ label: "Refreshing queue..." });
        $previewBody.innerHTML = `<div class="crucible-placeholder"><span>&#9632;&nbsp;SELECT SUBMISSION</span></div>`;
        $previewLabel.textContent = "ASSET PREVIEW";
        $previewOpenLnk.style.display = "none";
        $decisionBody.innerHTML = `<div class="crucible-placeholder"><span>&#9632;&nbsp;NO SELECTION</span></div>`;
        $decisionFooter.style.display = "none";
        loadPage();
      }
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatElapsed(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
