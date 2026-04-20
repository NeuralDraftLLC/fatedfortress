/**
 * vite-env.d.ts — Ambient type declarations for Vite-injected build-time constants.
 * These values are injected by Vite's define option in vite.config.ts so they are
 * available as global strings at runtime but unknown to the TypeScript compiler.
 */

/** Injected by Vite define — the canonical origin of the web app (https://fatedfortress.com in prod). */
declare const __FF_ORIGIN__: string;

/** Injected by Vite define — the canonical origin of the keys worker (https://keys.fatedfortress.com in prod). */
declare const __WORKER_ORIGIN__: string;

/** Injected by Vite define — the relay registry URL (https://relay.fatedfortress.com in prod). */
declare const __RELAY_REGISTRY_URL__: string;
