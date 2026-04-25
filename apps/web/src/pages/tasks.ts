/**
 * apps/web/src/pages/tasks.ts — Contributor task listing + claim flow.
 *
 * Exports:
 *   mountTasks      — authenticated full view (browse + claim)
 *   mountTasksGuest — unauthenticated read-only view (browse only)
 *
 * Refactored: all data access through data.ts, UI through components.ts.
 * Pages own mount logic, event binding, and state only.
 *
 * Sacred objects: Task, Submission, Decision
 * Task visibility: task_access = 'public' OR host OR claimed_by OR
 *   has accepted invitation (invitations.accepted_at is not null).
 * Claim requires: task_access = 'public' OR valid accepted invitation.
 * Invitation token passed via ?invite=<token> URL param on the claim flow.
 *
 * Guest mode: renders public tasks read-only. Claim button redirects to
 *   /login?return=/tasks — no auth-required calls are made.
 *
 * Changes (roadmap 1.3 + 1.4 + claim gate 2.1):
 *   - computePayouts() helper: shows "Net to you: $X (after 10% fee)" on every card
 *   - showEscrowModal(): one-time educational modal on first claim attempt
 *   - Claim gate: blocks claim if profile.approved_task_count === 0 AND
 *     profile.github_connected !== true (Phase 2 wiring — backend RPC enforces,
 *     frontend shows the right error message per error code)
 *
 * Changes (2026-04-25):
 *   - Fix: duplicate claim button listeners on every render() call.
 *     Replaced per-render querySelectorAll binding with a single delegated
 *     'click' listener on #tasks-list using closest() — fires once per click.
 *   - Feat: wire real profile data (display_name, review_reliability, skills,
 *     stripe_charges_enabled) into CONTRACTOR_STATUS sidebar.
 *   - Feat: live ACTIVITY_FEED via Supabase Realtime postgres_changes on
 *     tasks table. Prepends last 8 events. Unsubscribed on page teardown.
 *
 * Changes (2026-04-25 — race guard):
 *   - Fix: double-tap race condition on CLAIM_TASK button.
 *     Added module-scoped `_claimingTasks: Set<string>` — handleAction returns
 *     immediately if the task ID is already in the set. Button container gets
 *     [data-claiming] attribute during flight for visual feedback + pointer
 *     suppression. Attribute is always cleared on exit (success, error, or
 *     early return).
 */

import { requireAuth } from "../auth/middleware.js";
import {
  getCurrentUserId, getOpenTasks, getMyClaimedTasks,
  getMyAcceptedInvitedTaskIds, getTask, getMyProfile,
  insertAuditEntry, insertNotification,
} from "../net/data.js";
import { getStripe } from "../net/stripe.js";
import { getSupabase } from "../auth/index.js";
import { renderShell } from "../ui/shell.js";
import { Card, Badge, Btn, Spinner, EmptyState, escHtml } from "../ui/components.js";
import type { Task, TaskStatus, Profile } from "@fatedfortress/protocol";
import type { RealtimeChannel } from "@supabase/supabase-js";

// ─── In-flight claim guard ────────────────────────────────────────────────────
// Tracks task IDs currently being claimed. Prevents double-tap races where two
// concurrent claim-task invocations race to the backend before either resolves.
// Module-scoped so it survives render() re-runs; cleared on teardown.

const _claimingTasks = new Set<string>();

// ─── Payout math (roadmap 1.3) ──────────────────────────────────────────────

const PLATFORM_FEE_BPS = 1000; // 10%

function computePayouts(rawMax: number): { raw: number; fee: number; net: number } {
  const fee = Math.round(rawMax * PLATFORM_FEE_BPS) / 10_000;
  const net = parseFloat((rawMax - fee).toFixed(2));
  return { raw: rawMax, fee: parseFloat(fee.toFixed(2)), net };
}

// ─── Escrow modal (roadmap 1.4) ──────────────────────────────────────────────
let _escrowModalSeen = false;

