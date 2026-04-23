/**
 * apps/web/src/pages/login.ts — Supabase Auth login page.
 */

import { getSupabase } from "../auth/index.js";
import {
  signInWithEmailMagicLink,
  signInWithGoogle,
  signInWithPassword,
} from "../auth/index.js";

const showE2EPassword = import.meta.env.VITE_E2E_PASSWORD_LOGIN === "true";

export async function mountLogin(container: HTMLElement): Promise<() => void> {
  const supabase = getSupabase();
  const { data: { session } } = await supabase.auth.getSession();

  // Already logged in → redirect
  if (session?.user) {
    window.location.href = "/reviews";
    return () => {};
  }

  container.innerHTML = `
    <div class="login-page">
      <div class="login-card">
        <div class="login-logo">
          <h1 class="login-brand">FatedFortress</h1>
          <p class="login-tagline">Review-centered task marketplace</p>
        </div>

        <div class="login-divider"><span>Sign in</span></div>

        <form class="login-form" id="magic-form">
          <div class="form-field">
            <label for="email">Email</label>
            <input type="email" id="email" required placeholder="you@example.com" autocomplete="email" />
          </div>
          <button type="submit" class="btn btn--primary btn--lg btn--full" id="magic-btn">
            Send magic link
          </button>
          <p class="login-hint">No password needed — you'll get an email with a secure link.</p>
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
          <p class="login-hint">Only when VITE_E2E_PASSWORD_LOGIN=true. Enable email+password in Supabase Auth.</p>
        </form>
        ` : ""}

        <p class="login-legal">
          By signing in, you agree to our Terms of Service and Privacy Policy.
        </p>
      </div>
    </div>
  `;

  // Magic link
  container.querySelector("#magic-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = (container.querySelector("#email") as HTMLInputElement).value.trim();
    const btn = container.querySelector("#magic-btn") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "Sending...";
    try {
      await signInWithEmailMagicLink(email);
      container.querySelector(".login-form")?.setHTML("Check your email for a magic link!");
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
        window.location.href = "/reviews";
      } catch (err: unknown) {
        btn.disabled = false;
        alert(`Sign-in failed: ${err instanceof Error ? err.message : "Unknown error"}`);
      }
    });
  }

  // Google OAuth
  container.querySelector("#google-btn")?.addEventListener("click", async () => {
    const btn = container.querySelector("#google-btn") as HTMLButtonElement;
    btn.disabled = true;
    try {
      await signInWithGoogle();
    } catch (err: any) {
      btn.disabled = false;
      alert(`Google sign-in failed: ${err.message}`);
    }
  });

  return () => {};
}
