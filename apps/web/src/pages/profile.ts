/**
 * apps/web/src/pages/profile.ts — Minimal contributor/host profile + review_reliability signals.
 */

import { getSupabase } from "../auth/index.js";
import { requireAuth } from "../auth/middleware.js";
import { updateMyProfile } from "../auth/index.js";
import { createPortfolioUploadUrl, uploadToR2 } from "../net/storage.js";

export async function mountProfile(container: HTMLElement): Promise<() => void> {
  await requireAuth();

  const supabase = getSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return () => {};

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  container.innerHTML = `
    <div class="profile-page">
      <header class="profile-header">
        <h1 class="profile-title">Profile</h1>
      </header>

      <div class="profile-card">
        <div class="profile-avatar">
          ${profile?.avatar_url
            ? `<img src="${escHtml(profile.avatar_url)}" alt="Avatar" />`
            : `<div class="avatar-placeholder">${(profile?.display_name ?? user.email ?? "U")[0].toUpperCase()}</div>`}
        </div>
        <div class="profile-info">
          <div class="form-field">
            <label>Display name</label>
            <input type="text" id="display-name" value="${escHtml(profile?.display_name ?? "")}" maxlength="60" />
          </div>
          <div class="form-field">
            <label>GitHub username</label>
            <input type="text" id="github-username" value="${escHtml(profile?.github_username ?? "")}" placeholder="username" />
          </div>
          <button class="btn btn--primary" id="save-profile-btn">Save</button>
          <p class="save-status hidden" id="save-status"></p>
        </div>
      </div>

      <div class="profile-reliability">
        <h2>Reliability Signals</h2>
        <div class="reliability-grid">
          <div class="reliability-card">
            <span class="reliability-value">${profile?.review_reliability != null ? `${Math.round(profile.review_reliability * 100)}%` : "—"}</span>
            <span class="reliability-label">Reliability Score</span>
          </div>
          <div class="reliability-card">
            <span class="reliability-value">${profile?.approval_rate != null ? `${Math.round(profile.approval_rate * 100)}%` : "—"}</span>
            <span class="reliability-label">Approval Rate</span>
          </div>
          <div class="reliability-card">
            <span class="reliability-value">${profile?.avg_revision_count != null ? profile.avg_revision_count.toFixed(1) : "—"}</span>
            <span class="reliability-label">Avg Revisions</span>
          </div>
          <div class="reliability-card">
            <span class="reliability-value">${profile?.avg_response_time_minutes ?? "—"}m</span>
            <span class="reliability-label">Avg Response Time</span>
          </div>
          <div class="reliability-card">
            <span class="reliability-value">${profile?.total_approved ?? 0}</span>
            <span class="reliability-label">Tasks Approved</span>
          </div>
          <div class="reliability-card">
            <span class="reliability-value">${profile?.total_rejected ?? 0}</span>
            <span class="reliability-label">Tasks Rejected</span>
          </div>
        </div>
      </div>

      <div class="profile-portfolio">
        <h2>Portfolio (up to 3)</h2>
        <div class="portfolio-grid" id="portfolio-grid">
          <div class="portfolio-empty">No portfolio pieces yet.</div>
        </div>
        <button class="btn btn--ghost" id="add-portfolio-btn">+ Add portfolio piece</button>
        <input type="file" id="portfolio-input" class="hidden" accept="image/*,.pdf" />
      </div>
    </div>
  `;

  // ── Save profile ────────────────────────────────────────────────────────
  container.querySelector("#save-profile-btn")?.addEventListener("click", async () => {
    const displayName = (container.querySelector("#display-name") as HTMLInputElement).value.trim();
    const githubUsername = (container.querySelector("#github-username") as HTMLInputElement).value.trim().replace("@", "");

    const btn = container.querySelector("#save-profile-btn") as HTMLButtonElement;
    const status = container.querySelector("#save-status") as HTMLElement;
    btn.disabled = true;
    status.textContent = "Saving...";

    try {
      await updateMyProfile({ display_name: displayName, github_username: githubUsername || null } as any);
      status.textContent = "Saved!";
      status.classList.remove("hidden");
    } catch (err: any) {
      status.textContent = `Error: ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  });

  // ── Portfolio upload stub ──────────────────────────────────────────────
  container.querySelector("#add-portfolio-btn")?.addEventListener("click", () => {
    (container.querySelector("#portfolio-input") as HTMLInputElement)?.click();
  });

  return () => {};
}

function escHtml(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}
