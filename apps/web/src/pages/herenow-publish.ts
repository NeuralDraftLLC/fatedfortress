/**
 * apps/web/src/pages/herenow-publish.ts
 * Route: /herenow/publish
 *
 * Full DOM publish flow — no window.prompt anywhere.
 *
 * Gate:
 *   reliability_score >= 0.70 AND total_approved >= 1
 *   If the user navigates here while ineligible, they see a locked state
 *   with their current stats and a 'Back to Profile' CTA.
 *
 * Steps:
 *   1. Enter a room name → click 'Generate link'
 *   2. Open the generated here.now deep-link in a new tab,
 *      then paste the live *.here.now URL back into the confirm input
 *   3. Click 'Save link' → persisted to profiles.herenow_url
 *      → success screen with 'Back to Profile' CTA
 */

import { getSupabase } from "../auth/index.js";
import { requireAuth } from "../auth/middleware.js";
import { linkHereNowUrl } from "../net/herenow.js";

const HERENOW_MIN_RELIABILITY = 0.70;
const HERENOW_MIN_APPROVED    = 1;

// Base URL for HereNow room creation deep-links.
// Adjust if the here.now app uses a different scheme.
const HERENOW_CREATE_BASE = "https://here.now/create";

export async function mountHereNowPublish(container: HTMLElement): Promise<() => void> {
  await requireAuth();

  const supabase = getSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return () => {};

  // Fetch profile to check gate + get existing URL
  const { data: profile } = await supabase
    .from("profiles")
    .select("reliability_score, total_approved, herenow_url, display_name")
    .eq("id", user.id)
    .single();

  const reliability   = (profile as Record<string, unknown>)?.reliability_score as number | null ?? 0;
  const totalApproved = (profile as Record<string, unknown>)?.total_approved   as number | null ?? 0;
  const existingUrl   = (profile as Record<string, unknown>)?.herenow_url      as string | null ?? null;
  const displayName   = (profile as Record<string, unknown>)?.display_name     as string | null ?? "";

  const eligible =
    reliability   >= HERENOW_MIN_RELIABILITY &&
    totalApproved >= HERENOW_MIN_APPROVED;

  // ── LOCKED STATE ──────────────────────────────────────────────────────────
  if (!eligible) {
    container.innerHTML = `
      <div style="max-width:560px;margin:0 auto;padding:40px 16px">
        <a href="/profile"
           style="font-family:var(--ff-font-mono);font-size:10px;letter-spacing:.08em;
                  text-transform:uppercase;color:var(--ff-muted);text-decoration:none;
                  display:inline-flex;align-items:center;gap:6px;margin-bottom:28px">
          &larr; BACK TO PROFILE
        </a>

        <h1 style="font-family:var(--ff-font-mono);font-weight:900;letter-spacing:.08em;
                   text-transform:uppercase;font-size:18px;margin-bottom:12px">
          PUBLISH TO HERENOW
        </h1>

        <div style="border:1px solid var(--ff-outline-variant);padding:24px;margin-top:8px">
          <p style="font-family:var(--ff-font-mono);font-size:12px;color:var(--ff-muted);margin-bottom:20px">
            Your account doesn't meet the requirements to publish to HereNow yet.
          </p>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px">
            ${gateCell("Reliability",  `${Math.round(reliability * 100)}%`,  reliability >= HERENOW_MIN_RELIABILITY)}
            ${gateCell("Min Required", "70%",                                true)}
            ${gateCell("Approved Tasks", String(totalApproved),              totalApproved >= HERENOW_MIN_APPROVED)}
            ${gateCell("Min Required",  String(HERENOW_MIN_APPROVED),        true)}
          </div>

          <a href="/profile" class="ff-btn ff-btn--ghost ff-btn--sm">Back to Profile</a>
        </div>
      </div>`;
    return () => {};
  }

  // ── ELIGIBLE STATE ────────────────────────────────────────────────────────
  container.innerHTML = `
    <div id="hn-page" style="max-width:560px;margin:0 auto;padding:40px 16px">
      <a href="/profile"
         style="font-family:var(--ff-font-mono);font-size:10px;letter-spacing:.08em;
                text-transform:uppercase;color:var(--ff-muted);text-decoration:none;
                display:inline-flex;align-items:center;gap:6px;margin-bottom:28px">
        &larr; BACK TO PROFILE
      </a>

      <h1 style="font-family:var(--ff-font-mono);font-weight:900;letter-spacing:.08em;
                 text-transform:uppercase;font-size:18px;margin-bottom:6px">
        PUBLISH TO HERENOW
      </h1>
      <p style="font-family:var(--ff-font-mono);font-size:11px;color:var(--ff-muted);margin-bottom:28px">
        Create a live HereNow room and link it to your Fated Fortress profile.
      </p>

      ${existingUrl ? `
        <div style="border-left:3px solid var(--ff-success);padding:10px 14px;
                    font-family:var(--ff-font-mono);font-size:11px;margin-bottom:24px">
          <span style="color:var(--ff-muted)">Currently linked:</span>&nbsp;
          <a href="${escHtml(existingUrl)}" target="_blank" rel="noopener noreferrer"
             style="color:var(--ff-primary);word-break:break-all">${escHtml(existingUrl)}</a>
        </div>` : ""}

      <!-- Step 1: Room name -->
      <div id="hn-step-1" style="margin-bottom:28px">
        <div style="font-family:var(--ff-font-mono);font-size:10px;font-weight:900;
                    letter-spacing:.1em;text-transform:uppercase;
                    color:var(--ff-muted);margin-bottom:12px">
          STEP 1 &mdash; NAME YOUR ROOM
        </div>
        <div class="ff-input-wrapper">
          <label class="ff-label" for="hn-room-name">ROOM NAME</label>
          <input class="ff-input" type="text" id="hn-room-name"
                 placeholder="e.g. my-design-room"
                 value="${escHtml(slugify(displayName))}"
                 maxlength="60"
                 autocomplete="off"
                 spellcheck="false" />
          <span style="font-family:var(--ff-font-mono);font-size:10px;color:var(--ff-muted);margin-top:4px;display:block">
            Lowercase, hyphens only. This becomes your room's subdomain on here.now.
          </span>
        </div>
        <button class="ff-btn ff-btn--primary ff-btn--sm" id="hn-generate-btn" style="margin-top:12px">
          Generate link &rarr;
        </button>
        <div id="hn-step1-err" style="display:none;margin-top:10px"></div>
      </div>

      <!-- Step 2: Open link + paste back URL (hidden until step 1 complete) -->
      <div id="hn-step-2" style="display:none;margin-bottom:28px">
        <div style="font-family:var(--ff-font-mono);font-size:10px;font-weight:900;
                    letter-spacing:.1em;text-transform:uppercase;
                    color:var(--ff-muted);margin-bottom:12px">
          STEP 2 &mdash; OPEN &amp; CONFIRM
        </div>

        <div style="border:1px solid var(--ff-outline-variant);padding:16px;margin-bottom:16px">
          <p style="font-family:var(--ff-font-mono);font-size:11px;color:var(--ff-muted);margin-bottom:12px">
            Open this link in a new tab to create your HereNow room.
            Once it's live, copy the URL from your browser bar and paste it below.
          </p>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <a id="hn-deeplink" href="" target="_blank" rel="noopener noreferrer"
               class="ff-btn ff-btn--ghost ff-btn--sm">Open HereNow &nearr;</a>
            <button class="ff-btn ff-btn--ghost ff-btn--sm" id="hn-copy-link-btn">Copy link</button>
          </div>
          <div id="hn-copy-confirm"
               style="display:none;font-family:var(--ff-font-mono);font-size:10px;
                      color:var(--ff-success);margin-top:8px">Copied!</div>
        </div>

        <div class="ff-input-wrapper">
          <label class="ff-label" for="hn-live-url">PASTE YOUR LIVE HERENOW URL</label>
          <input class="ff-input" type="url" id="hn-live-url"
                 placeholder="https://your-room.here.now"
                 autocomplete="off"
                 spellcheck="false" />
          <span style="font-family:var(--ff-font-mono);font-size:10px;color:var(--ff-muted);margin-top:4px;display:block">
            Must start with https:// and end with .here.now
          </span>
        </div>

        <div style="display:flex;align-items:center;gap:12px;margin-top:12px">
          <button class="ff-btn ff-btn--primary ff-btn--sm" id="hn-save-btn">Save link</button>
          <button class="ff-btn ff-btn--ghost ff-btn--sm" id="hn-back-btn">&larr; Back</button>
        </div>
        <div id="hn-step2-err" style="display:none;margin-top:10px"></div>
      </div>

      <!-- Step 3: Success (hidden until step 2 complete) -->
      <div id="hn-step-3" style="display:none">
        <div style="border-left:3px solid var(--ff-success);padding:16px 20px">
          <div style="font-family:var(--ff-font-mono);font-weight:900;font-size:13px;
                      color:var(--ff-ink);margin-bottom:8px">&#10003; HereNow room linked!</div>
          <div id="hn-saved-url"
               style="font-family:var(--ff-font-mono);font-size:11px;color:var(--ff-muted);
                      word-break:break-all;margin-bottom:16px"></div>
          <a href="/profile" class="ff-btn ff-btn--primary ff-btn--sm">Back to Profile</a>
        </div>
      </div>
    </div>
  `;

  // ── Wire events ───────────────────────────────────────────────────────────
  const teardowns: Array<() => void> = [];

  const step1El        = container.querySelector("#hn-step-1")    as HTMLElement;
  const step2El        = container.querySelector("#hn-step-2")    as HTMLElement;
  const step3El        = container.querySelector("#hn-step-3")    as HTMLElement;
  const roomInput      = container.querySelector("#hn-room-name") as HTMLInputElement;
  const generateBtn    = container.querySelector("#hn-generate-btn") as HTMLButtonElement;
  const step1Err       = container.querySelector("#hn-step1-err") as HTMLElement;
  const deepLink       = container.querySelector("#hn-deeplink")  as HTMLAnchorElement;
  const copyLinkBtn    = container.querySelector("#hn-copy-link-btn") as HTMLButtonElement;
  const copyConfirm    = container.querySelector("#hn-copy-confirm") as HTMLElement;
  const liveUrlInput   = container.querySelector("#hn-live-url")  as HTMLInputElement;
  const saveBtn        = container.querySelector("#hn-save-btn")  as HTMLButtonElement;
  const backBtn        = container.querySelector("#hn-back-btn")  as HTMLButtonElement;
  const step2Err       = container.querySelector("#hn-step2-err") as HTMLElement;
  const savedUrlEl     = container.querySelector("#hn-saved-url") as HTMLElement;

  let generatedHref = "";

  // Step 1 → Step 2: generate deep-link
  const onGenerate = () => {
    step1Err.style.display = "none";
    const raw  = roomInput.value.trim();
    const slug = slugify(raw);

    if (!slug || slug.length < 2) {
      step1Err.innerHTML = errBanner("Room name must be at least 2 characters and contain only letters, numbers, or hyphens.");
      step1Err.style.display = "block";
      return;
    }

    // Build the here.now create deep-link
    const params = new URLSearchParams({ room: slug, ref: "fatedfortress" });
    generatedHref = `${HERENOW_CREATE_BASE}?${params.toString()}`;
    deepLink.href = generatedHref;

    step1El.style.display = "none";
    step2El.style.display = "block";
    liveUrlInput.focus();
  };
  generateBtn.addEventListener("click", onGenerate);
  teardowns.push(() => generateBtn.removeEventListener("click", onGenerate));

  // Allow Enter in room name input to advance
  const onRoomKeydown = (e: KeyboardEvent) => { if (e.key === "Enter") onGenerate(); };
  roomInput.addEventListener("keydown", onRoomKeydown);
  teardowns.push(() => roomInput.removeEventListener("keydown", onRoomKeydown));

  // Copy deep-link to clipboard
  const onCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(generatedHref);
      copyConfirm.style.display = "block";
      setTimeout(() => { copyConfirm.style.display = "none"; }, 2000);
    } catch {
      copyLinkBtn.textContent = "(copy manually)";
    }
  };
  copyLinkBtn.addEventListener("click", onCopyLink);
  teardowns.push(() => copyLinkBtn.removeEventListener("click", onCopyLink));

  // Step 2 → Step 1: back
  const onBack = () => {
    step2El.style.display = "none";
    step1El.style.display = "block";
    step2Err.style.display = "none";
    liveUrlInput.value = "";
  };
  backBtn.addEventListener("click", onBack);
  teardowns.push(() => backBtn.removeEventListener("click", onBack));

  // Step 2 → Step 3: save
  const onSave = async () => {
    step2Err.style.display = "none";
    const url = liveUrlInput.value.trim();

    saveBtn.disabled = true;
    saveBtn.textContent = "Saving\u2026";

    try {
      await linkHereNowUrl(user.id, url);
      // Show success
      savedUrlEl.innerHTML = `<a href="${escHtml(url)}" target="_blank" rel="noopener noreferrer"
        style="color:var(--ff-primary)">${escHtml(url)}</a>`;
      step2El.style.display = "none";
      step3El.style.display = "block";
    } catch (err) {
      step2Err.innerHTML = errBanner(err instanceof Error ? err.message : "Unknown error");
      step2Err.style.display = "block";
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save link";
    }
  };
  saveBtn.addEventListener("click", onSave);
  teardowns.push(() => saveBtn.removeEventListener("click", onSave));

  // Allow Enter in live URL input to save
  const onUrlKeydown = (e: KeyboardEvent) => { if (e.key === "Enter") onSave(); };
  liveUrlInput.addEventListener("keydown", onUrlKeydown);
  teardowns.push(() => liveUrlInput.removeEventListener("keydown", onUrlKeydown));

  return () => teardowns.forEach(fn => fn());
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert a display name or arbitrary string into a URL-safe slug. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function escHtml(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function errBanner(text: string): string {
  return `<div style="border-left:3px solid var(--ff-error);color:var(--ff-error);
                      padding:8px 12px;font-family:var(--ff-font-mono);font-size:11px">
    ${escHtml(text)}
  </div>`;
}

function gateCell(label: string, value: string, met: boolean): string {
  const color = met ? "var(--ff-success)" : "var(--ff-error)";
  return `<div style="border:1px solid var(--ff-outline-variant);padding:12px">
    <div style="font-family:var(--ff-font-mono);font-size:9px;text-transform:uppercase;
                letter-spacing:.08em;color:var(--ff-muted);margin-bottom:4px">${escHtml(label)}</div>
    <div style="font-family:var(--ff-font-mono);font-size:18px;font-weight:900;color:${color}">${escHtml(value)}</div>
  </div>`;
}
