/**
 * apps/web/src/pages/project.ts — Project detail + activity feed + audit log.
 *
 * Refactored: all data access through data.ts, UI through components.ts.
 */

import { requireAuth } from "../auth/middleware.js";
import { getProject, getProjectTasks, getProjectWallet, getProjectAuditLog, getCurrentUserId } from "../net/data.js";
import { renderShell } from "../ui/shell.js";
import { escHtml } from "../ui/components.js";

export async function mountProject(container: HTMLElement, projectId: string): Promise<() => void> {
  await requireAuth();

  // ── Data layer ────────────────────────────────────────────────────────────────
  let project;
  try {
    project = await getProject(projectId);
  } catch {
    container.innerHTML = `<div class="ff-shell"><div class="ff-main"><p style="font-family:var(--ff-font-mono);">Project not found.</p></div></div>`;
    return () => {};
  }

  const [taskList, wallet, logs, userId] = await Promise.all([
    getProjectTasks(projectId),
    getProjectWallet(projectId),
    getProjectAuditLog(projectId),
    getCurrentUserId(),
  ]);

  const walletDeposited = wallet?.deposited ?? 0;
  const walletLocked = wallet?.locked ?? 0;
  const walletReleased = wallet?.released ?? 0;
  const walletAvailable = walletDeposited - walletLocked - walletReleased;
  const isHost = project.host_id === userId;

  // ── Render ──────────────────────────────────────────────────────────────
  const blueprintReadme =
    (project as Record<string, unknown>).readmeDraft ??
    (project as Record<string, unknown>).readme_draft ??
    null;
  const blueprintFolder =
    (project as Record<string, unknown>).folderStructure ??
    (project as Record<string, unknown>).folder_structure ??
    null;
  const folderItems: string[] = Array.isArray(blueprintFolder) ? (blueprintFolder as string[]) : [];

  container.innerHTML = renderShell({
    title: escHtml(project.title),
    subtitle: `PROJECT_${String(project.status).toUpperCase()} · WALLET_AVAILABLE_$${walletAvailable.toFixed(2)}`,
    activePath: `/project/${projectId}`,
    contentHtml: `
      <div class="ff-grid">
        <!-- LEFT: BlueprintTree -->
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

        <!-- CENTER: WalletGauge + TaskBoard -->
        <section class="ff-panel" style="grid-column: span 6;">
          <div style="display:flex; justify-content:space-between; gap:12px; align-items:flex-end; margin-bottom:12px">
            <div>
              <div class="ff-kpi__label">WALLET_GAUGE</div>
              <div style="margin-top:6px; font-family: var(--ff-font-mono); font-weight:900;">
                DEPOSITED_$${Number(walletDeposited).toFixed(2)} · LOCKED_$${Number(walletLocked).toFixed(2)} · RELEASED_$${Number(walletReleased).toFixed(2)}
              </div>
              <div class="ff-subtitle">available = deposited - locked - released${
                walletDeposited === 0 ? " · <span style=\"color:var(--ff-muted);\">No funds deposited yet</span>" : ""
              }</div>
            </div>
            <div class="ff-subtitle">${taskList.length} TASKS · ${taskList.filter(t => t.status === "paid").length} PAID</div>
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
                taskList.length === 0
                  ? `<tr><td colspan="4" style="padding:10px; border:1px solid var(--ff-ink); color: var(--ff-muted);">NO_TASKS · Publish tasks from the create screen to populate this board.</td></tr>`
                  : taskList.map(t => {
                      const status = String(t.status ?? "").toUpperCase();
                      // Host can review a task when it's under review.
                      const canHostReview = isHost && t.status === "under_review";
                      // Contributor can submit a task they have claimed.
                      const canSubmit = !isHost && t.claimed_by === userId && t.status === "claimed";
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
                    }).join("")
              }
            </tbody>
          </table>
        </section>

        <!-- RIGHT: Audit Feed -->
        <aside class="ff-panel" style="grid-column: span 3;">
          <div class="ff-kpi__label">AUDIT_FEED</div>
          <div style="margin-top:12px; font-family: var(--ff-font-mono); font-size:11px; line-height:1.4; white-space:pre-wrap;">
            ${
              logs.length === 0
                ? `<span style="color: var(--ff-muted);">NO_ACTIVITY</span>`
                : logs.map(l => {
                    const ts = new Date(l.created_at).toISOString().replace("T", " ").slice(0, 19);
                    const actor = l.actor_id ? `0x${String(l.actor_id).slice(0, 8)}` : "SYSTEM";
                    const action = String(l.action ?? "").toUpperCase();
                    return `[${escHtml(ts)}] ${escHtml(action)} by ${escHtml(actor)}`;
                  }).join("\n")
            }
          </div>
        </aside>
      </div>
    `,
  });

  return () => {};
}
