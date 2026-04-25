/**
 * apps/web/src/auth/middleware.ts — Route protection + auth callback handler.
 *
 * Redirects unauthenticated users to /login when accessing protected routes.
 * Call requireAuth() at the top of each protected page mount function.
 *
 * handleAuthCallback() must be called from the /auth/callback route mount.
 * It pops the persisted role + intent from sessionStorage, patches the
 * profile, then redirects to the correct post-auth destination.
 */

import { getSupabase, upsertProfileRole } from "./index.js";
import { popRole } from "../pages/login.js";

// Protected route prefixes (all routes under these paths require auth)
const PROTECTED_PREFIXES = [
  "/create",
  "/tasks",
  "/submit",
  "/reviews",
  "/project",
  "/profile",
  "/settings",
];

// Auth pages (should redirect away if already logged in)
const AUTH_PAGES = ["/login", "/auth/callback"];

export function isProtectedRoute(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function isAuthPage(pathname: string): boolean {
  return AUTH_PAGES.some((page) => pathname === page || pathname.startsWith(page));
}

/**
 * Call at app init to handle redirect logic based on current auth state.
 * Returns the path to redirect to, or null if no redirect needed.
 */
export function getRedirectPath(isLoggedIn: boolean, currentPath: string): string | null {
  if (isLoggedIn && isAuthPage(currentPath)) return "/";
  if (!isLoggedIn && isProtectedRoute(currentPath)) return "/login";
  return null;
}

/** Returns true if there is an authenticated session */
export async function isAuthenticated(): Promise<boolean> {
  const { data: { session } } = await getSupabase().auth.getSession();
  return !!session;
}

/** Redirect to /login if not authenticated. Call at top of protected page mounts. */
export async function requireAuth(): Promise<void> {
  if (!(await isAuthenticated())) {
    // Preserve the current path as a ?next= param so the user returns after login
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `/login?next=${next}`;
  }
}

/**
 * handleAuthCallback — mount this at /auth/callback.
 *
 * Supabase redirects here after magic-link or OAuth completes.
 * Responsible for:
 *   1. Waiting for the session to be established (Supabase handles token exchange)
 *   2. Popping the persisted role from sessionStorage
 *   3. Writing role to profiles (no-op if already set)
 *   4. Redirecting to /create (host) or /tasks (contributor / default)
 */
export async function handleAuthCallback(): Promise<void> {
  const supabase = getSupabase();

  // Give Supabase time to exchange the token from the URL hash/query
  // onAuthStateChange fires once the session is ready
  return new Promise((resolve) => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        if (event === "SIGNED_IN" && session) {
          subscription.unsubscribe();

          const role = popRole();
          if (role) {
            await upsertProfileRole(role).catch(() => {/* non-fatal */});
          }

          const destination = role === "host" ? "/create" : "/tasks";
          window.location.replace(destination);
          resolve();
        }

        // Timeout fallback — if SIGNED_IN never fires (e.g. expired link)
        setTimeout(() => {
          subscription.unsubscribe();
          window.location.replace("/login");
          resolve();
        }, 8_000);
      }
    );
  });
}
