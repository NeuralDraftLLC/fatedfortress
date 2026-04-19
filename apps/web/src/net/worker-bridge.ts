/**
 * net/worker-bridge.ts — Main thread ↔ Fortress Worker communication.
 */

import { type RoomId, FFError } from "@fatedfortress/protocol";

const WORKER_ORIGIN = typeof __WORKER_ORIGIN__ !== "undefined"
  ? __WORKER_ORIGIN__
  : "https://keys.fatedfortress.com";

export interface FuelGaugeState {
  roomId: string;
  participants: Array<{
    pubkey: string;
    fraction: number;
    consumed: number;
    quota: number;
  }>;
}

const REQUEST_TIMEOUT_MS = 30_000;

export class WorkerBridge {
  private static instance: WorkerBridge;
  private workerIframe: HTMLIFrameElement | null = null;
  private pendingRequests = new Map<string, (payload: any) => void>();
  private streamingRequests = new Map<string, {
    onChunk?: (chunk: string) => void;
    onDone?: (outputHash: string) => void;
    onError?: (code: string, message: string) => void;
    resolve: (payload: any) => void;
  }>();

  public requestWithTimeout<T>(
    requestId: string,
    postMessage: () => void,
    timeoutMs = REQUEST_TIMEOUT_MS
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new FFError("REQUEST_TIMEOUT", `Request ${requestId} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(requestId, (value: any) => {
        clearTimeout(timeoutId);
        this.pendingRequests.delete(requestId);
        resolve(value);
      });

      postMessage();
    });
  }

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
      this.workerIframe.title = "Fortress keystore worker";
      this.workerIframe.className = "ff-keystore-iframe";
      const slot =
        document.getElementById("ff-keystore-slot") ?? document.body;
      slot.appendChild(this.workerIframe);
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

    // Handle standard OK/FUEL
    if (msg.type === "OK") {
      const resolve = this.pendingRequests.get(msg.requestId);
      if (resolve) {
        resolve(msg.payload);
        this.pendingRequests.delete(msg.requestId);
      }
    } else if (msg.type === "FUEL") {
      // Dispatch custom event for FuelGauge components to subscribe independently
      window.dispatchEvent(new CustomEvent("ff:fuel", { detail: msg.state }));
    }
    // Handle Streaming Cases
    else if (msg.type === "CHUNK") {
      const req = this.streamingRequests.get(msg.requestId);
      req?.onChunk?.(msg.chunk);
    } else if (msg.type === "DONE") {
      const req = this.streamingRequests.get(msg.requestId);
      req?.onDone?.(msg.outputHash);
      if (req?.resolve) req.resolve(msg.outputHash);
      this.streamingRequests.delete(msg.requestId);
    } else if (msg.type === "ERROR") {
      const streamReq = this.streamingRequests.get(msg.requestId);
      if (streamReq) {
        streamReq.onError?.(msg.code, msg.message);
        this.streamingRequests.delete(msg.requestId);
      } else {
        const pending = this.pendingRequests.get(msg.requestId);
        if (pending) {
          pending(Promise.reject(new FFError(msg.code, msg.message)));
          this.pendingRequests.delete(msg.requestId);
        } else {
          console.error(`[WorkerBridge] Unhandled error: [${msg.code}] ${msg.message}`);
        }
      }
    }
  }

  public async storeKey(provider: string, key: string): Promise<void> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    this.pendingRequests.set(requestId, resolve);
    this.workerIframe?.contentWindow?.postMessage(
      { type: "STORE_KEY", provider, key, requestId },
      WORKER_ORIGIN
    );
  });
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

  /**
   * Send a GENERATE request with streaming callbacks and AbortSignal support.
   */
  public requestGenerate(
    opts: {
      provider: string;
      model: string;
      prompt: string;
      systemPrompt: string;
      isSpectator?: boolean;
      signal?: AbortSignal;
    },
    callbacks: {
      onChunk?: (chunk: string) => void;
      onDone?: (outputHash: string) => void;
      onError?: (code: string, message: string) => void;
    }
  ): Promise<string> {
    const requestId = crypto.randomUUID();

    return new Promise((resolve) => {
      this.streamingRequests.set(requestId, { ...callbacks, resolve });

      const doAbort = () => {
        this.streamingRequests.delete(requestId);
        this.workerIframe?.contentWindow?.postMessage(
          { type: "ABORT_GENERATE", requestId },
          WORKER_ORIGIN
        );
      };

      if (opts.signal) {
        if (opts.signal.aborted) {
          doAbort();
          resolve("");
          return;
        }
        opts.signal.addEventListener("abort", doAbort, { once: true });
      }

      this.workerIframe?.contentWindow?.postMessage({
        type: "GENERATE",
        provider: opts.provider,
        model: opts.model,
        prompt: opts.prompt,
        systemPrompt: opts.systemPrompt,
        isSpectator: opts.isSpectator ?? false,
        requestId,
      }, WORKER_ORIGIN);
    });
  }
}
