/**
 * apps/web/src/pages/login.ts — Supabase Auth login / signup page.
 *
 * URL params accepted (all optional, all composable):
 *
 *   ?mode=signup          → show "Create account" framing
 *   ?role=host            → host-first copy + post-auth redirect to /create
 *   ?role=contributor     → contributor copy + post-auth redirect to /tasks
 *   ?intent=post          → legacy alias for role=host
 *   ?intent=work          → legacy alias for role=contributor
 *
 * Persisted through magic-link round-trip via sessionStorage:
 *   ff_login_role         → "host" | "contributor" | null
 *   ff_login_intent       → "post" | "work" | null (legacy)
 *
 * On sign-in (session detected at mount or on callback):
 *   1. upsertProfileRole(role) patches profiles.role if still null
 *   2. Redirect → /create (host) or /tasks (contributor)
 */

import { getSupabase, signInWithEmailMagicLink, signInWithGoogle, signInWithPassword, upsertProfileRole } from "../auth/index.js";

const showE2EPassword = import.meta.env.VITE_E2E_PASSWORD_LOGIN === "true";

// ─── Session-storage keys ────────────────────────────────────────────────────
const ROLE_KEY   = "ff_login_role";
const INTENT_KEY = "ff_login_intent";

// ─── Param parsing ───────────────────────────────────────────────────────────

function parseParams(): { mode: string; role: "host" | "contributor" | null } {
  const p    = new URLSearchParams(window.location.search);
  const mode = p.get("mode") ?? "";

  // ?role= takes precedence; fall back to legacy ?intent=
  let role: "host" | "contributor" | null = null;
  const rawRole   = p.get("role");
  const rawIntent = p.get("intent");

  if (rawRole === "host" || rawIntent === "post")           role = "host";
  else if (rawRole === "contributor" || rawIntent === "work") role = "contributor";

  return { mode, role };
}

// ─── Persist / pop role + intent through magic-link round-trip ───────────────

function persistParams(role: "host" | "contributor" | null, intent: string | null) {
  if (role)   sessionStorage.setItem(ROLE_KEY, role);
  if (intent) sessionStorage.setItem(INTENT_KEY, intent);
}

export function popRole(): "host" | "contributor" | null {
  const v = sessionStorage.getItem(ROLE_KEY) as "host" | "contributor" | null;
  sessionStorage.removeItem(ROLE_KEY);
  return v;
}

function popIntent(): string | null {
  const v = sessionStorage.getItem(INTENT_KEY);
  sessionStorage.removeItem(INTENT_KEY);
  return v;
}

// ─── Redirect resolution ─────────────────────────────────────────────────────

function roleToRedirect(role: "host" | "contributor" | null): string {
  return role === "host" ? "/create" : "/tasks";
}

// ─── Apply role + redirect after a successful sign-in ────────────────────────

async function applyRoleAndRedirect(role: "host" | "contributor" | null): Promise<void> {
  if (role) await upsertProfileRole(role).catch(() => {/* non-fatal */});
  window.location.href = roleToRedirect(role);
}

// ─── Page mount ──────────────────────────────────────────────────────────────

