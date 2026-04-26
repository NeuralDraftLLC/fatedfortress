/**
 * apps/web/src/pages/settings.ts — GitHub + Stripe Connect + wallet onboarding.
 *
 * Sections by role:
 *   All users  : Account info, GitHub connect
 *   Host only  : Stripe Connect (with live status chip), Fund Project Wallet
 *   Contributor: Skills list, Reliability score
 *
 * Stripe status: fetched from get-stripe-status edge fn on mount.
 *   charges_enabled  → green chip "CHARGES ENABLED"
 *   payouts_enabled  → green chip "PAYOUTS ENABLED"
 *   !charges_enabled → amber chip "PENDING VERIFICATION" + Fund Wallet disabled
 */

import { getSupabase, signOut } from "../auth/index.js";
import { requireAuth } from "../auth/middleware.js";
import { createConnectAccountLink, fundProjectWallet } from "../handlers/payout.js";
import { initiateGitHubOAuth, exchangeGitHubCode } from "../net/github.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function banner(type: "success" | "error", text: string): string {
  const bg     = type === "success" ? "var(--ff-success-bg, #0f2b1a)" : "var(--ff-error-bg, #2b0f0f)";
  const border = type === "success" ? "var(--ff-success, #2a9d8f)"    : "var(--ff-error, #ef476f)";
  const color  = type === "success" ? "var(--ff-success, #2a9d8f)"    : "var(--ff-error, #ef476f)";
  return `<div class="settings-banner" style="background:${bg};border-left:3px solid ${border};color:${color};padding:10px 14px;margin-bottom:16px;font-size:13px;border-radius:2px">${text}</div>`;
}

function chip(label: string, tone: "neutral" | "success" | "warn" = "neutral"): string {
  const color = tone === "success" ? "var(--ff-success,#2a9d8f)"
              : tone === "warn"    ? "var(--ff-warning,#e9c46a)"
              : "var(--ff-muted)";
  return `<span class="ff-badge ff-badge--neutral" style="font-size:11px;letter-spacing:.04em;color:${color}">${label}</span>`;
}

interface StripeStatus {
  charges_enabled:  boolean;
  payouts_enabled:  boolean;
  details_submitted: boolean;
}