function showEscrowModal(): Promise<void> {
  return new Promise((resolve) => {
    if (_escrowModalSeen) { resolve(); return; }

    const overlay = document.createElement("div");
    overlay.style.cssText = `
      position:fixed;inset:0;z-index:9999;
      background:rgba(0,0,0,0.72);
      display:flex;align-items:center;justify-content:center;
      padding:24px;
    `;

    overlay.innerHTML = `
      <div style="
        background:var(--ff-paper);color:var(--ff-ink);
        max-width:440px;width:100%;padding:28px;
        border:1px solid var(--ff-ink);font-family:var(--ff-font-mono);
      ">
        <div style="font-weight:900;font-size:14px;letter-spacing:.12em;margin-bottom:16px;text-transform:uppercase;">
          How payments work on FatedFortress
        </div>
        <ul style="list-style:none;padding:0;margin:0 0 20px;display:flex;flex-direction:column;gap:10px;font-size:12px;line-height:1.6;">
          <li>⚡ When you claim a task, the host's card gets a <strong>hotel-style hold</strong> — it is <em>not</em> charged yet.</li>
          <li>🔬 When your file passes automatic spec verification, Stripe <strong>captures the funds</strong> and you get paid.</li>
          <li>🔒 If the claim expires or work fails checks, the hold is released. You are never charged.</li>
          <li>💸 Your <strong>net payout</strong> = task amount − 10% platform fee. This is shown on every task card.</li>
        </ul>
        <button id="escrow-modal-confirm" class="ff-btn" style="width:100%;font-size:13px;">
          GOT_IT — LET_ME_CLAIM
        </button>
        <div style="font-size:10px;color:var(--ff-muted);margin-top:8px;text-align:center;">
          You'll only see this once.
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    overlay.querySelector("#escrow-modal-confirm")?.addEventListener("click", () => {
      _escrowModalSeen = true;
      document.body.removeChild(overlay);
      resolve();
    });
  });
}

// ─── Task card renderer (shared) ────────────────────────────────────────────

function renderTaskCard(
  task: Task & { project?: { title?: string; host_id?: string; host?: { display_name?: string; review_reliability?: number } } },
  userId: string | null,
  currentFilter: string
): string {
  const isMyClaim = !!userId && task.claimed_by === userId;
  const isOpen = task.status === "open";
  const softLockExpired = task.soft_lock_expires_at && new Date(task.soft_lock_expires_at as number) < new Date();
  const canClaim = isOpen && !isMyClaim;
  const canReclaim = isOpen && !isMyClaim && softLockExpired;
  const host = task.project?.host;
  const hostName = host?.display_name ?? "Unknown host";
  const hostReliability = host?.review_reliability ?? 0;
  const ambiguityScore = task.ambiguity_score ?? null;
  const status = (task.status as string).toUpperCase();

  const { net } = computePayouts(task.payout_max);
  const payoutBadge = `$${task.payout_min}–$${task.payout_max}`;
  const netPayoutLine = `
    <div style="
      font-family:var(--ff-font-mono);font-size:11px;
      color:var(--ff-ink);margin-top:4px;
      display:flex;align-items:center;gap:6px;
    ">
      <span style="font-weight:700;">NET_TO_YOU: $${net}</span>
      <span style="
        color:var(--ff-muted);font-size:10px;cursor:help;border-bottom:1px dashed var(--ff-muted);
      " title="FatedFortress takes a 10% platform fee when a task is approved. This is what you actually receive.">
        after 10% fee ⓘ
      </span>
    </div>
  `;

  const statusBadge = status === "OPEN"
    ? Badge({ label: "OPEN", variant: "gold" })
    : status === "CLAIMED"
    ? Badge({ label: "CLAIMED", variant: "warning" })
    : Badge({ label: status, variant: "neutral" });

  const ambiguityLabel = ambiguityScore !== null
    ? (ambiguityScore > 0.7 ? "HIGH_AMBIGUITY" : ambiguityScore > 0.4 ? "MEDIUM_AMBIGUITY" : "LOW_AMBIGUITY")
    : "";

  const etaLabel = task.estimated_minutes ? `~${task.estimated_minutes}min` : "?";

  let actionBtn = "";
  if (!userId) {
    if (isOpen) {
      actionBtn = `<a href="/login?return=/tasks" class="ff-btn ff-btn--primary ff-btn--sm" style="text-decoration:none;display:inline-block">SIGN_IN_TO_CLAIM</a>`;
    } else {
      actionBtn = `<span class="ff-subtitle">LOCKED: ${escHtml(task.status as string)}</span>`;
    }
  } else if (canClaim) {
    actionBtn = Btn({ label: "CLAIM_TASK", variant: "primary", size: "sm" });
  } else if (canReclaim) {
    actionBtn = Btn({ label: "RECLAIM_EXPIRED", variant: "ghost", size: "sm" });
  } else if (isMyClaim && task.status === "claimed") {
    actionBtn = `<a href="/submit/${task.id}" style="display:inline-block; text-decoration:none;">
      ${Btn({ label: "SUBMIT", variant: "primary", size: "sm" })}
    </a>`;
  } else if (isMyClaim && ["submitted", "under_review", "revision_requested"].includes(task.status as string)) {
    actionBtn = Btn({ label: "VIEW", variant: "ghost", size: "sm" });
  } else if (!isMyClaim && !isOpen && !canReclaim) {
    actionBtn = `<span class="ff-subtitle">LOCKED: ${escHtml(task.status as string)}</span>`;
  }

  return Card({
    class: "task-card",
    hoverable: false,
    children: `
      <div style="display:flex; justify-content:space-between; gap:12px; align-items:flex-start; margin-bottom:12px;">
        <div>
          <div style="font-family:var(--ff-font-mono); font-weight:900; text-transform:uppercase; margin-bottom:4px;">
            ${escHtml(task.title)}
          </div>
          <div class="ff-subtitle">
            HOST: ${escHtml(hostName)}${hostReliability > 0 ? ` · ${Math.round(hostReliability * 100)}% reliable` : ""}
          </div>
        </div>
        <div>${statusBadge}</div>
      </div>
      <div class="ff-subtitle" style="margin-bottom:12px; font-size:13px;">
        ${escHtml(((task.description as string) ?? "").slice(0, 220))}${(task.description as string)?.length > 220 ? "..." : ""}
      </div>
      <div style="display:flex; flex-wrap:wrap; gap:8px; margin-bottom:8px; font-family:var(--ff-font-mono); font-size:11px;">
        ${Badge({ label: `PAYOUT ${payoutBadge}`, variant: "neutral" })}
        ${Badge({ label: `ETA ${etaLabel}`, variant: "neutral" })}
        ${ambiguityLabel ? Badge({ label: ambiguityLabel, variant: ambiguityScore > 0.4 ? "warning" : "success" }) : ""}
      </div>
      ${netPayoutLine}
      <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:12px">
        ${userId
          ? `<div data-task-id="${task.id}" data-action="claim">${actionBtn}</div>`
          : actionBtn
        }
      </div>
      ${task.soft_lock_expires_at && isMyClaim ? `
        <div class="ff-subtitle" style="margin-top:10px; font-family:var(--ff-font-mono); font-size:11px;">
          SOFT_LOCK_EXPIRES: ${new Date(task.soft_lock_expires_at as number).toLocaleString()}
        </div>` : ""}
    `,
  }).replace('<div class="ff-card"', `<div class="ff-card" data-task-id="${task.id}">`);
}

// ─── Sidebar: contractor status ──────────────────────────────────────────────

function renderContractorSidebar(profile: Profile | null, userId: string): string {
  const sigId = userId.slice(0, 8).toUpperCase();
  const displayName = profile?.display_name ? escHtml(profile.display_name) : sigId;
  const reliability = profile?.review_reliability ?? 0;
  const reliabilityPct = Math.round(reliability * 100);
  const reliabilityColor = reliability >= 0.8
    ? "var(--ff-success, #2e7d32)"
    : reliability >= 0.5
    ? "var(--ff-warning, #f57c00)"
    : "var(--ff-error, #c62828)";
  const payoutStatus = (profile as Record<string, unknown>)?.stripe_charges_enabled
    ? `<span style="color:var(--ff-success,#2e7d32);font-weight:700">✓ PAYOUTS_ENABLED</span>`
    : `<span style="color:var(--ff-muted)">⚠ <a href="/settings" style="color:inherit">CONNECT_STRIPE</a></span>`;

  const skillTags = Array.isArray((profile as Record<string, unknown>)?.skills)
    ? ((profile as Record<string, unknown>).skills as string[])
        .map(s => Badge({ label: escHtml(s), variant: "neutral" }))
        .join(" ")
    : "";

  return `
    <div class="ff-kpi__label">CONTRACTOR_STATUS</div>
    <div style="margin-top:10px; font-family:var(--ff-font-mono); font-size:12px; line-height:1.8; display:flex; flex-direction:column; gap:4px;">
      <div>SIG_ID: <strong>${sigId}</strong></div>
      <div>HANDLE: <strong>${displayName}</strong></div>
      <div>TRUST_RATING:
        <strong style="color:${reliabilityColor}">${reliabilityPct}%</strong>
        ${reliability > 0 ? `<span style="color:var(--ff-muted);font-size:10px"> (${reliability.toFixed(2)})</span>` : ""}
      </div>
      <div>PAYOUT: ${payoutStatus}</div>
    </div>
    ${skillTags ? `<div style="margin-top:10px;display:flex;flex-wrap:wrap;gap:4px">${skillTags}</div>` : ""}
    <div class="ff-panel" style="margin-top:12px">
      <div class="ff-kpi__label">PAYOUT_INFO</div>
      <div style="margin-top:10px; font-family:var(--ff-font-mono); font-size:11px; line-height:1.6;">
        Platform fee: <strong>10%</strong><br/>
        Shown on every card as "NET_TO_YOU"<br/>
        Funds held via Stripe hotel-hold until approval.
      </div>
    </div>
    <div class="ff-panel" style="margin-top:12px">
      <div class="ff-kpi__label">ACTIVITY_FEED</div>
      <div id="activity-feed" style="margin-top:10px; font-family:var(--ff-font-mono); font-size:11px; line-height:1.7; max-height:220px; overflow-y:auto; display:flex; flex-direction:column; gap:6px;">
        <span style="color:var(--ff-muted)">Connecting…</span>
      </div>
    </div>
  `;
}

// ─── Activity feed helpers ───────────────────────────────────────────────────

const MAX_FEED_EVENTS = 8;

interface FeedEvent {
  ts: string;
  label: string;
  color?: string;
}

let feedEvents: FeedEvent[] = [];

function pushFeedEvent(ev: FeedEvent): void {
  feedEvents.unshift(ev);
  if (feedEvents.length > MAX_FEED_EVENTS) feedEvents = feedEvents.slice(0, MAX_FEED_EVENTS);
  renderFeed();
}

function renderFeed(): void {
  const el = document.getElementById("activity-feed");
  if (!el) return;
  if (feedEvents.length === 0) {
    el.innerHTML = `<span style="color:var(--ff-muted)">No activity yet.</span>`;
    return;
  }
  el.innerHTML = feedEvents.map(ev => `
    <div style="display:flex;gap:6px;align-items:flex-start">
      <span style="color:var(--ff-muted);white-space:nowrap;font-size:10px;padding-top:1px">${ev.ts}</span>
      <span style="color:${ev.color ?? "var(--ff-ink)"}">${escHtml(ev.label)}</span>
    </div>
  `).join("");
  el.scrollTop = 0;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function taskEventLabel(eventType: "INSERT" | "UPDATE", row: Record<string, unknown>): FeedEvent {
  const title = (row.title as string | undefined)?.slice(0, 28) ?? "task";
  const status = (row.status as string | undefined) ?? "";
  const ts = fmtTime((row.updated_at ?? row.created_at ?? new Date().toISOString()) as string);

  if (eventType === "INSERT") {
    return { ts, label: `NEW_TASK: ${title}`, color: "var(--ff-success,#2e7d32)" };
  }
  const colorMap: Record<string, string> = {
    claimed:          "var(--ff-warning,#f57c00)",
    submitted:        "var(--ff-ink)",
    under_review:     "var(--ff-ink)",
    revision_requested: "var(--ff-error,#c62828)",
    approved:         "var(--ff-success,#2e7d32)",
    rejected:         "var(--ff-error,#c62828)",
  };
  return {
    ts,
    label: `${status.toUpperCase()}: ${title}`,
    color: colorMap[status] ?? "var(--ff-ink)",
  };
}

// ─── Guest (unauthenticated) mount ──────────────────────────────────────────

export async function mountTasksGuest(container: HTMLElement): Promise<() => void> {
  container.innerHTML = `
    <div style="max-width:860px;margin:0 auto;padding:32px 16px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;flex-wrap:wrap;gap:12px">
        <div>
          <div style="font-family:var(--ff-font-mono);font-weight:900;text-transform:uppercase;font-size:18px">OPEN TASKS</div>
          <div class="ff-subtitle" style="margin-top:4px">Browse available work. Sign in to claim.</div>
        </div>
        <a href="/login?return=/tasks" class="ff-btn ff-btn--primary ff-btn--sm" style="text-decoration:none">Sign In to Work</a>
      </div>
      <div id="guest-tasks-list">Loading tasks…</div>
    </div>
  `;

  const list = container.querySelector<HTMLElement>("#guest-tasks-list");
  if (!list) return () => {};

  try {
    const openTasks = await getOpenTasks();
    const publicTasks = openTasks.filter(t => (t as Record<string, unknown>).task_access === "public" || t.status === "open");

    if (publicTasks.length === 0) {
      list.innerHTML = `
        <div style="text-align:center;padding:64px 0;font-family:var(--ff-font-mono);color:var(--ff-muted)">
          <div style="font-size:32px;margin-bottom:12px">📭</div>
          <div style="font-weight:700;text-transform:uppercase;font-size:12px;letter-spacing:.1em">NO_OPEN_TASKS</div>
          <div style="margin-top:8px;font-size:11px">Check back soon — new tasks are posted daily.</div>
          <a href="/login" class="ff-btn ff-btn--ghost ff-btn--sm" style="text-decoration:none;display:inline-block;margin-top:20px">Create an Account</a>
        </div>
      `;
      return () => {};
    }

    list.innerHTML = publicTasks.map(t => renderTaskCard(t, null, "open")).join("");
  } catch {
    list.innerHTML = `<p style="color:var(--ff-error);font-family:var(--ff-font-mono);font-size:12px">Failed to load tasks.</p>`;
  }

  return () => {};
}

// ─── Authenticated mount ─────────────────────────────────────────────────────

export async function mountTasks(container: HTMLElement): Promise<() => void> {
  await requireAuth();

  const userId = await getCurrentUserId();
  if (!userId) return () => {};

  // Fetch profile in parallel — used to populate sidebar.
  // Not awaited here; sidebar renders after tasks if profile is slow.
  let profile: Profile | null = null;

  container.innerHTML = renderShell({
    title: "Assignment Depot",
    subtitle: "Browse · claim · invite gate",
    activePath: "/tasks",
    contentHtml: `
      <div class="ff-grid">
        <section class="ff-panel" style="grid-column: span 8;">
          <div style="display:flex; gap:8px; margin-bottom:12px;" id="filter-tabs">
            <button class="ff-btn filter-btn active" data-filter="open" style="flex:1;">OPEN</button>
            <button class="ff-btn filter-btn" data-filter="claimed" style="flex:1;">MY_CLAIMS</button>
            <button class="ff-btn filter-btn" data-filter="submitted" style="flex:1;">SUBMITTED</button>
          </div>
          <div id="tasks-list">
            ${Spinner({ label: "Loading tasks..." })}
          </div>
        </section>
        <aside class="ff-panel" style="grid-column: span 4;" id="contractor-sidebar">
          ${Spinner({ label: "Loading profile..." })}
        </aside>
      </div>`,
  });

  let currentFilter: "open" | "claimed" | "submitted" = "open";
  let allTasks: (Task & { project?: { title?: string; host_id?: string; host?: { display_name?: string; review_reliability?: number } } })[] = [];
  let pollInterval: ReturnType<typeof setInterval>;
  let realtimeChannel: RealtimeChannel | null = null;

  // ── Sidebar: profile ──────────────────────────────────────────────────────
  async function loadSidebar(): Promise<void> {
    try {
      profile = await getMyProfile();
    } catch {
      profile = null;
    }
    const sidebar = container.querySelector<HTMLElement>("#contractor-sidebar");
    if (sidebar) sidebar.innerHTML = renderContractorSidebar(profile, userId);
    // Feed el now exists — flush any events that arrived before DOM was ready
    renderFeed();
  }

  // ── Realtime: tasks activity feed ─────────────────────────────────────────
  function subscribeActivityFeed(): RealtimeChannel {
    feedEvents = [];
    const ch = getSupabase()
      .channel("tasks-activity-feed")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "tasks" },
        (payload) => {
          pushFeedEvent(taskEventLabel("INSERT", payload.new as Record<string, unknown>));
          // Reload task list so new task appears immediately
          void fetchTasks();
        }
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "tasks" },
        (payload) => {
          pushFeedEvent(taskEventLabel("UPDATE", payload.new as Record<string, unknown>));
          // Reflect status change without waiting for next poll
          void fetchTasks();
        }
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          renderFeed(); // clears "Connecting…"
        }
      });
    return ch;
  }

  // ── Tasks data ────────────────────────────────────────────────────────────
  async function fetchTasks(): Promise<void> {
    try {
      const [openTasks, claimedTasks] = await Promise.all([
        getOpenTasks(),
        getMyClaimedTasks(userId),
      ]);

      const invitedTaskIds = await getMyAcceptedInvitedTaskIds(userId);

      allTasks = [...openTasks, ...claimedTasks].filter((t) => {
        const isPublic = t.task_access === "public";
        const isHost = t.project?.host_id === userId;
        const isClaimedByMe = t.claimed_by === userId;
        const isInvited = invitedTaskIds.has(t.id);
        return isPublic || isHost || isClaimedByMe || isInvited;
      });

      render();
    } catch {
      const list = container.querySelector("#tasks-list");
      if (list) list.innerHTML = `<p style="color:var(--ff-error); font-family:var(--ff-font-mono);">Failed to load tasks.</p>`;
    }
  }

  function render(): void {
    const $list = container.querySelector<HTMLElement>("#tasks-list");
    if (!$list) return;

    let filtered: typeof allTasks;
    if (currentFilter === "claimed") {
      filtered = allTasks.filter(t => t.claimed_by === userId);
    } else if (currentFilter === "submitted") {
      filtered = allTasks.filter(t =>
        t.claimed_by === userId &&
        (["submitted", "under_review", "revision_requested"] as TaskStatus[]).includes(t.status as TaskStatus)
      );
    } else {
      filtered = allTasks.filter(t => t.status === "open");
    }

    if (filtered.length === 0) {
      let title: string;
      let description: string | undefined;

      if (currentFilter === "open") {
        title = "NO_OPEN_TASKS";
        description = "Check back soon or create a project.";
      } else if (currentFilter === "claimed") {
        title = "NO_CLAIMED_TASKS";
        description = "You haven't claimed any tasks yet.";
      } else {
        title = "NO_SUBMITTED_TASKS";
        description = "Once you submit work, it will show up here.";
      }

      $list.innerHTML = EmptyState({ icon: "inbox", title, description });
      return;
    }

    $list.innerHTML = filtered.map(t => renderTaskCard(t, userId, currentFilter)).join("");
    // NOTE: No per-render event listener attachment here.
    // A single delegated listener on #tasks-list handles all claim clicks (see below).
  }

  // ── Claim action ──────────────────────────────────────────────────────────
  async function handleAction(taskId: string, action: string): Promise<void> {
    if (action !== "claim") return;

    // ── Race condition guard ─────────────────────────────────────────────────
    // Prevents a second claim-task invocation from firing while the first is
    // still in flight. Covers:
    //   (a) rapid double-tap / double-click before the button re-renders,
    //   (b) Realtime UPDATE rebuilding the DOM (and thus removing [data-claiming])
    //       before the first in-flight call resolves — the Set survives re-renders.
    if (_claimingTasks.has(taskId)) return;
    _claimingTasks.add(taskId);

    // Visually dim the button container so the user gets immediate feedback.
    // We target the wrapper div that carries data-task-id + data-action because
    // the card itself is re-rendered by render() and the attribute must survive.
    const $btn = document.querySelector<HTMLElement>(
      `[data-task-id="${taskId}"][data-action="claim"]`
    );
    if ($btn) {
      $btn.setAttribute("data-claiming", "1");
      $btn.style.opacity = "0.45";
      $btn.style.pointerEvents = "none";
    }

    const clearGuard = (): void => {
      _claimingTasks.delete(taskId);
      // Re-query in case DOM was rebuilt by a Realtime-triggered render()
      const $b = document.querySelector<HTMLElement>(
        `[data-task-id="${taskId}"][data-action="claim"]`
      );
      if ($b) {
        $b.removeAttribute("data-claiming");
        $b.style.opacity = "";
        $b.style.pointerEvents = "";
      }
    };

    try {
      await showEscrowModal();

      const urlParams = new URLSearchParams(window.location.search);
      const invitationToken = urlParams.get("invite");

      if (invitationToken) {
        try {
          const { getInvitationByToken, acceptInvitation } = await import("../net/data.js");
          const invitation = await getInvitationByToken(invitationToken);
          if (!invitation || new Date((invitation as { expires_at?: string }).expires_at) < new Date()) {
            alert("Invalid or expired invitation link.");
            clearGuard();
            return;
          }
          if ((invitation as { accepted_at?: string }).accepted_at) {
            alert("Invitation already used.");
            clearGuard();
            return;
          }
          await acceptInvitation(invitation.id);
        } catch {
          alert("Failed to process invitation.");
          clearGuard();
          return;
        }
      }

      const supabase = getSupabase();
      const { data: claimResult, error: claimError } = await supabase.functions.invoke("claim-task", {
        body: { taskId },
      });

      if (claimError) {
        console.error("claim-task invoke error", claimError);
        alert("Failed to claim task — network error. Please try again.");
        await fetchTasks();
        clearGuard();
        return;
      }

      const payload = claimResult as {
        success?: boolean;
        error?: string;
        message?: string;
        onboarding_url?: string;
        payment_intent_client_secret?: string;
        claim_expires_at?: string;
      } | null;

      if (!payload?.success) {
        switch (payload?.error) {
          case "stripe_onboarding_required":
            clearGuard();
            window.location.href = payload.onboarding_url ?? "/settings/stripe-connect";
            return;
          case "already_claimed":
            alert(payload.message ?? "Another contributor just claimed this task.");
            break;
          case "wallet_error":
            alert(payload.message ?? "Project wallet has insufficient funds.");
            break;
          case "invite_only":
            alert(payload.message ?? "This task requires an invitation.");
            break;
          case "reputation_gate":
            alert(
              payload.message ??
              "You need at least 1 approved task before claiming tasks above this threshold. " +
              "Start with a smaller task to build your reputation."
            );
            break;
          case "concurrent_limit":
            alert(
              payload.message ??
              "You've reached your concurrent claim limit. " +
              "Complete or release an existing claim before taking on more work."
            );
            break;
          case "github_required":
            alert(
              "You need to link your GitHub account before claiming your first task. " +
              "Head to Settings → GitHub to connect."
            );
            clearGuard();
            window.location.href = "/settings?section=github";
            return;
          default:
            alert(payload?.message ?? "Failed to claim task.");
            break;
        }
        await fetchTasks();
        clearGuard();
        return;
      }

      const clientSecret = payload.payment_intent_client_secret;
      if (!clientSecret) {
        console.error("claim-task: missing payment_intent_client_secret");
        alert("Claim failed: payment could not be initialized.");
        await fetchTasks();
        clearGuard();
        return;
      }

      let stripeErrorMessage: string | null = null;
      try {
        const stripe = await getStripe();
        const { error: stripeErr } = await stripe.confirmPayment({
          clientSecret,
          confirmParams: {
            return_url: `${window.location.origin}/submit/${taskId}`,
          },
        });
        if (stripeErr) {
          console.error("Stripe confirmPayment error", stripeErr);
          stripeErrorMessage = stripeErr.message ?? "Payment authorization failed.";
        }
      } catch (e) {
        console.error("Stripe.js error", e);
        stripeErrorMessage = "Payment authorization failed.";
      }

      if (stripeErrorMessage) {
        alert(stripeErrorMessage);
        await fetchTasks();
        clearGuard();
        return;
      }

      await insertAuditEntry({ actor_id: userId, task_id: taskId, action: "claimed" });

      const task = await getTask(taskId);
      const hostId = task.project?.host_id;
      if (hostId) {
        await insertNotification({ user_id: hostId, type: "task_claimed", task_id: taskId });
      }

      // Guard intentionally NOT cleared on success — the page navigates away.
      // clearGuard() would be a no-op here and the Set is GC'd with the module.
      if (payload.message) console.info(payload.message);
      window.location.href = `/submit/${taskId}`;

    } catch (err) {
      console.error("claim-task unexpected error", err);
      alert("Failed to claim task. Please try again.");
      await fetchTasks();
      clearGuard();
    }
  }

  // ── Single delegated listener on #tasks-list (fixes duplicate listeners) ──
  // Attached ONCE after shell render. Never re-attached on render() calls.
  const $listEl = container.querySelector<HTMLElement>("#tasks-list");
  if ($listEl) {
    $listEl.addEventListener("click", async (e) => {
      const target = (e.target as Element).closest<HTMLElement>("[data-task-id][data-action]");
      if (!target) return;
      const taskId = target.dataset.taskId!;
      const action = target.dataset.action!;
      await handleAction(taskId, action);
    });
  }

  // ── Filter tabs ───────────────────────────────────────────────────────────
  container.querySelectorAll<HTMLButtonElement>(".filter-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      container.querySelectorAll<HTMLButtonElement>(".filter-btn").forEach(b =>
        b.classList.remove("active")
      );
      btn.classList.add("active");
      currentFilter = (btn.dataset.filter ?? "open") as typeof currentFilter;
      render();
    });
  });

  // ── Boot: load profile + subscribe feed + fetch tasks in parallel ─────────
  await Promise.all([
    loadSidebar(),
    fetchTasks(),
  ]);

  realtimeChannel = subscribeActivityFeed();
  pollInterval = setInterval(fetchTasks, 30_000);

  // ── Teardown ──────────────────────────────────────────────────────────────
  return () => {
    clearInterval(pollInterval);
    if (realtimeChannel) {
      realtimeChannel.unsubscribe();
      realtimeChannel = null;
    }
    feedEvents = [];
    _claimingTasks.clear();
  };
}
