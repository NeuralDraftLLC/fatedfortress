/**
 * apps/web/src/pages/tasks.ts — Contributor task listing + claim flow.
 *
 * Refactored: all data access through data.ts, UI through components.ts.
 * Pages own mount logic, event binding, and state only.
 *
 * Sacred objects: Task, Submission, Decision
 * Task visibility: task_access = 'public' OR host OR claimed_by OR
 *   has accepted invitation (invitations.accepted_at is not null).
 * Claim requires: task_access = 'public' OR valid accepted invitation.
 * Invitation token passed via ?invite=<token> URL param on the claim flow.
 */

import { requireAuth } from "../auth/middleware.js";
import { getCurrentUserId, getOpenTasks, getMyClaimedTasks, getMyAcceptedInvitedTaskIds, getTask, insertAuditEntry, insertNotification } from "../net/data.js";
import { getStripe } from "../net/stripe.js";
import { getSupabase } from "../auth/index.js";
import { renderShell } from "../ui/shell.js";
import { Card, Badge, Btn, Spinner, EmptyState, escHtml } from "../ui/components.js";
import type { Task, TaskStatus } from "@fatedfortress/protocol";

// ─── Task card renderer ────────────────────────────────────────────────────

function renderTaskCard(
  task: Task & { project?: { title?: string; host_id?: string; host?: { display_name?: string; review_reliability?: number } } },
  userId: string,
  currentFilter: string
): string {
  const isMyClaim = task.claimed_by === userId;
  const isOpen = task.status === "open";
  const softLockExpired = task.soft_lock_expires_at && new Date(task.soft_lock_expires_at as number) < new Date();
  const canClaim = isOpen && !isMyClaim;
  const canReclaim = isOpen && !isMyClaim && softLockExpired;
  const host = task.project?.host;
  const hostName = host?.display_name ?? "Unknown host";
  const hostReliability = host?.review_reliability ?? 0;
  const ambiguityScore = task.ambiguity_score ?? null;
  const status = (task.status as string).toUpperCase();

  const statusBadge = status === "OPEN"
    ? Badge({ label: "OPEN", variant: "gold" })
    : status === "CLAIMED"
    ? Badge({ label: "CLAIMED", variant: "warning" })
    : Badge({ label: status, variant: "neutral" });

  const ambiguityLabel = ambiguityScore !== null
    ? (ambiguityScore > 0.7 ? "HIGH_AMBIGUITY" : ambiguityScore > 0.4 ? "MEDIUM_AMBIGUITY" : "LOW_AMBIGUITY")
    : "";

  const payoutBadge = `$${task.payout_min}–$${task.payout_max}`;
  const etaLabel = task.estimated_minutes ? `~${task.estimated_minutes}min` : "?";

  let actionBtn = "";
  if (canClaim) {
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
      <div style="display:flex; flex-wrap:wrap; gap:8px; margin-bottom:12px; font-family:var(--ff-font-mono); font-size:11px;">
        ${Badge({ label: `PAYOUT ${payoutBadge}`, variant: "neutral" })}
        ${Badge({ label: `ETA ${etaLabel}`, variant: "neutral" })}
        ${ambiguityLabel ? Badge({ label: ambiguityLabel, variant: ambiguityScore > 0.4 ? "warning" : "success" }) : ""}
      </div>
      <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap">
        <div data-task-id="${task.id}" data-action="claim">${actionBtn}</div>
      </div>
      ${task.soft_lock_expires_at && isMyClaim ? `
        <div class="ff-subtitle" style="margin-top:10px; font-family:var(--ff-font-mono); font-size:11px;">
          SOFT_LOCK_EXPIRES: ${new Date(task.soft_lock_expires_at as number).toLocaleString()}
        </div>` : ""}
    `,
  }).replace('<div class="ff-card"', `<div class="ff-card" data-task-id="${task.id}">`);
}

// ─── Main mount function ───────────────────────────────────────────────────

export async function mountTasks(container: HTMLElement): Promise<() => void> {
  await requireAuth();

  const userId = await getCurrentUserId();
  if (!userId) return () => {};

  container.innerHTML = renderShell({
    title: "Assignment Depot",
    subtitle: "Browse · claim · invite gate",
    activePath: "/tasks",
    contentHtml: `
      <div class="ff-grid">
        <section class="ff-panel" style="grid-column: span 8;">
          <div style="display:flex; gap:8px; margin-bottom:12px;" id="filter-tabs">
            <button class="ff-btn filter-btn active" data-filter="open" style="flex:1; background:var(--ff-ink); color:var(--ff-paper);">OPEN</button>
            <button class="ff-btn filter-btn" data-filter="claimed" style="flex:1;">MY_CLAIMS</button>
            <button class="ff-btn filter-btn" data-filter="submitted" style="flex:1;">SUBMITTED</button>
          </div>
          <div id="tasks-list">
            ${Spinner({ label: "Loading tasks..." })}
          </div>
        </section>
        <aside class="ff-panel" style="grid-column: span 4;">
          <div class="ff-kpi__label">CONTRACTOR_STATUS</div>
          <div class="ff-subtitle" style="margin-top:10px; font-family:var(--ff-font-mono);">
            SIG_ID: ${userId.slice(0, 8).toUpperCase()}<br/>
            TRUST_RATING: derived from profiles.review_reliability<br/>
            ACCESS: public OR accepted invitation
          </div>
          <div class="ff-panel" style="margin-top:12px">
            <div class="ff-kpi__label">LIVE_ACTION_FEED</div>
            <div class="ff-subtitle" style="margin-top:10px; font-family:var(--ff-font-mono); font-size:12px;">
              [feed] claims · submits · payouts (future)
            </div>
          </div>
        </aside>
      </div>`,
  });

  let currentFilter: "open" | "claimed" | "submitted" = "open";
  let allTasks: (Task & { project?: { title?: string; host_id?: string; host?: { display_name?: string; review_reliability?: number } } })[] = [];
  let pollInterval: ReturnType<typeof setInterval>;

  // ── Fetch ──────────────────────────────────────────────────────────────────
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

  // ── Render ─────────────────────────────────────────────────────────────────
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
      $list.innerHTML = EmptyState({
        icon: "inbox",
        title: currentFilter === "open" ? "NO_OPEN_TASKS" : `NO_${currentFilter.toUpperCase()}_TASKS`,
        description: currentFilter === "open"
          ? "Check back soon or create a project."
          : undefined,
      });
      return;
    }

    $list.innerHTML = filtered.map(t => renderTaskCard(t, userId, currentFilter)).join("");

    // Bind action buttons
    $list.querySelectorAll("[data-task-id][data-action]").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        const el = e.currentTarget as HTMLElement;
        const taskId = el.dataset.taskId!;
        const action = el.dataset.action!;
        await handleAction(taskId, action);
      });
    });
  }

  // ── Claim action ──────────────────────────────────────────────────────────────
  async function handleAction(taskId: string, action: string): Promise<void> {
    if (action !== "claim") return;

    // Handle invitation token from URL
    const urlParams = new URLSearchParams(window.location.search);
    const invitationToken = urlParams.get("invite");

    if (invitationToken) {
      try {
        const { getInvitationByToken, acceptInvitation } = await import("../net/data.js");
        const invitation = await getInvitationByToken(invitationToken);
        if (!invitation || new Date((invitation as { expires_at?: string }).expires_at) < new Date()) {
          alert("Invalid or expired invitation link.");
          return;
        }
        if ((invitation as { accepted_at?: string }).accepted_at) {
          alert("Invitation already used.");
          return;
        }
        await acceptInvitation(invitation.id);
      } catch {
        alert("Failed to process invitation.");
        return;
      }
    }

    try {
      const supabase = getSupabase();
      const { data: claimResult, error: claimError } = await supabase.functions.invoke("claim-task", {
        body: { taskId },
      });

      if (claimError) {
        console.error("claim-task invoke error", claimError);
        alert("Failed to claim task — network error. Please try again.");
        await fetchTasks();
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
          default:
            alert(payload?.message ?? "Failed to claim task.");
            break;
        }
        await fetchTasks();
        return;
      }

      const clientSecret = payload.payment_intent_client_secret;
      if (!clientSecret) {
        console.error("claim-task: missing payment_intent_client_secret");
        alert("Claim failed: payment could not be initialized.");
        await fetchTasks();
        return;
      }

      // ── Stripe payment authorization ─────────────────────────────────────
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
        return;
      }

      // ── Post-claim side effects ───────────────────────────────────────────
      await insertAuditEntry({ actor_id: userId, task_id: taskId, action: "claimed" });

      const task = await getTask(taskId);
      const hostId = task.project?.host_id;
      if (hostId) {
        await insertNotification({ user_id: hostId, type: "task_claimed", task_id: taskId });
      }

      if (payload.message) console.info(payload.message);
      window.location.href = `/submit/${taskId}`;

    } catch (err) {
      console.error("claim-task unexpected error", err);
      alert("Failed to claim task. Please try again.");
      await fetchTasks();
    }
  }

  // ── Filter tabs ──────────────────────────────────────────────────────────────
  container.querySelectorAll(".filter-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      container.querySelectorAll(".filter-btn").forEach(b => {
        (b as HTMLElement).style.background = "";
        (b as HTMLElement).style.color = "";
      });
      const el = btn as HTMLElement;
      el.style.background = "var(--ff-ink)";
      el.style.color = "var(--ff-paper)";
      currentFilter = (el.dataset.filter ?? "open") as typeof currentFilter;
      render();
    });
  });

  // ── Boot ───────────────────────────────────────────────────────────────────
  await fetchTasks();
  pollInterval = setInterval(fetchTasks, 30_000);

  return () => clearInterval(pollInterval);
}