async function fetchStripeStatus(userId: string): Promise<StripeStatus | null> {
  try {
    const supabase = getSupabase();
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) return null;

    const res = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/get-stripe-status`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "x-user-id": userId,
        },
        signal: AbortSignal.timeout(6000),
      }
    );
    if (!res.ok) return null;
    return await res.json() as StripeStatus;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main mount
// ---------------------------------------------------------------------------

export async function mountSettings(container: HTMLElement): Promise<() => void> {
  await requireAuth();

  const supabase = getSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return () => {};

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  const isHost        = profile?.role === "host";
  const isContributor = profile?.role === "contributor";
  const stripeId      = (profile as Record<string, unknown>)?.stripe_account_id as string | null;
  const githubUser    = (profile as Record<string, unknown>)?.github_username as string | null;
  const skills        = (profile as Record<string, unknown>)?.skills as string[] | null ?? [];
  const reliability   = (profile as Record<string, unknown>)?.reliability_score as number | null;

  // Read URL params
  const params           = new URLSearchParams(window.location.search);
  const githubConnected  = params.get("github_connected") === "1";
  const githubError      = params.get("github_error")     === "1";
  const stripeReturn     = params.get("stripe_return")    === "1";

  if (githubConnected || githubError || stripeReturn) {
    history.replaceState({}, "", window.location.pathname);
  }

  // ── Fetch live Stripe status if host has connected ───────────────────────
  let stripeStatus: StripeStatus | null = null;
  if (isHost && stripeId) {
    stripeStatus = await fetchStripeStatus(user.id);
  }

  const chargesEnabled  = stripeStatus?.charges_enabled  ?? false;
  const payoutsEnabled  = stripeStatus?.payouts_enabled  ?? false;
  const fundWalletReady = isHost && chargesEnabled;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  container.innerHTML = `
    <div class="settings-page" style="max-width:640px;margin:0 auto;padding:32px 16px">

      <h1 style="font-size:18px;font-weight:700;letter-spacing:.08em;margin-bottom:28px">SETTINGS</h1>

      ${githubConnected ? banner("success", "GitHub connected successfully.")                              : ""}
      ${githubError     ? banner("error",   "GitHub connection failed. Please try again.")                 : ""}
      ${stripeReturn    ? banner("success",  "Stripe onboarding complete. You can now fund your project wallet.") : ""}

      <div id="settings-stripe-banner"></div>
      <div id="settings-github-banner"></div>

      <!-- ── Account ──────────────────────────────────────────── -->
      <section class="settings-section" style="margin-bottom:32px;border-bottom:1px solid var(--ff-border);padding-bottom:28px">
        <h2 style="font-size:11px;letter-spacing:.1em;color:var(--ff-muted);margin-bottom:14px">ACCOUNT</h2>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <span style="font-size:13px">${user.email}</span>
          <button class="ff-btn ff-btn--ghost ff-btn--sm" id="signout-btn">Sign out</button>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:12px;color:var(--ff-muted)">Role</span>
          ${chip((profile?.role ?? "unknown").toUpperCase())}
          ${reliability != null ? chip(`RELIABILITY ${Math.round(reliability * 100)}%`) : ""}
        </div>
      </section>

      <!-- ── Contributor: Skills ───────────────────────────────── -->
      ${isContributor ? `
      <section class="settings-section" style="margin-bottom:32px;border-bottom:1px solid var(--ff-border);padding-bottom:28px">
        <h2 style="font-size:11px;letter-spacing:.1em;color:var(--ff-muted);margin-bottom:14px">SKILLS</h2>
        <p style="font-size:12px;color:var(--ff-muted);margin-bottom:12px">Skills are matched to task <code>accepted_roles[]</code> when filtering the marketplace.</p>
        <div style="display:flex;flex-wrap:wrap;gap:6px">
          ${skills.length > 0
            ? skills.map((s) => chip(s.toUpperCase())).join("")
            : `<span style="font-size:12px;color:var(--ff-faint)">No skills on profile yet. Contact support to update.</span>`
          }
        </div>
      </section>
      ` : ""}

      <!-- ── Host: Stripe Connect ───────────────────────────────── -->
      ${isHost ? `
      <section class="settings-section" style="margin-bottom:32px;border-bottom:1px solid var(--ff-border);padding-bottom:28px">
        <h2 style="font-size:11px;letter-spacing:.1em;color:var(--ff-muted);margin-bottom:14px">STRIPE CONNECT</h2>
        <p style="font-size:12px;color:var(--ff-muted);margin-bottom:14px">Connect Stripe to fund your project wallet and pay contributors on approval.</p>
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap">
          ${stripeId
            ? `<span style="color:var(--ff-success,#2a9d8f);font-size:12px">&#10003; Connected</span>
               ${chip(stripeId.slice(0, 18) + "\u2026")}
               ${stripeStatus
                 ? `${chargesEnabled  ? chip("CHARGES ENABLED",  "success") : chip("PENDING VERIFICATION", "warn")}
                    ${payoutsEnabled  ? chip("PAYOUTS ENABLED",  "success") : ""}`
                 : chip("STATUS UNKNOWN")
               }`
            : `<span style="color:var(--ff-muted);font-size:12px">Not connected</span>`
          }
        </div>
        ${
          stripeId && !chargesEnabled
            ? `<p style="font-size:11px;color:var(--ff-warning,#e9c46a);margin-bottom:12px">&#9888; Stripe verification is pending. Complete onboarding to enable wallet funding.</p>`
            : ""
        }
        <button class="ff-btn ff-btn--primary" id="connect-stripe-btn">
          ${stripeId ? "Manage Stripe Account" : "Connect Stripe Account"}
        </button>
      </section>

      <!-- ── Host: Fund Wallet ─────────────────────────────────── -->
      <section class="settings-section" style="margin-bottom:32px;border-bottom:1px solid var(--ff-border);padding-bottom:28px"
               id="fund-wallet-section">
        <h2 style="font-size:11px;letter-spacing:.1em;color:var(--ff-muted);margin-bottom:14px">FUND PROJECT WALLET</h2>
        ${!fundWalletReady
          ? `<p style="font-size:12px;color:var(--ff-muted)">Stripe charges must be enabled before funding a wallet.</p>`
          : `<p style="font-size:12px;color:var(--ff-muted);margin-bottom:14px">Pre-fund a project wallet so funds are locked at claim time. Amount in USD cents (e.g. 5000 = $50.00).</p>
             <div id="fund-wallet-banner"></div>
             <div style="display:flex;gap:8px;align-items:flex-end">
               <div style="flex:1">
                 <label style="font-size:11px;color:var(--ff-muted);display:block;margin-bottom:4px">PROJECT ID</label>
                 <input id="fund-project-id" class="ff-input" type="text" placeholder="uuid" style="width:100%" />
               </div>
               <div style="width:120px">
                 <label style="font-size:11px;color:var(--ff-muted);display:block;margin-bottom:4px">AMOUNT (CENTS)</label>
                 <input id="fund-amount" class="ff-input" type="number" min="100" placeholder="5000" style="width:100%" />
               </div>
               <button class="ff-btn ff-btn--primary" id="fund-wallet-btn">Fund</button>
             </div>`
        }
      </section>
      ` : ""}

      <!-- ── GitHub ─────────────────────────────────────────────── -->
      <section class="settings-section" style="margin-bottom:32px">
        <h2 style="font-size:11px;letter-spacing:.1em;color:var(--ff-muted);margin-bottom:14px">GITHUB</h2>
        <p style="font-size:12px;color:var(--ff-muted);margin-bottom:14px">Required for code / PR task submissions and asset scanner access.</p>
        ${githubUser
          ? `<div style="display:flex;align-items:center;gap:10px">
               <span style="color:var(--ff-success,#2a9d8f);font-size:12px">&#10003; Connected as</span>${chip("@" + githubUser)}
               <button class="ff-btn ff-btn--ghost ff-btn--sm" id="disconnect-github-btn">Disconnect</button>
             </div>`
          : `<button class="ff-btn ff-btn--primary" id="connect-github-btn">Connect GitHub</button>`
        }
      </section>

    </div>
  `;

  // ---------------------------------------------------------------------------
  // Event listeners
  // ---------------------------------------------------------------------------
  const teardowns: Array<() => void> = [];

  // Sign out
  const signoutBtn = container.querySelector("#signout-btn") as HTMLButtonElement | null;
  if (signoutBtn) {
    const handler = async () => { await signOut(); window.location.href = "/login"; };
    signoutBtn.addEventListener("click", handler);
    teardowns.push(() => signoutBtn.removeEventListener("click", handler));
  }

  // Stripe connect
  if (isHost) {
    const stripeBtn = container.querySelector("#connect-stripe-btn") as HTMLButtonElement | null;
    if (stripeBtn) {
      const handler = async () => {
        const stripeBanner = container.querySelector("#settings-stripe-banner") as HTMLElement;
        stripeBtn.disabled = true;
        stripeBtn.textContent = "Redirecting\u2026";
        try {
          const url = await createConnectAccountLink(user.id);
          window.location.href = url;
        } catch (err) {
          stripeBtn.disabled = false;
          stripeBtn.textContent = stripeId ? "Manage Stripe Account" : "Connect Stripe Account";
          stripeBanner.innerHTML = banner("error", `Stripe onboarding failed: ${err instanceof Error ? err.message : "Unknown error"}`);
        }
      };
      stripeBtn.addEventListener("click", handler);
      teardowns.push(() => stripeBtn.removeEventListener("click", handler));
    }

    // Fund wallet — only wired when charges are enabled
    if (fundWalletReady) {
      const fundBtn       = container.querySelector("#fund-wallet-btn")   as HTMLButtonElement | null;
      const fundBanner    = container.querySelector("#fund-wallet-banner") as HTMLElement | null;
      const fundProjectId = container.querySelector("#fund-project-id")   as HTMLInputElement | null;
      const fundAmount    = container.querySelector("#fund-amount")        as HTMLInputElement | null;
      if (fundBtn && fundBanner && fundProjectId && fundAmount) {
        const handler = async () => {
          const projectId = fundProjectId.value.trim();
          const amount    = parseInt(fundAmount.value, 10);
          if (!projectId) { fundBanner.innerHTML = banner("error", "Project ID is required."); return; }
          if (!amount || amount < 100) { fundBanner.innerHTML = banner("error", "Minimum amount is 100 cents ($1.00)."); return; }
          fundBtn.disabled = true;
          fundBtn.textContent = "Funding\u2026";
          fundBanner.innerHTML = "";
          try {
            await fundProjectWallet(projectId, amount);
            fundBanner.innerHTML = banner("success", `Wallet funded: $${(amount / 100).toFixed(2)} added to project.`);
            fundProjectId.value = "";
            fundAmount.value    = "";
          } catch (err) {
            fundBanner.innerHTML = banner("error", `Fund failed: ${err instanceof Error ? err.message : "Unknown error"}`);
          } finally {
            fundBtn.disabled    = false;
            fundBtn.textContent = "Fund";
          }
        };
        fundBtn.addEventListener("click", handler);
        teardowns.push(() => fundBtn.removeEventListener("click", handler));
      }
    }
  }

  // GitHub connect
  const connectGhBtn = container.querySelector("#connect-github-btn") as HTMLButtonElement | null;
  if (connectGhBtn) {
    const handler = () => initiateGitHubOAuth();
    connectGhBtn.addEventListener("click", handler);
    teardowns.push(() => connectGhBtn.removeEventListener("click", handler));
  }

  // GitHub disconnect
  const disconnectGhBtn = container.querySelector("#disconnect-github-btn") as HTMLButtonElement | null;
  if (disconnectGhBtn) {
    const handler = async () => {
      const ghBanner = container.querySelector("#settings-github-banner") as HTMLElement;
      disconnectGhBtn.disabled = true;
      disconnectGhBtn.textContent = "Disconnecting\u2026";
      try {
        await supabase
          .from("profiles")
          .update({ github_token: null, github_username: null } as Record<string, unknown>)
          .eq("id", user.id);
        ghBanner.innerHTML = banner("success", "GitHub disconnected. Reload to reconnect.");
        disconnectGhBtn.disabled = true;
        disconnectGhBtn.textContent = "Disconnected";
      } catch (err) {
        ghBanner.innerHTML = banner("error", `Disconnect failed: ${err instanceof Error ? err.message : "Unknown error"}`);
        disconnectGhBtn.disabled = false;
        disconnectGhBtn.textContent = "Disconnect";
      }
    };
    disconnectGhBtn.addEventListener("click", handler);
    teardowns.push(() => disconnectGhBtn.removeEventListener("click", handler));
  }

  return () => teardowns.forEach((fn) => fn());
}

// ---------------------------------------------------------------------------
// GitHub OAuth callback — mounted at /github/callback in main.ts
// ---------------------------------------------------------------------------

export async function mountGitHubCallback(_container: HTMLElement): Promise<() => void> {
  const params = new URLSearchParams(window.location.search);
  const code   = params.get("code");
  const error  = params.get("error");

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
