/**
 * net/worker-bridge.ts — Main thread ↔ Fortress Worker communication.
 *
 * Responsibilities:
 *   - Create and mount the sandboxed Fortress Worker iframe
 *   - Expose typed postMessage API for STORE_KEY, GENERATE, etc.
 *   - Route inbound messages (CHUNK, DONE, ERROR, OK, FUEL) to callers
 *   - Handle worker crashes / TERMINATE and surface errors to UI
 *
 * Security:
 *   - Worker loaded from keys.fatedfortress.com (separate origin)
 *   - Worker origin validated on every inbound message
 *   - No key material ever sent to main thread
 *
 * The WorkerBridge class is a singleton — one worker per tab.
 */

import { WORKER_ORIGIN, type RoomId } from "@fatedfortress/protocol";

export interface FuelGaugeState {
  roomId: string;
  participants: Array<{
    pubkey: string;
    fraction: number;
    consumed: number;
    quota: number;
  }>;
}

export class WorkerBridge {
  private static instance: WorkerBridge;
  private workerIframe: HTMLIFrameElement | null = null;
  private pendingRequests = new Map<string, (payload: any) => void>();

  private constructor() {
    this.mountWorker();
    window.addEventListener("message", this.handleMessage.bind(this));
  }

  public static getInstance(): WorkerBridge {
    if (!WorkerBridge.instance) {
      WorkerBridge.instance = new WorkerBridge();
    }
    return WorkerBridge.instance;
  }

  private mountWorker() {
    if (typeof document === "undefined") return;

    const setupIframe = () => {
      this.workerIframe = document.createElement("iframe");
      this.workerIframe.src = `${WORKER_ORIGIN}/worker.html`;
      this.workerIframe.style.display = "none";
      document.body.appendChild(this.workerIframe);
    };

    if (document.body) {
      setupIframe();
    } else {
      window.addEventListener("DOMContentLoaded", setupIframe);
    }
  }

  private handleMessage(event: MessageEvent) {
    if (event.origin !== WORKER_ORIGIN) return;

    const msg = event.data;
    if (!msg || !msg.requestId) return;

    if (msg.type === "FUEL") {
      const resolve = this.pendingRequests.get(msg.requestId);
      if (resolve) {
        resolve(msg.state);
        this.pendingRequests.delete(msg.requestId);
      }
    } else if (msg.type === "OK") {
      const resolve = this.pendingRequests.get(msg.requestId);
      if (resolve) {
        resolve(msg.payload);
        this.pendingRequests.delete(msg.requestId);
      }
    }
    // TODO: Handle other message types (CHUNK, DONE, ERROR)
  }

  public async requestFuelGauge(roomId: RoomId): Promise<FuelGaugeState> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      this.pendingRequests.set(requestId, resolve);
      this.workerIframe?.contentWindow?.postMessage(
        { type: "FUEL_GAUGE", roomId, requestId },
        WORKER_ORIGIN
      );
    });
  }
}
