/**
 * worker.ts — Fortress Worker iframe entry (bundled as worker.html on keys.* origin).
 *
 * Message gate: ignore any postMessage whose origin is not FF_ORIGIN (the web app).
 * TERMINATE — full teardownSession() (keys + budget). TEARDOWN (router) — budget only; keys kept.
 */

const FF_ORIGIN = typeof __FF_ORIGIN__ !== "undefined"
  ? __FF_ORIGIN__
  : "https://fatedfortress.com";
import { teardownKeystore } from "./keystore.js";
import { teardownLiquidity } from "./liquidity.js";
import { abortAllGenerations } from "./generate.js";
import { dispatchMessage, send, sendError, type InboundMessage } from "./router.js";

async function teardownSession(): Promise<void> {
  abortAllGenerations();
  teardownKeystore();
  await teardownLiquidity();
}

window.addEventListener("message", async (event: MessageEvent) => {
  if (event.origin !== FF_ORIGIN) return;

  const msg = event.data as InboundMessage;
  if (!msg || typeof msg.type !== "string") return;

  if (msg.type === "TERMINATE") {
    await teardownSession();
    send({ type: "OK", requestId: "__terminate__", payload: { terminated: true } });
    return;
  }

  const requestId = (msg as any).requestId as string | undefined;
  if (!requestId || typeof requestId !== "string") return;

  try {
    await dispatchMessage(msg as any);
  } catch (err) {
    sendError(requestId, err);
  }
});

window.addEventListener("beforeunload", () => void teardownSession()); // tab kill / hard nav — SPA uses TEARDOWN too
window.addEventListener("unload", () => void teardownSession());
window.addEventListener("pagehide", (e: PageTransitionEvent) => {
  if (!e.persisted) void teardownSession();
});
