/**
 * apps/web/src/pages/callback.ts — /auth/callback route mount.
 *
 * Supabase redirects here after:
 *   - Email magic link click
 *   - Google OAuth return
 *
 * This page shows a loading state while handleAuthCallback() exchanges
 * the token, patches the profile role, and redirects to the correct
 * post-auth destination (/create for hosts, /tasks for contributors).
 *
 * The user should never see this page for more than ~1-2 seconds.
 * An 8-second timeout in handleAuthCallback() falls back to /login.
 */

import { handleAuthCallback } from "../auth/middleware.js";

export async function mountCallback(container: HTMLElement): Promise<() => void> {
  container.innerHTML = `
    <div style="
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 60vh;
      gap: 20px;
      font-family: var(--ff-font-mono);
    ">
      <div style="
        font-size: 11px;
        letter-spacing: 0.2em;
        text-transform: uppercase;
        color: var(--ff-muted);
        animation: ff-pulse 1.4s ease-in-out infinite;
      ">Authenticating…</div>

      <div style="
        width: 200px;
        height: 2px;
        background: var(--ff-border);
        position: relative;
        overflow: hidden;
      ">
        <div style="
          position: absolute;
          inset: 0;
          background: var(--ff-ink);
          animation: ff-scan 1.4s ease-in-out infinite;
          transform-origin: left;
        "></div>
      </div>

      <div style="font-size:10px;color:var(--ff-muted);opacity:0.5">
        Verifying session…
      </div>
    </div>

    <style>
      @keyframes ff-pulse {
        0%, 100% { opacity: 1; }
        50%       { opacity: 0.4; }
      }
      @keyframes ff-scan {
        0%   { transform: scaleX(0); transform-origin: left; }
        50%  { transform: scaleX(1); transform-origin: left; }
        51%  { transform: scaleX(1); transform-origin: right; }
        100% { transform: scaleX(0); transform-origin: right; }
      }
    </style>
  `;

  // Kick off token exchange + profile patch + redirect.
  // handleAuthCallback() never returns normally — it always redirects.
  // The returned cleanup is a no-op since we navigate away.
  handleAuthCallback().catch(() => {
    window.location.replace("/login");
  });

  return () => {};
}
