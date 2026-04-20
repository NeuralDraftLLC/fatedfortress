/**
 * apps/web/vite.config.ts — Vite config for the FatedFortress web SPA.
 *
 * Phase 5 L4 — VITE_RELAY_ORIGIN / VITE_WORKER_ORIGIN / VITE_FF_ORIGIN via loadEnv + define.
 * Phase 5 L3 — Meta CSP uses script-src 'self' so Vite-hashed /assets/*.js loads; build-time
 * nonce plugins break hashed entry scripts — per-request nonces belong on the edge worker.
 * Protocol alias; manualChunks for yjs + protocol.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  const relayOrigin =
    env.VITE_RELAY_ORIGIN ?? "wss://relay.fatedfortress.com";
  const workerOrigin =
    env.VITE_WORKER_ORIGIN ?? "https://keys.fatedfortress.com";
  const ffOrigin =
    env.VITE_FF_ORIGIN ?? "https://fatedfortress.com";

  return {
    resolve: {
      alias: {
        "@fatedfortress/protocol": path.resolve(
          __dirname,
          "../../packages/protocol/src/index.ts"
        ),
      },
    },
    define: {
      __FF_ORIGIN__: JSON.stringify(ffOrigin),
      __WORKER_ORIGIN__: JSON.stringify(workerOrigin),
      __RELAY_ORIGIN__: JSON.stringify(relayOrigin),
    },
    build: {
      target: "es2022",
      sourcemap: true,
      rollupOptions: {
        output: {
          manualChunks(id: string) {
            if (id.includes(`${path.sep}yjs${path.sep}`) || id.includes("/yjs/")) {
              return "yjs";
            }
            if (id.includes("packages/protocol") || id.includes("@fatedfortress/protocol")) {
              return "protocol";
            }
          },
        },
      },
    },
    server: {
      port: 5173,
      strictPort: true,
    },
  };
});
