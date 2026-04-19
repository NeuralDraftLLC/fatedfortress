/**
 * worker.ts — Fortress Worker main entry point.
 *
 * Loaded cross-origin at keys.fatedfortress.com as a sandboxed iframe (window context).
 * Communicates with the FF main frame exclusively via postMessage.
 */

import { FF_ORIGIN } from "@fatedfortress/protocol";
import { teardownKeystore } from "./keystore.js";
import { teardownLiquidity } from "./liquidity.js";
import { abortAllGenerations } from "./generate.js";
import { dispatchMessage, send, sendError, type InboundMessage } from "./router.js";

function teardownSession(): void {
  abortAllGenerations();
  teardownKeystore();
  teardownLiquidity();
}

window.addEventListener("message", async (event: MessageEvent) => {
  if (event.origin !== FF_ORIGIN) return;

  const msg = event.data as InboundMessage;
  if (!msg || typeof msg.type !== "string") return;

  if (msg.type === "TERMINATE") {
    teardownSession();
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

window.addEventListener("beforeunload", teardownSession);
window.addEventListener("unload", teardownSession);
window.addEventListener("pagehide", (e: PageTransitionEvent) => {
  if (!e.persisted) teardownSession();
});
