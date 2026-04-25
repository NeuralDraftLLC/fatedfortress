/**
 * apps/web/src/pages/login.ts — Supabase Auth login page.
 *
 * Reads ?intent from the URL to personalise the post-auth redirect:
 *   ?intent=post  →  /create   (host flow)
 *   ?intent=work  →  /tasks    (contributor flow)
 *   (default)     →  /tasks
 */

import { getSupabase } from "../auth/index.js";
import {
  signInWithEmailMagicLink,
  signInWithGoogle,
  signInWithPassword,
} from "../auth/index.js";

const showE2EPassword = import.meta.env.VITE_E2E_PASSWORD_LOGIN === "true";

/** Derive the post-auth destination from ?intent, falling back to /tasks. */
function resolveRedirect(): string {
  const params = new URLSearchParams(window.location.search);
  const intent = params.get("intent");
  if (intent === "post") return "/create";
  if (intent === "work") return "/tasks";
  return "/tasks";
}

/** Persist intent through magic-link round-trip via localStorage key. */
const INTENT_KEY = "ff_login_intent";

function saveIntent() {
  const params = new URLSearchParams(window.location.search);
  const intent = params.get("intent");
  if (intent) sessionStorage.setItem(INTENT_KEY, intent);
}

function popIntent(): string {
  const intent = sessionStorage.getItem(INTENT_KEY);
  sessionStorage.removeItem(INTENT_KEY);
  if (intent === "post") return "/create";
  if (intent === "work") return "/tasks";
  return "/tasks";
}

export async function mountLogin(container: HTMLElement): Promise<() => void> {
  const supabase = getSupabase();
  const { data: { session } } = await supabase.auth.getSession();

  // Already logged in — honour any saved intent from a previous magic-link send
  if (session?.user) {
    window.location.href = popIntent();
    return () => {};
  }

  // Persist intent so magic-link callback can pick it up
  saveIntent();

  const redirect = resolveRedirect();
  const intentLabel = redirect === "/create" ? "post a job" : "find work";
  const tagline = redirect === "/create"
    ? "Post a job. AI scopes it. Specialists deliver."
    : "Browse scoped tasks. Claim. Get paid automatically.";

  container.innerHTML = `
    <div class="login-page">
      <div class="login-card">
        <div class="login-logo">
          <a href="/" class="login-brand" style="text-decoration:none;color:inherit">FatedFortress</a>
          <p class="login-tagline">${tagline}</p>
        </div>

        <div class="login-divider"><span>Sign in to ${intentLabel}</span></div>

        <form class="login-form" id="magic-form">
          <div class="form-field">
            <label for="email">Email</label>
            <input type="email" id="email" required placeholder="you@example.com" autocomplete="email" />
          </div>
          <button type="submit" class="btn btn--primary btn--lg btn--full" id="magic-btn">
            Send magic link
          </button>
          <p class="login-hint">No password needed — you’ll get an email with a secure link.</p>
        </form>

        <div class="login-divider"><span>or</span></div>

        <button class="btn btn--secondary btn--lg btn--full" id="google-btn">
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
          <button type="submit" class="btn btn--primary btn--lg btn--full" id="e2e-signin-btn" data-testid="e2e-signin-btn">
            Sign in with password
          </button>
          <p class="login-hint">Only when VITE_E2E_PASSWORD_LOGIN=true.</p>
        </form>
        ` : ""}

        <p class="login-legal">
          By signing in, you agree to our
          <a href="/terms" target="_blank" rel="noopener">Terms of Service</a> and
          <a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a>.
        </p>
      </div>
    </div>
  `;

  // Magic link — intent already saved to sessionStorage above
  container.querySelector("#magic-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = (container.querySelector("#email") as HTMLInputElement).value.trim();
    const btn = container.querySelector("#magic-btn") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "Sending...";
    try {
      await signInWithEmailMagicLink(email);
      container.querySelector(".login-form")!.innerHTML = `
        <p style="text-align:center;line-height:1.6">
          Check your email for a magic link.<br>
          <span style="font-size:.875rem;opacity:.6">You’ll be taken straight to ${intentLabel}.</span>
        </p>
      `;
    } catch (err: any) {
      btn.disabled = false;
      btn.textContent = "Send magic link";
      alert(`Failed to send: ${err.message}`);
    }
  });

  if (showE2EPassword) {
    container.querySelector("#e2e-password-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = (container.querySelector("#e2e-email") as HTMLInputElement).value.trim();
      const password = (container.querySelector("#e2e-password") as HTMLInputElement).value;
      const btn = container.querySelector("#e2e-signin-btn") as HTMLButtonElement;
      btn.disabled = true;
      try {
        await signInWithPassword(email, password);
        window.location.href = popIntent();
      } catch (err: unknown) {
        btn.disabled = false;
        alert(`Sign-in failed: ${err instanceof Error ? err.message : "Unknown error"}`);
      }
    });
  }

  // Google OAuth — intent persisted in sessionStorage, picked up on callback
  container.querySelector("#google-btn")?.addEventListener("click", async () => {
    const btn = container.querySelector("#google-btn") as HTMLButtonElement;
    btn.disabled = true;
    try {
      await signInWithGoogle();
      // signInWithGoogle redirects away; popIntent() fires on return in the
      // session-check at the top of mountLogin.
    } catch (err: any) {
      btn.disabled = false;
      alert(`Google sign-in failed: ${err.message}`);
    }
  });

  return () => {};
}
