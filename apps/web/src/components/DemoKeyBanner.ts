/**
 * apps/web/src/components/DemoKeyBanner.ts — NEW FILE
 *
 * PRIORITY 1 · Sticky banner shown when the room is operating under a
 * demo grant. Displays remaining token count, expiry, and a clear CTA
 * to connect the user's own key.
 */

import type { DemoGrant } from "../net/worker-bridge.js";

export function mountDemoKeyBanner(
  grant: DemoGrant,
  onConnectKey: () => void,
): () => void {
  const banner = document.createElement("aside");
  banner.className = "ff-demo-banner";
  banner.setAttribute("role", "status");
  banner.setAttribute("aria-live", "polite");

  const expiresLabel = new Date(grant.expiresAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  banner.innerHTML = `
    <div class="ff-demo-banner-content">
      <span class="ff-demo-banner-icon" aria-hidden="true">◍</span>
      <span class="ff-demo-banner-text">
        You're on a <strong>demo key</strong> · ${grant.maxTokens.toLocaleString()} tokens · expires ${expiresLabel}
      </span>
      <button class="ff-demo-banner-cta" type="button">
        Connect your key →
      </button>
      <button class="ff-demo-banner-dismiss" type="button" aria-label="Dismiss banner">×</button>
    </div>
  `;

  const cta = banner.querySelector(".ff-demo-banner-cta") as HTMLButtonElement;
  const dismiss = banner.querySelector(".ff-demo-banner-dismiss") as HTMLButtonElement;

  cta.addEventListener("click", onConnectKey);
  dismiss.addEventListener("click", () => banner.remove());

  document.body.appendChild(banner);

  return () => banner.remove();
}

/** Fallback banner when demo is unavailable and user needs to connect a key to proceed. */
export function mountKeyPromptBanner(reason: string): () => void {
  const banner = document.createElement("aside");
  banner.className = "ff-demo-banner ff-demo-banner-blocked";
  banner.setAttribute("role", "alert");

  banner.innerHTML = `
    <div class="ff-demo-banner-content">
      <span class="ff-demo-banner-icon" aria-hidden="true">⚠</span>
      <span class="ff-demo-banner-text">${escapeHTML(reason)}</span>
      <a class="ff-demo-banner-cta" href="#/connect">Connect key</a>
    </div>
  `;

  document.body.appendChild(banner);
  return () => banner.remove();
}

function escapeHTML(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
