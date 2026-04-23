/**
 * apps/web/src/pages/settings.ts — GitHub + Stripe Connect onboarding.
 */

import { getSupabase } from "../auth/index.js";
import { requireAuth } from "../auth/middleware.js";
import { createConnectAccountLink } from "../handlers/payout.js";
import { signOut } from "../auth/index.js";
import { exchangeGitHubCode, initiateGitHubOAuth } from "../net/github.js";

export async function mountSettings(container: HTMLElement): Promise<() => void> {
  requireAuth();

  const supabase = getSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return () => {};

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  const isHost = profile?.role === "host";

  container.innerHTML = `
    <div class="settings-page">
      <header class="settings-header">
        <h1 class="settings-title">Settings</h1>
      </header>

      <section class="settings-section">
        <h2>Account</h2>
        <div class="settings-row">
          <span>${user.email}</span>
          <button class="btn btn--ghost btn--sm" id="signout-btn">Sign out</button>
        </div>
        <div class="settings-row">
          <span>Role: ${profile?.role ?? "—"}</span>
        </div>
      </section>

      ${isHost ? `
      <section class="settings-section">
        <h2>Stripe Connect</h2>
        <p class="settings-desc">Connect Stripe to add funds to your project wallet and pay contributors when you approve their work.</p>
        <div class="stripe-status" id="stripe-status">
          ${(profile as any)?.stripe_account_id
            ? `<span class="status--active">Stripe connected</span>`
            : `<span class="status--inactive">Not connected</span>`}
        </div>
        <button class="btn btn--primary" id="connect-stripe-btn">
          ${(profile as any)?.stripe_account_id ? "Manage Stripe Account" : "Connect Stripe Account"}
        </button>
      </section>
      ` : ""}

      <section class="settings-section">
        <h2>GitHub</h2>
        <p class="settings-desc">Connect your GitHub account to create PRs and branches for code tasks.</p>
        <button class="btn btn--primary" id="connect-github-btn">Connect GitHub</button>
      </section>
    </div>
  `;

  container.querySelector("#signout-btn")?.addEventListener("click", async () => {
    await signOut();
    window.location.href = "/login";
  });

  if (isHost) {
    container.querySelector("#connect-stripe-btn")?.addEventListener("click", async () => {
      const btn = container.querySelector("#connect-stripe-btn") as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = "Redirecting to Stripe...";
      try {
        const url = await createConnectAccountLink(user.id);
        window.location.href = url;
      } catch (err: unknown) {
        btn.disabled = false;
        btn.textContent = "Error — try again";
        alert(`Stripe onboarding failed: ${err instanceof Error ? err.message : "Unknown error"}`);
      }
    });
  }

  container.querySelector("#connect-github-btn")?.addEventListener("click", () => {
    initiateGitHubOAuth();
  });

  return () => {};
}

/**
 * OAuth callback handler — attached to /github/callback route in main.ts.
 * Exchanges the code, stores token + username on profile, redirects to /settings.
 */
export async function mountGitHubCallback(_container: HTMLElement): Promise<() => void> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const error = params.get("error");

  if (error || !code) {
    window.location.href = "/settings?github_error=1";
    return () => {};
  }

  try {
    await exchangeGitHubCode(code);
  } catch {
    window.location.href = "/settings?github_error=1";
    return () => {};
  }

  window.location.href = "/settings?github_connected=1";
  return () => {};
}
