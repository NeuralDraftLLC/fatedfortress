/**
 * vite-env.d.ts — Ambient declarations for Vite-injected build-time constants and Vite client API.
 * These values are injected by Vite's define option so they are global at runtime but
 * unknown to TypeScript without this declaration file.
 */

/** Injected by Vite define — relay WebSocket origin. */
declare const __RELAY_ORIGIN__: string;

/** Injected by Vite define — relay HTTP origin for REST calls (TURN creds). */
declare const __RELAY_HTTP_ORIGIN__: string;

/** Injected by Vite define — keystore worker iframe origin. */
declare const __WORKER_ORIGIN__: string;

/** Injected by Vite define — the canonical web app origin. */
declare const __FF_ORIGIN__: string;

/** Injected by Vite define — Sentry DSN for Zone 1 (SPA). */
declare const __SENTRY_DSN_WEB__: string;

/** Injected by Vite define — release tag for Sentry. */
declare const __APP_VERSION__: string;

/**
 * Augment Vite's ImportMetaEnv to include our custom VITE_ env vars so that
 * import.meta.env.VITE_HERENOW_CLIENT_ID etc. type-check without casts.
 */
interface ImportMetaEnv {
  readonly VITE_HERENOW_CLIENT_ID?: string;
  /** Supabase project URL */
  readonly VITE_SUPABASE_URL: string;
  /** Supabase anon (public) key */
  readonly VITE_SUPABASE_ANON_KEY: string;
  /** GitHub OAuth App client ID */
  readonly VITE_GITHUB_CLIENT_ID?: string;
  /** R2 public bucket base URL (same as server R2_PUBLIC_BASE_URL) */
  readonly VITE_R2_PUBLIC_URL?: string;
}
