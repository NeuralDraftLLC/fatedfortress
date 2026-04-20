/**
 * vite-env.d.ts — Ambient declarations for Vite-injected build-time constants and Vite client API.
 * These values are injected by Vite's define option so they are global at runtime but
 * unknown to TypeScript without this declaration file.
 */

/** Injected by Vite define — relay WebSocket origin. */
declare const __RELAY_ORIGIN__: string;

/** Injected by Vite define — keystore worker iframe origin. */
declare const __WORKER_ORIGIN__: string;

/** Injected by Vite define — the canonical web app origin. */
declare const __FF_ORIGIN__: string;

/**
 * Augment Vite's ImportMetaEnv to include our custom VITE_ env vars so that
 * import.meta.env.VITE_HERENOW_CLIENT_ID etc. type-check without casts.
 */
interface ImportMetaEnv {
  readonly VITE_HERENOW_CLIENT_ID?: string;
}
