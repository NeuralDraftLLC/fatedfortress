/**
 * apps/web/src/pages/project.ts — Project detail + activity feed + audit log.
 *
 * Refactored: all data access through data.ts, UI through components.ts.
 *
 * CHANGES (wave 6 realtime):
 *  - FIX 1: Supabase Realtime channel subscribes to tasks UPDATE + project_wallet UPDATE
 *            filtered to this project_id.  Re-fetches all three data slices and
 *            re-renders the wallet gauge, taskboard, and audit feed in-place.
 *  - FIX 2: mountProject now returns a real cleanup fn that removes the channel.
 */

import { getSupabase } from "../auth/index.js";
import { requireAuth } from "../auth/middleware.js";
import {
  getProject,
  getProjectTasks,
  getProjectWallet,
  getProjectAuditLog,
  getCurrentUserId,
} from "../net/data.js";
import { renderShell } from "../ui/shell.js";
import { escHtml } from "../ui/components.js";

export async function mountProject(
  container: HTMLElement,
  projectId: string
): Promise<() => void> {
  await requireAuth();

  // ── Initial data load ────────────────────────────────────────────────────
  let project;
  try {
    project = await getProject(projectId);
  } catch {
    container.innerHTML = `<div class="ff-shell"><div class="ff-main"><p style="font-family:var(--ff-font-mono);">Project not found.</p></div></div>`;
    return () => {};
  }

  const userId = await getCurrentUserId();

  // Shared data fetch — called on mount and on every realtime event.
  async function fetchLiveData() {
    const [taskList, wallet, logs] = await Promise.all([
      getProjectTasks(projectId),
      getProjectWallet(projectId),
      getProjectAuditLog(projectId),
    ]);
    return { taskList, wallet, logs };
  }

  let { taskList, wallet, logs } = await fetchLiveData();

  // ── Derived values ────────────────────────────────────────────────────────
  const isHost = project.host_id === userId;

  function walletNumbers(w: typeof wallet) {
    const deposited = w?.deposited ?? 0;
    const locked = w?.locked ?? 0;
    const released = w?.released ?? 0;
    const available = deposited - locked - released;
    return { deposited, locked, released, available };
  }

  // ── Blueprint fragments (static — only computed once) ────────────────────
  const blueprintReadme =
    (project as Record<string, unknown>).readmeDraft ??
    (project as Record<string, unknown>).readme_draft ??
    null;
  const blueprintFolder =
    (project as Record<string, unknown>).folderStructure ??
    (project as Record<string, unknown>).folder_structure ??
    null;
  const folderItems: string[] = Array.isArray(blueprintFolder)
    ? (blueprintFolder as string[])
    : [];

  // ── Renderers ─────────────────────────────────────────────────────────────

  function renderWalletGauge(w: typeof wallet): string {
    const { deposited, locked, released, available } = walletNumbers(w);
    return `
      <div>
        <div class="ff-kpi__label">WALLET_GAUGE</div>
        <div style="margin-top:6px; font-family: var(--ff-font-mono); font-weight:900;">
          DEPOSITED_$${Number(deposited).toFixed(2)} · LOCKED_$${Number(locked).toFixed(2)} · RELEASED_$${Number(released).toFixed(2)}
        </div>
        <div class="ff-subtitle">available = deposited - locked - released${
          deposited === 0
            ? " · <span style=\"color:var(--ff-muted);\">No funds deposited yet</span>"
            : ""
        }</div>
      </div>
    `;
  }

  function renderTaskboard(tasks: typeof taskList): string {
    const paidCount = tasks.filter((t) => t.status === "paid").length;
    return `
      <div style="display:flex; justify-content:space-between; gap:12px; align-items:flex-end; margin-bottom:12px">
        <div id="wallet-gauge-inner">${renderWalletGauge(wallet)}</div>
        <div class="ff-subtitle">${tasks.length} TASKS · ${paidCount} PAID</div>
      </div>
      <div class="ff-kpi__label" style="margin-top:10px">TASKBOARD</div>
      <table style="width:100%; border-collapse:collapse; font-family: var(--ff-font-mono); margin-top:10px">
        <thead>
          <tr>
            <th style="text-align:left; padding:10px; border:1px solid var(--ff-ink);">TASK</th>
            <th style="text-align:left; padding:10px; border:1px solid var(--ff-ink);">STATUS</th>
            <th style="text-align:right; padding:10px; border:1px solid var(--ff-ink);">PAYOUT_MAX</th>
            <th style="text-align:right; padding:10px; border:1px solid var(--ff-ink);">ACTION</th>
          </tr>
        </thead>
        <tbody>
          ${
            tasks.length === 0
              ? `<tr><td colspan="4" style="padding:10px; border:1px solid var(--ff-ink); color: var(--ff-muted);">NO_TASKS · Publish tasks from the create screen to populate this board.</td></tr>`
              : tasks
                  .map((t) => {
                    const status = String(t.status ?? "").toUpperCase();
                    const canHostReview =
                      isHost && t.status === "under_review";
                    const canSubmit =
                      !isHost &&
                      t.claimed_by === userId &&
                      t.status === "claimed";
                    const action = canHostReview
                      ? `<a href="/reviews" style="text-decoration:underline;">REVIEW</a>`
                      : canSubmit
                      ? `<a href="/submit/${t.id}" style="text-decoration:underline;">SUBMIT</a>`
                      : "—";
                    return `
                      <tr>
                        <td style="padding:10px; border:1px solid var(--ff-ink); font-weight:900; text-transform:uppercase;">${escHtml(String(t.title ?? ""))}</td>
                        <td style="padding:10px; border:1px solid var(--ff-ink);">${escHtml(status)}</td>
                        <td style="padding:10px; border:1px solid var(--ff-ink); text-align:right;">$${Number(t.payout_max ?? 0).toFixed(2)}</td>
                        <td style="padding:10px; border:1px solid var(--ff-ink); text-align:right;">${action}</td>
                      </tr>
                    `;
                  })
                  .join("")
          }
        </tbody>
      </table>
    `;
  }

  function renderAuditFeed(entries: typeof logs): string {
    return entries.length === 0
      ? `<span style="color: var(--ff-muted);">NO_ACTIVITY</span>`
      : entries
          .map((l) => {
            const ts = new Date(l.created_at)
              .toISOString()
              .replace("T", " ")
              .slice(0, 19);
            const actor = l.actor_id
              ? `0x${String(l.actor_id).slice(0, 8)}`
              : "SYSTEM";
            const action = String(l.action ?? "").toUpperCase();
            return `[${escHtml(ts)}] ${escHtml(action)} by ${escHtml(actor)}`;
          })
          .join("\n");
  }

  // ── Initial full render ────────────────────────────────────────────────────
  const { available: initialAvailable } = walletNumbers(wallet);

  container.innerHTML = renderShell({
    title: escHtml(project.title),
    subtitle: `PROJECT_${String(project.status).toUpperCase()} · WALLET_AVAILABLE_$${initialAvailable.toFixed(2)}`,
    activePath: `/project/${projectId}`,
    contentHtml: `
      <div class="ff-grid">

        <!-- LEFT: BlueprintTree (static) -->
        <aside class="ff-panel" style="grid-column: span 3;">
          <div class="ff-kpi__label">BLUEPRINT_TREE</div>
          <details open style="margin-top:12px">
            <summary style="cursor:pointer; font-family: var(--ff-font-mono); font-weight:900; text-transform:uppercase;">README_DRAFT</summary>
            <div style="margin-top:10px; white-space:pre-wrap; font-family: var(--ff-font-mono); font-size:12px; line-height:1.35;">
              ${
                typeof blueprintReadme === "string" && blueprintReadme.trim()
                  ? escHtml(blueprintReadme.trim().slice(0, 4000))
                  : `<span style="color: var(--ff-muted);">Not persisted yet.</span>`
              }
            </div>
          </details>
          <details open style="margin-top:12px">
            <summary style="cursor:pointer; font-family: var(--ff-font-mono); font-weight:900; text-transform:uppercase;">FOLDER_STRUCTURE</summary>
            <div style="margin-top:10px; font-family: var(--ff-font-mono); font-size:12px;">
              ${
                folderItems.length
                  ? `<ul style="margin:0; padding-left: 16px;">
                      ${folderItems.map((p) => `<li>${escHtml(p)}</li>`).join("")}
                    </ul>`
                  : `<span style="color: var(--ff-muted);">Not persisted yet.</span>`
              }
            </div>
          </details>
        </aside>

        <!-- CENTER: WalletGauge + TaskBoard (live) -->
        <section class="ff-panel" style="grid-column: span 6;" id="taskboard-panel">
          ${renderTaskboard(taskList)}
        </section>

        <!-- RIGHT: Audit Feed (live) -->
        <aside class="ff-panel" style="grid-column: span 3;">
          <div class="ff-kpi__label">AUDIT_FEED</div>
          <div id="audit-feed-body"
               style="margin-top:12px; font-family: var(--ff-font-mono); font-size:11px; line-height:1.4; white-space:pre-wrap;">
            ${renderAuditFeed(logs)}
          </div>
        </aside>

      </div>
    `,
  });

  // ── DOM refs for live patches ──────────────────────────────────────────────
  const $taskboard = container.querySelector<HTMLElement>("#taskboard-panel");
  const $auditFeed = container.querySelector<HTMLElement>("#audit-feed-body");

  // ── Realtime refresh ──────────────────────────────────────────────────────
  let refreshPending = false;

  async function refresh() {
    if (refreshPending) return;
    refreshPending = true;
    try {
      ({ taskList, wallet, logs } = await fetchLiveData());
      if ($taskboard) $taskboard.innerHTML = renderTaskboard(taskList);
      if ($auditFeed) $auditFeed.innerHTML = renderAuditFeed(logs);
    } catch {
      // silently swallow — stale UI is better than a crash
    } finally {
      refreshPending = false;
    }
  }

  // ── Supabase Realtime channel ──────────────────────────────────────────────
  const supabase = getSupabase();
  const channel = supabase
    .channel(`project-detail-${projectId}`)
    // tasks change for this project
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "tasks",
        filter: `project_id=eq.${projectId}`,
      },
      () => void refresh()
    )
    // wallet balance changes
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "project_wallet",
        filter: `project_id=eq.${projectId}`,
      },
      () => void refresh()
    )
    // new audit log entries
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "audit_log",
        filter: `project_id=eq.${projectId}`,
      },
      () => void refresh()
    )
    .subscribe();

  // ── Cleanup ────────────────────────────────────────────────────────────────
  return () => {
    void supabase.removeChannel(channel);
  };
}
