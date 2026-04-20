/**
 * apps/worker/vite.config.ts — Vite config for the Fortress Worker.
 *
 * Key settings:
 *   - Build as IIFE (immediately invoked function expression)
 *     — worker runs in a sandboxed iframe, not via importScripts
 *   - Manual chunks: isolate hash-wasm in its own chunk (required for WASM)
 *   - No minification of the entry chunk (preserves SRI hash stability)
 *   - Output: dist/ with index.html + assets/
 *   - define: inject FF_ORIGIN and WORKER_ORIGIN from env
 *
 * The hash-wasm import is pinned to a specific version+hash in package.json.
 * Vite's rollupOptions.input determines chunk splitting for reproducibility.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@fatedfortress/protocol": path.resolve(__dirname, "../../packages/protocol/src/index.ts"),
    },
  },
  define: {
    __FF_ORIGIN__: JSON.stringify(process.env.VITE_FF_ORIGIN ?? "https://fatedfortress.com"),
    __WORKER_ORIGIN__: JSON.stringify(process.env.VITE_WORKER_ORIGIN ?? "https://keys.fatedfortress.com"),
  },
});
