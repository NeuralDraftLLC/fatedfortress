/**
 * apps/web/src/auth/middleware.ts — Route protection middleware.
 *
 * Redirects unauthenticated users to /login when accessing protected routes.
 * Call requireAuth() at the top of each protected page mount function.
 */

import { getSupabase } from "./index.js";

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
  if (isLoggedIn && isAuthPage(currentPath)) {
    return "/";
  }
  if (!isLoggedIn && isProtectedRoute(currentPath)) {
    return "/login";
  }
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
    window.location.href = "/login";
  }
}
