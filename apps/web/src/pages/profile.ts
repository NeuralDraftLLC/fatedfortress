/**
 * apps/web/src/pages/profile.ts — Contributor/host profile + review_reliability signals.
 *
 * Sections:
 *   - Identity: display name, github username (editable)
 *   - Reliability signals: score, approval rate, avg revisions, response time, totals
 *   - Portfolio: up to 3 pieces; file picker -> supabase-storage-upload -> thumbnail chip
 */

import { getSupabase } from "../auth/index.js";
import { requireAuth } from "../auth/middleware.js";
import { updateMyProfile } from "../auth/index.js";
import {
  createPortfolioUploadUrl,
  uploadToFortressStorage,
  validateFile,
} from "../net/storage.js";

const MAX_PORTFOLIO = 3;

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

  // Portfolio: stored as string[] of asset URLs on profile
  const portfolioItems: string[] =
    Array.isArray((profile as Record<string, unknown>)?.portfolio_urls)
      ? ((profile as Record<string, unknown>).portfolio_urls as string[])
      : [];

  container.innerHTML = `
    <div class="profile-page" style="max-width:680px;margin:0 auto;padding:32px 16px">

      <h1 style="font-family:var(--ff-font-mono);font-weight:900;letter-spacing:.08em;
                 text-transform:uppercase;font-size:18px;margin-bottom:28px">PROFILE</h1>

      <!-- Identity -->
      <section style="margin-bottom:32px;border-bottom:1px solid var(--ff-outline-variant);padding-bottom:28px">
        <h2 class="ff-section-label" style="margin-bottom:16px">IDENTITY</h2>

        <div style="display:flex;align-items:center;gap:20px;margin-bottom:20px">
          <div style="width:56px;height:56px;border:1px solid var(--ff-outline-variant);
                      display:flex;align-items:center;justify-content:center;
                      font-family:var(--ff-font-mono);font-weight:900;font-size:22px;
                      color:var(--ff-ink);background:var(--ff-surface-container-low);flex-shrink:0">
            ${profile?.avatar_url
              ? `<img src="${escHtml(profile.avatar_url)}" alt="Avatar"
                      style="width:100%;height:100%;object-fit:cover" />`
              : (profile?.display_name ?? user.email ?? "U")[0].toUpperCase()
            }
          </div>
          <div style="flex:1">
            <div style="font-family:var(--ff-font-mono);font-size:13px;font-weight:700;
                        color:var(--ff-ink)">${escHtml(profile?.display_name ?? "") || "&mdash;"}</div>
            <div style="font-family:var(--ff-font-mono);font-size:11px;color:var(--ff-muted);margin-top:2px">
              ${escHtml(user.email ?? "")}
            </div>
          </div>
        </div>

        <div class="ff-input-wrapper">
          <label class="ff-label" for="display-name">DISPLAY NAME</label>
          <input class="ff-input" type="text" id="display-name"
                 value="${escHtml(profile?.display_name ?? "")}" maxlength="60" />
        </div>

        <div class="ff-input-wrapper">
          <label class="ff-label" for="github-username">GITHUB USERNAME</label>
          <input class="ff-input" type="text" id="github-username"
                 value="${escHtml(profile?.github_username ?? "")}" placeholder="username" />
        </div>

        <div style="display:flex;align-items:center;gap:12px">
          <button class="ff-btn ff-btn--primary ff-btn--sm" id="save-profile-btn">Save</button>
          <span class="ff-section-label" id="save-status" style="display:none"></span>
        </div>
      </section>

      <!-- Reliability signals -->
      <section style="margin-bottom:32px;border-bottom:1px solid var(--ff-outline-variant);padding-bottom:28px">
        <h2 class="ff-section-label" style="margin-bottom:16px">RELIABILITY SIGNALS</h2>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px">
          ${reliabilityCell("Reliability",  fmt(profile?.review_reliability, "pct"))}
          ${reliabilityCell("Approval Rate", fmt(profile?.approval_rate,      "pct"))}
          ${reliabilityCell("Avg Revisions", fmt(profile?.avg_revision_count,  "dec"))}
          ${reliabilityCell("Avg Response",  fmt(profile?.avg_response_time_minutes, "min"))}
          ${reliabilityCell("Approved",      String(profile?.total_approved ?? 0))}
          ${reliabilityCell("Rejected",      String(profile?.total_rejected ?? 0))}
        </div>
      </section>

      <!-- Portfolio -->
      <section>
        <h2 class="ff-section-label" style="margin-bottom:4px">PORTFOLIO</h2>
        <p style="font-family:var(--ff-font-mono);font-size:11px;color:var(--ff-muted);margin-bottom:16px">
          Up to ${MAX_PORTFOLIO} pieces. Images or PDF.
        </p>
        <div id="portfolio-banner"></div>
        <div id="portfolio-grid" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px">
          ${portfolioItems.length > 0
            ? portfolioItems.map(url => portfolioChip(url)).join("")
            : `<span style="font-family:var(--ff-font-mono);font-size:11px;color:var(--ff-muted)">No portfolio pieces yet.</span>`
          }
        </div>
        <button class="ff-btn ff-btn--ghost ff-btn--sm" id="add-portfolio-btn"
                ${portfolioItems.length >= MAX_PORTFOLIO ? "disabled" : ""}>
          + Add piece
        </button>
        <input type="file" id="portfolio-input" style="display:none" accept="image/*,.pdf" />
      </section>

    </div>
  `;

  // ── Event listeners ──────────────────────────────────────────────────────
  const teardowns: Array<() => void> = [];
  const portfolioUrls = [...portfolioItems];

  // Save profile
  const saveBtn = container.querySelector("#save-profile-btn") as HTMLButtonElement;
  const saveStatus = container.querySelector("#save-status") as HTMLElement;
  if (saveBtn) {
    const handler = async () => {
      const displayName    = (container.querySelector("#display-name") as HTMLInputElement).value.trim();
      const githubUsername = (container.querySelector("#github-username") as HTMLInputElement).value.trim().replace("@", "");
      saveBtn.disabled = true;
      saveStatus.style.display = "inline";
      saveStatus.textContent = "Saving…";
      try {
        await updateMyProfile({ display_name: displayName, github_username: githubUsername || null } as any);
        saveStatus.textContent = "Saved.";
        saveStatus.style.color = "var(--ff-success)";
      } catch (err: unknown) {
        saveStatus.textContent = `Error: ${err instanceof Error ? err.message : "Unknown"}`;
        saveStatus.style.color = "var(--ff-error)";
      } finally {
        saveBtn.disabled = false;
        setTimeout(() => { saveStatus.style.display = "none"; }, 3000);
      }
    };
    saveBtn.addEventListener("click", handler);
    teardowns.push(() => saveBtn.removeEventListener("click", handler));
  }

  // Portfolio upload
  const addBtn       = container.querySelector("#add-portfolio-btn") as HTMLButtonElement;
  const fileInput    = container.querySelector("#portfolio-input") as HTMLInputElement;
  const portfolioGrid = container.querySelector("#portfolio-grid") as HTMLElement;
  const portfolioBanner = container.querySelector("#portfolio-banner") as HTMLElement;

  if (addBtn && fileInput) {
    const openHandler = () => fileInput.click();
    addBtn.addEventListener("click", openHandler);
    teardowns.push(() => addBtn.removeEventListener("click", openHandler));

    const changeHandler = async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      fileInput.value = "";

      // Validate
      const valid = validateFile(file, 10, ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"]);
      if (!valid.ok) {
        portfolioBanner.innerHTML = inlineBanner("error", valid.error);
        return;
      }
      if (portfolioUrls.length >= MAX_PORTFOLIO) {
        portfolioBanner.innerHTML = inlineBanner("error", `Max ${MAX_PORTFOLIO} portfolio pieces reached.`);
        return;
      }

      portfolioBanner.innerHTML = "";
      addBtn.disabled = true;
      addBtn.textContent = "Uploading…";

      try {
        const presigned = await createPortfolioUploadUrl(user.id, file.name, file.type);
        await uploadToFortressStorage(presigned, file, (pct) => {
          addBtn.textContent = `Uploading ${pct}%`;
        });

        portfolioUrls.push(presigned.assetUrl);

        // Persist to profile
        await supabase
          .from("profiles")
          .update({ portfolio_urls: portfolioUrls } as Record<string, unknown>)
          .eq("id", user.id);

        // Re-render grid
        portfolioGrid.innerHTML = portfolioUrls.map(url => portfolioChip(url)).join("");
        if (portfolioUrls.length >= MAX_PORTFOLIO) addBtn.disabled = true;
        portfolioBanner.innerHTML = inlineBanner("success", "Portfolio piece added.");
      } catch (err) {
        portfolioBanner.innerHTML = inlineBanner("error", `Upload failed: ${err instanceof Error ? err.message : "Unknown"}`);
      } finally {
        addBtn.disabled = portfolioUrls.length >= MAX_PORTFOLIO;
        addBtn.textContent = "+ Add piece";
      }
    };
    fileInput.addEventListener("change", changeHandler);
    teardowns.push(() => fileInput.removeEventListener("change", changeHandler));
  }

  return () => teardowns.forEach(fn => fn());
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function escHtml(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fmt(val: number | null | undefined, type: "pct" | "dec" | "min"): string {
  if (val == null) return "—";
  if (type === "pct") return `${Math.round(val * 100)}%`;
  if (type === "dec") return val.toFixed(1);
  if (type === "min") return `${val}m`;
  return String(val);
}

function reliabilityCell(label: string, value: string): string {
  return `
    <div class="ff-panel" style="padding:12px">
      <div class="ff-kpi__label">${label}</div>
      <div class="ff-kpi__value" style="font-size:22px;margin-top:4px">${value}</div>
    </div>`;
}

function portfolioChip(url: string): string {
  const isImg = /\.(jpe?g|png|webp|gif)$/i.test(url);
  const filename = url.split("/").pop() ?? url;
  return `
    <a href="${escHtml(url)}" target="_blank" rel="noopener noreferrer"
       style="display:inline-flex;align-items:center;gap:6px;
              border:1px solid var(--ff-outline-variant);
              font-family:var(--ff-font-mono);font-size:10px;text-transform:uppercase;
              letter-spacing:.06em;color:var(--ff-muted);text-decoration:none;
              padding:6px 10px;max-width:180px;overflow:hidden">
      ${isImg
        ? `<img src="${escHtml(url)}" alt="" width="24" height="24"
                style="object-fit:cover;border:none;flex-shrink:0" loading="lazy" />`
        : `<span style="font-size:14px">&#128196;</span>`
      }
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(filename)}</span>
    </a>`;
}

function inlineBanner(type: "success" | "error", text: string): string {
  const c = type === "success" ? "var(--ff-success)" : "var(--ff-error)";
  return `<div style="border-left:3px solid ${c};color:${c};padding:8px 12px;
                      font-family:var(--ff-font-mono);font-size:11px;
                      margin-bottom:12px">${text}</div>`;
}