export async function mountLogin(container: HTMLElement): Promise<() => void> {
  const supabase = getSupabase();
  const { data: { session } } = await supabase.auth.getSession();

  // Already logged in — apply any saved role and redirect
  if (session?.user) {
    const savedRole = popRole();
    // consume legacy intent key too
    popIntent();
    await applyRoleAndRedirect(savedRole);
    return () => {};
  }

  // Parse current URL params
  const { mode, role } = parseParams();
  const isSignup = mode === "signup";

  // Persist role + legacy intent through magic-link round-trip
  const legacyIntent = role === "host" ? "post" : role === "contributor" ? "work" : null;
  persistParams(role, legacyIntent);

  // ─── Copy resolved from role ─────────────────────────────────────────────
  const tagline = role === "host"
    ? "Post a project. AI scopes it. Specialists deliver."
    : role === "contributor"
    ? "Browse funded tasks. Claim one. Get paid automatically."
    : "The structured task marketplace for serious builders.";

  const intentLabel = role === "host"
    ? "post a project"
    : role === "contributor"
    ? "find work"
    : "get started";

  const ctaLabel = isSignup ? "Create account" : "Sign in";
  const switchHref = isSignup
    ? `/login${role ? `?role=${role}` : ""}`
    : `/login?mode=signup${role ? `&role=${role}` : ""}`;
  const switchLabel = isSignup
    ? "Already have an account? <a href=\"/login\">Sign in</a>"
    : "New here? <a href=\"/login?mode=signup\">Create account</a>";

  // ─── Render ──────────────────────────────────────────────────────────────
  container.innerHTML = `
    <div class="login-page">
      <div class="login-card">

        <div class="login-logo">
          <a href="/" class="login-brand" style="text-decoration:none;color:inherit">FatedFortress</a>
          <p class="login-tagline">${tagline}</p>
        </div>

        ${role ? `<div class="login-role-badge login-role-badge--${role}">
          ${role === "host" ? "⚡ Posting as Host" : "🛠 Joining as Contributor"}
        </div>` : ""}

        <div class="login-divider"><span>${ctaLabel} to ${intentLabel}</span></div>

        <form class="login-form" id="magic-form">
          <div class="form-field">
            <label for="email">Email</label>
            <input type="email" id="email" required placeholder="you@example.com" autocomplete="email" />
          </div>
          <button type="submit" class="ff-btn" id="magic-btn" style="width:100%;margin-top:8px">
            Send magic link
          </button>
          <p class="login-hint">No password needed — check your inbox for a secure link.</p>
        </form>

        <div class="login-divider"><span>or</span></div>

        <button class="ff-btn" id="google-btn" style="width:100%;background:var(--ff-paper);color:var(--ff-ink);border:1px solid var(--ff-ink)">
          Continue with Google
        </button>

        ${showE2EPassword ? `
        <div class="login-divider"><span>E2E / password</span></div>
        <form class="login-form" id="e2e-password-form" data-testid="e2e-password-form">
          <div class="form-field">
            <label for="e2e-email">Email</label>
            <input type="email" id="e2e-email" data-testid="e2e-email" autocomplete="email" />
          </div>
          <div class="form-field">
            <label for="e2e-password">Password</label>
            <input type="password" id="e2e-password" data-testid="e2e-password" autocomplete="current-password" />
          </div>
          <button type="submit" class="ff-btn" id="e2e-signin-btn" data-testid="e2e-signin-btn" style="width:100%;margin-top:8px">
            Sign in with password
          </button>
          <p class="login-hint">Only when VITE_E2E_PASSWORD_LOGIN=true.</p>
        </form>
        ` : ""}

        <p class="login-switch" style="text-align:center;font-size:12px;margin-top:16px;font-family:var(--ff-font-mono);color:var(--ff-muted)">
          ${switchLabel}
        </p>

        <p class="login-legal">
          By signing in, you agree to our
          <a href="/terms" target="_blank" rel="noopener">Terms of Service</a> and
          <a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a>.
        </p>
      </div>
    </div>
  `;

  // ─── Magic link submit ────────────────────────────────────────────────────
  container.querySelector("#magic-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = (container.querySelector("#email") as HTMLInputElement).value.trim();
    const btn   = container.querySelector("#magic-btn") as HTMLButtonElement;
    btn.disabled    = true;
    btn.textContent = "Sending...";
    try {
      await signInWithEmailMagicLink(email);
      container.querySelector(".login-form")!.innerHTML = `
        <div style="text-align:center;padding:16px 0;font-family:var(--ff-font-mono);line-height:1.7">
          <div style="font-size:20px;margin-bottom:8px">📬</div>
          <strong>Check your email.</strong><br/>
          <span style="font-size:12px;color:var(--ff-muted)">
            Click the link to ${intentLabel}. Tab stays open.
          </span>
        </div>
      `;
    } catch (err: any) {
      btn.disabled    = false;
      btn.textContent = "Send magic link";
      alert(`Failed to send: ${err.message}`);
    }
  });

  // ─── E2E password submit ──────────────────────────────────────────────────
  if (showE2EPassword) {
    container.querySelector("#e2e-password-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email    = (container.querySelector("#e2e-email") as HTMLInputElement).value.trim();
      const password = (container.querySelector("#e2e-password") as HTMLInputElement).value;
      const btn      = container.querySelector("#e2e-signin-btn") as HTMLButtonElement;
      btn.disabled = true;
      try {
        await signInWithPassword(email, password);
        const savedRole = popRole(); popIntent();
        await applyRoleAndRedirect(savedRole);
      } catch (err: unknown) {
        btn.disabled = false;
        alert(`Sign-in failed: ${err instanceof Error ? err.message : "Unknown error"}`);
      }
    });
  }

  // ─── Google OAuth ─────────────────────────────────────────────────────────
  // Role is already in sessionStorage — picked up by popRole() when the
  // OAuth redirect returns and mountLogin() re-runs (session detected above).
  container.querySelector("#google-btn")?.addEventListener("click", async () => {
    const btn = container.querySelector("#google-btn") as HTMLButtonElement;
    btn.disabled    = true;
    btn.textContent = "Redirecting...";
    try {
      await signInWithGoogle();
    } catch (err: any) {
      btn.disabled    = false;
      btn.textContent = "Continue with Google";
      alert(`Google sign-in failed: ${err.message}`);
    }
  });

  return () => {};
}
