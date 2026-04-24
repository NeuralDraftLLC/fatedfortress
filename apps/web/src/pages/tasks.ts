/**
 * apps/web/src/pages/tasks.ts — Contributor task listing + claim flow.
 *
 * Sacred objects: Task, Submission, Decision
 *
 * Task visibility: task_access = 'public' OR host OR claimed_by OR
 *   has accepted invitation (invitations.accepted_at is not null).
 * Claim requires: task_access = 'public' OR valid accepted invitation.
 * Invitation token passed via ?invite=<token> URL param on the claim flow.
 */

import { getSupabase } from "../auth/index.js";
import { requireAuth } from "../auth/middleware.js";
import type { Task } from "@fatedfortress/protocol";
import { renderShell } from "../ui/shell.js";

const SOFT_LOCK_HOURS = 24;

export async function mountTasks(container: HTMLElement): Promise<() => void> {
  await requireAuth();

  const supabase = getSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return () => {};

  container.innerHTML = renderShell({
    title: "Assignment Depot",
    subtitle: "Browse · claim · invite gate",
    activePath: "/tasks",
    contentHtml: `
      <div class="ff-grid">
        <section class="ff-panel ff-panel--rust" style="grid-column: span 8;">
          <div style="display:flex; gap:8px; margin-bottom:12px;">
            <button class="ff-btn filter-btn active" data-filter="open" style="flex:1; background:#1a1614; border-color: var(--ff-rust);">OPEN</button>
            <button class="ff-btn filter-btn" data-filter="claimed" style="flex:1; background:#1a1614; border-color: var(--ff-rust);">MY_CLAIMS</button>
            <button class="ff-btn filter-btn" data-filter="submitted" style="flex:1; background:#1a1614; border-color: var(--ff-rust);">SUBMITTED</button>
          </div>
          <div id="tasks-list">
            <div class="ff-subtitle">Loading tasks...</div>
          </div>
        </section>

        <aside class="ff-panel" style="grid-column: span 4;">
          <div class="ff-kpi__label">CONTRACTOR_STATUS</div>
          <div class="ff-subtitle" style="margin-top:10px; font-family: var(--ff-mono);">
            SIG_ID: ${user.id.slice(0, 8).toUpperCase()}<br/>
            TRUST_RATING: derived from profiles.review_reliability<br/>
            ACCESS: public OR accepted invitation
          </div>
          <div class="ff-panel" style="margin-top:12px">
            <div class="ff-kpi__label">LIVE_ACTION_FEED</div>
            <div class="ff-subtitle" style="margin-top:10px; font-family: var(--ff-mono);">
              [feed] claims · submits · payouts (future)
            </div>
          </div>
        </aside>
      </div>
    `,
  });

  let currentFilter = "open";
  let allTasks: Record<string, unknown>[] = [];
  let pollInterval: ReturnType<typeof setInterval>;

  async function fetchTasks(): Promise<void> {
    // Invitation-aware query: show tasks that are public, or where user
    // has an accepted invitation, or where user is the host.
    // We fetch open tasks and filter client-side for simplicity; for large
    // scale this should move to an RPC or a DB view.
    const { data, error } = await supabase
      .from("tasks")
      .select(`
        *,
        project:projects(id, title, host_id, host:profiles(display_name, review_reliability))
      `)
      .in("status", ["open", "claimed", "submitted", "under_review", "revision_requested"])
      .order("created_at", { ascending: false });

    if (error) {
      (container.querySelector("#tasks-list") as HTMLElement).innerHTML = `<p class="tasks-error">Failed to load tasks.</p>`;
      return;
    }

    // Client-side invitation filter
    const { data: invitations } = await supabase
      .from("invitations")
      .select("task_id, accepted_at")
      .eq("invited_user_id", user.id)
      .not("accepted_at", "is", null);

    const invitedTaskIds = new Set((invitations ?? []).map((i: Record<string, unknown>) => i.task_id as string));

    allTasks = (data ?? []).filter((t: Record<string, unknown>) => {
      const isPublic = t.task_access === "public";
      const isHost = (t.project as Record<string, unknown>)?.host_id === user.id;
      const isClaimedByMe = t.claimed_by === user.id;
      const isInvited = invitedTaskIds.has(t.id as string);
      return isPublic || isHost || isClaimedByMe || isInvited;
    });

    render();
  }

  function render(): void {
    const $list = container.querySelector("#tasks-list") as HTMLElement;

    let filtered: Record<string, unknown>[];
    if (currentFilter === "claimed") {
      filtered = allTasks.filter(t => t.claimed_by === user!.id);
    } else if (currentFilter === "submitted") {
      filtered = allTasks.filter(t =>
        t.claimed_by === user!.id &&
        ["submitted", "under_review", "revision_requested"].includes(t.status as string)
      );
    } else {
      filtered = allTasks.filter(t => t.status === "open");
    }

    if (filtered.length === 0) {
      $list.innerHTML = `<div class="tasks-empty">
        <p>No ${currentFilter === "open" ? "open tasks" : currentFilter + " tasks"} right now.</p>
        ${currentFilter === "open" ? `<p>Check back soon or <a href="/create">create a project</a>.</p>` : ""}
      </div>`;
      return;
    }

    $list.innerHTML = filtered.map(t => renderTaskCard(t)).join("");

    $list.querySelectorAll(".claim-btn, .submit-btn, .view-btn").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        const taskId = (e.currentTarget as HTMLElement).dataset.taskId!;
        const action = (e.currentTarget as HTMLElement).dataset.action!;
        await handleAction(taskId, action);
      });
    });
  }

  function renderTaskCard(t: Record<string, unknown>): string {
    const isMyClaim = t.claimed_by === user!.id;
    const isOpen = t.status === "open";
    const softLockExpired = t.soft_lock_expires_at && new Date(t.soft_lock_expires_at as string) < new Date();
    const canClaim = isOpen && !isMyClaim;
    const canReclaim = isOpen && !isMyClaim && softLockExpired;

    const host = (t.project as Record<string, unknown>)?.host as Record<string, unknown> | undefined;
    const hostName = host?.display_name ?? "Unknown host";
    const hostReliability = (host?.review_reliability as number | null) ?? 0;
    const ambiguityScore = t.ambiguity_score as number | null;
    const ambiguityLabel = ambiguityScore != null
      ? (ambiguityScore > 0.7 ? "High ambiguity" : ambiguityScore > 0.4 ? "Medium ambiguity" : "Low ambiguity")
      : "";

    const status = (t.status as string).toUpperCase();
    const statusTag = status === "OPEN"
      ? `<span style="color: var(--ff-gold); font-family: var(--ff-mono); font-size: 10px; font-weight: 900;">ROUTINE</span>`
      : status === "CLAIMED"
        ? `<span style="color: var(--ff-gold); font-family: var(--ff-mono); font-size: 10px; font-weight: 900;">ENGAGED</span>`
        : `<span style="color: var(--ff-dim); font-family: var(--ff-mono); font-size: 10px; font-weight: 900;">${escHtml(status)}</span>`;

    return `
      <div class="ff-panel" style="margin-bottom:12px" data-task-id="${t.id}">
        <div style="display:flex; justify-content:space-between; gap:12px; align-items:flex-start">
          <div style="font-family: var(--ff-mono); font-weight: 900; text-transform: uppercase;">
            ${escHtml(t.title as string)}
            <div class="ff-subtitle" style="margin-top:6px">HOST: ${escHtml(String(hostName))}${hostReliability > 0 ? ` · ${Math.round(+hostReliability * 100)}% reliable` : ""}</div>
          </div>
          <div>${statusTag}</div>
        </div>

        <div class="ff-subtitle" style="margin-top:10px">
          ${escHtml(((t.description as string) ?? "").slice(0, 220))}${(t.description as string)?.length > 220 ? "..." : ""}
        </div>

        <div style="margin-top:12px; display:flex; flex-wrap:wrap; gap:8px; font-family: var(--ff-mono); font-size: 11px;">
          <span style="border:1px solid var(--ff-rust); padding:4px 8px;">PAYOUT $${t.payout_min}–$${t.payout_max}</span>
          <span style="border:1px solid var(--ff-rust); padding:4px 8px;">ETA ~${t.estimated_minutes ?? "?"}min</span>
          ${ambiguityScore ? `<span style="border:1px solid var(--ff-rust); padding:4px 8px;">${escHtml(ambiguityLabel)}</span>` : ""}
        </div>

        <div style="margin-top:12px; display:flex; gap:10px; align-items:center; flex-wrap:wrap">
          ${canClaim ? `<button class="ff-btn claim-btn" data-task-id="${t.id}" data-action="claim" style="width:auto; padding:10px 12px;">CLAIM_TASK</button>` : ""}
          ${canReclaim ? `<button class="ff-btn claim-btn" data-task-id="${t.id}" data-action="claim" style="width:auto; padding:10px 12px;">RECLAIM_EXPIRED</button>` : ""}
          ${isMyClaim && t.status === "claimed" ? `<a class="ff-btn submit-btn" data-task-id="${t.id}" data-action="submit" href="/submit/${t.id}" style="width:auto; padding:10px 12px; text-decoration:none; display:inline-block;">SUBMIT</a>` : ""}
          ${isMyClaim && ["submitted","under_review","revision_requested"].includes(t.status as string) ? `<button class="ff-btn view-btn" data-task-id="${t.id}" data-action="view" style="width:auto; padding:10px 12px; background:#1a1614; border-color: var(--ff-rust);">VIEW</button>` : ""}
          ${!isMyClaim && !isOpen && !canReclaim ? `<span class="ff-subtitle">LOCKED: ${escHtml(String(t.status))}</span>` : ""}
        </div>

        ${t.soft_lock_expires_at && isMyClaim ? `
          <div class="ff-subtitle" style="margin-top:10px; font-family: var(--ff-mono);">
            SOFT_LOCK_EXPIRES: ${new Date(t.soft_lock_expires_at as string).toLocaleString()}
          </div>` : ""}
      </div>
    `;
  }

  async function handleAction(taskId: string, action: string): Promise<void> {
    if (action === "claim") {
      // Read invitation token from URL if present
      const urlParams = new URLSearchParams(window.location.search);
      const invitationToken = urlParams.get("invite");

      // If task is invite-only, validate invitation
      if (invitationToken) {
        const { data: invitation } = await supabase
          .from("invitations")
          .select("id, task_id, invited_user_id, accepted_at, expires_at")
          .eq("token", invitationToken)
          .maybeSingle();

        if (!invitation || new Date(invitation.expires_at) < new Date()) {
          alert("Invalid or expired invitation link.");
          return;
        }

        if (invitation.accepted_at) {
          alert("Invitation already used.");
          return;
        }

        // Accept invitation
        await supabase
          .from("invitations")
          .update({ accepted_at: new Date().toISOString() } as Record<string, unknown>)
          .eq("id", invitation.id);
      }

      const expiresAt = new Date(Date.now() + SOFT_LOCK_HOURS * 60 * 60 * 1000).toISOString();

      const { error } = await supabase
        .from("tasks")
        .update({
          status: "claimed",
          claimed_by: user!.id,
          claimed_at: new Date().toISOString(),
          soft_lock_expires_at: expiresAt,
        } as Record<string, unknown>)
        .eq("id", taskId)
        .eq("status", "open");

      if (error) {
        alert("Failed to claim task — it may have been taken by someone else.");
        await fetchTasks();
        return;
      }

      // V2: Create Stripe PaymentIntent with manual capture at claim time.
      // Host must have a valid payment method before contributor does work.
      // The PI id is stored on tasks.payment_intent_id for capture-time lookup.
      try {
        const amount = Math.round((Number(t.payout_max) || 0) * 100); // cents
        if (amount > 0) {
          const { data: piData } = await supabase.functions.invoke("create-payment-intent", {
            body: { taskId, amount, connectedAccountId: (t as Record<string, unknown>).stripe_account_id as string | undefined },
          });
          if (!piData?.success) {
            console.warn("create-payment-intent failed — task is claimed but PI not set:", piData?.error);
          }
        }
      } catch (piErr) {
        // Non-fatal: task is still claimed; PI can be created later by stripe-webhook
        console.warn("create-payment-intent invocation error:", piErr);
      }

      // Audit log
      await supabase.from("audit_log").insert({
        actor_id: user!.id,
        task_id: taskId,
        action: "claimed",
        payload: { expiresAt },
      } as Record<string, unknown>);

      // Notify host
      const { data: task } = await supabase
        .from("tasks")
        .select("project:projects(host_id)")
        .eq("id", taskId)
        .single();

      if (task) {
        const hostId = (task as Record<string, unknown>).project as Record<string, unknown>;
        await supabase.from("notifications").insert({
          user_id: hostId?.host_id,
          type: "task_claimed",
          task_id: taskId,
        } as Record<string, unknown>);
      }

      await fetchTasks();
    }
  }

  container.querySelectorAll(".filter-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      container.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      currentFilter = (btn as HTMLElement).dataset.filter!;
      render();
    });
  });

  await fetchTasks();
  pollInterval = setInterval(fetchTasks, 30_000);

  return () => clearInterval(pollInterval);
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
