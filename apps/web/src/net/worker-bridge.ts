/**
 * apps/web/src/net/worker-bridge.ts — Main thread ↔ Fortress Worker (`keys…/worker.html`).
 *
 * postMessage targets WORKER_ORIGIN only; incoming messages ignore other origins.
 *
 * Critical #4 — Pending request timeouts: `storeKey`, `hasKey`, and `requestFuelGauge`
 * use `requestWithTimeout` so a missing iframe (CSP, network, sandbox) cannot hang the UI
 * forever. Shorter timeout on key paths (`STORE_KEY_TIMEOUT_MS`).
 *
 * Two channels: `pendingRequests` (OK/ERROR one-shots) vs `streamingRequests` (GENERATE).
 */

import { type RoomId, FFError } from "@fatedfortress/protocol";

/** Shape of a demo-mode grant returned by the relay registry. */
export interface DemoGrant {
  token: string;
  provider: "openai" | "anthropic" | "google" | "minimax" | "groq" | "openrouter";
  maxTokens: number;
  expiresAt: number;
  rateLimitResetAt: number;
}

/** Per-IP rate limit exceeded on the relay side. */
export class DemoRateLimitError extends Error {
  constructor(public resetAt: number) {
    super(`Demo key rate-limited until ${new Date(resetAt).toISOString()}`);
    this.name = "DemoRateLimitError";
  }
}

const WORKER_ORIGIN = typeof __WORKER_ORIGIN__ !== "undefined"
  ? __WORKER_ORIGIN__
  : "https://keys.fatedfortress.com";

export interface FuelGaugeState {
  roomId: string;
  /** Text token budget */
  participants: Array<{
    pubkey: string;
    fraction: number;
    consumed: number;
    reserved: number;
    quota: number;
  }>;
  /** Multimodal budget (null if not used / not yet initialized) */
  maxImages: number | null;
  maxAudioSeconds: number | null;
  maxVideoSeconds: number | null;
}

const REQUEST_TIMEOUT_MS = 30_000;
const STORE_KEY_TIMEOUT_MS = 10_000;

type PendingEntry = {
  resolve: (payload: unknown) => void;
  reject: (err: unknown) => void;
};

export class WorkerBridge {
  private static instance: WorkerBridge;
  private workerIframe: HTMLIFrameElement | null = null;
  private pendingRequests = new Map<string, PendingEntry>();
  private streamingRequests = new Map<string, {
    onChunk?: (chunk: string) => void;
    onImageUrl?: (url: string, alt?: string) => void;
    onAudioUrl?: (url: string, durationSeconds?: number) => void;
    onProgress?: (percent: number) => void;
    onDone?: (outputHash: string) => void;
    onError?: (code: string, message: string) => void;
    resolve: (payload: unknown) => void;
  }>();

  /**
   * Registers resolve/reject before `postMessage` so an immediate worker reply cannot race.
   */
  public requestWithTimeout<T>(
    requestId: string,
    postMessage: () => void,
    timeoutMs = REQUEST_TIMEOUT_MS
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new FFError(
          "REQUEST_TIMEOUT",
          `WorkerBridge request ${requestId} timed out after ${timeoutMs}ms — ` +
            `the keystore iframe may not have loaded (CSP, network, or sandbox restriction).`
        ));
      }, timeoutMs);

      this.pendingRequests.set(requestId, {
        resolve: (value: unknown) => {
          clearTimeout(timeoutId);
          this.pendingRequests.delete(requestId);
          resolve(value as T);
        },
        reject: (err: unknown) => {
          clearTimeout(timeoutId);
          this.pendingRequests.delete(requestId);
          reject(err);
        },
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

    if (msg.type === "OK") {
      const entry = this.pendingRequests.get(msg.requestId);
      if (entry) {
        entry.resolve(msg.payload);
      }
    } else if (msg.type === "FUEL") {
      window.dispatchEvent(new CustomEvent("ff:fuel", { detail: msg.state }));
    } else if (msg.type === "CHUNK") {
      const req = this.streamingRequests.get(msg.requestId);
      req?.onChunk?.(msg.chunk);
    } else if (msg.type === "DONE") {
      const req = this.streamingRequests.get(msg.requestId);
      req?.onDone?.(msg.outputHash);
      req?.resolve?.(msg.outputHash);
      this.streamingRequests.delete(msg.requestId);
    } else if (msg.type === "IMAGE_URL") {
      const req = this.streamingRequests.get(msg.requestId);
      req?.onImageUrl?.(msg.url, msg.alt);
    } else if (msg.type === "AUDIO_URL") {
      const req = this.streamingRequests.get(msg.requestId);
      req?.onAudioUrl?.(msg.url, msg.durationSeconds);
    } else if (msg.type === "JOB_ID") {
      // Async job started — the worker will poll; caller can track via onProgress
    } else if (msg.type === "PROGRESS") {
      const req = this.streamingRequests.get(msg.requestId);
      req?.onProgress?.(msg.percent);
    } else if (msg.type === "ERROR") {
      const streamReq = this.streamingRequests.get(msg.requestId);
      if (streamReq) {
        streamReq.onError?.(msg.code, msg.message);
        this.streamingRequests.delete(msg.requestId);
      } else {
        const pending = this.pendingRequests.get(msg.requestId);
        if (pending) {
          pending.reject(new FFError(msg.code, msg.message));
        } else {
          console.error(`[WorkerBridge] Unhandled error: [${msg.code}] ${msg.message}`);
        }
      }
    }
  }

  public async storeKey(provider: string, key: string): Promise<void> {
    const requestId = crypto.randomUUID();
    await this.requestWithTimeout<unknown>(
      requestId,
      () => {
        this.workerIframe?.contentWindow?.postMessage(
          { type: "STORE_KEY", provider, key, requestId },
          WORKER_ORIGIN
        );
      },
      STORE_KEY_TIMEOUT_MS
    );
  }

  public async requestFuelGauge(roomId: RoomId): Promise<FuelGaugeState> {
    const requestId = crypto.randomUUID();
    return this.requestWithTimeout<FuelGaugeState>(
      requestId,
      () => {
        this.workerIframe?.contentWindow?.postMessage(
          { type: "FUEL_GAUGE", roomId, requestId },
          WORKER_ORIGIN
        );
      },
      REQUEST_TIMEOUT_MS
    );
  }

  /** Returns whether the worker reports a stored key; false on timeout or error. */
  public async hasKey(provider: string): Promise<boolean> {
    const requestId = crypto.randomUUID();
    try {
      const payload = await this.requestWithTimeout<{ has?: boolean }>(
        requestId,
        () => {
          this.workerIframe?.contentWindow?.postMessage(
            { type: "HAS_KEY", provider, requestId },
            WORKER_ORIGIN
          );
        },
        STORE_KEY_TIMEOUT_MS
      );
      return payload?.has ?? false;
    } catch {
      return false;
    }
  }

  public requestGenerate(
    opts: {
      provider: string;
      model: string;
      prompt: string;
      systemPrompt: string;
      modality?: string;
      imageParams?: {
        aspectRatio?: string;
        negativePrompt?: string;
        seed?: number;
        style?: string;
      };
      isSpectator?: boolean;
      signal?: AbortSignal;
      roomId?: string;
      participantPubkey?: string;
      quotaTokensToReserve?: number;
    },
    callbacks: {
      onChunk?: (chunk: string) => void;
      onImageUrl?: (url: string, alt?: string) => void;
      onProgress?: (percent: number) => void;
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
        modality: opts.modality,
        imageParams: opts.imageParams,
        isSpectator: opts.isSpectator ?? false,
        roomId: opts.roomId,
        participantPubkey: opts.participantPubkey,
        quotaTokensToReserve: opts.quotaTokensToReserve,
        requestId,
      }, WORKER_ORIGIN);
    });
  }

  /**
   * Phase 5 — POST-style session flush: abort in-flight generations + teardownBudget()
   * (nonce DB). Does not clear API keys — those stay until TERMINATE / full unload.
   */
  public async requestTeardown(): Promise<void> {
    const requestId = crypto.randomUUID(); // correlate OK/ERROR with this flush
    await this.requestWithTimeout<unknown>(
      requestId,
      () => {
        this.workerIframe?.contentWindow?.postMessage(
          { type: "TEARDOWN", requestId },
          WORKER_ORIGIN
        );
      },
      REQUEST_TIMEOUT_MS
    );
  }

  /**
   * PRIORITY 1 · Consumes one demo-key grant from the relay registry.
   *
   * Flow:
   *   1. Bridge posts CONSUME_DEMO_TOKEN to the worker iframe
   *   2. w_router proxies to r_reg /demo/consume (origin attestation added server-side)
   *   3. r_reg checks per-IP rate limit, mints a signed token, returns it
   *   4. Token is kept in-memory only — never persisted
   *
   * @throws DemoRateLimitError if the user's IP has exhausted the free demo quota
   */
  public async consumeDemoToken(
    provider: DemoGrant["provider"],
    roomId: string,
  ): Promise<DemoGrant> {
    const requestId = crypto.randomUUID();
    const response = await this.requestWithTimeout<{ ok: boolean; data?: DemoGrant; error?: { code: string; message: string; resetAt?: number } }>(
      requestId,
      () => {
        this.workerIframe?.contentWindow?.postMessage(
          { type: "CONSUME_DEMO_TOKEN", provider, roomId, requestId },
          WORKER_ORIGIN
        );
      },
      8_000,
    );

    if (!response.ok) {
      if (response.error?.code === "DEMO_RATE_LIMITED") {
        throw new DemoRateLimitError(response.error.resetAt ?? Date.now() + 3_600_000);
      }
      throw new Error(response.error?.message ?? "Failed to consume demo token");
    }
    return response.data!;
  }

  /**
   * PRIORITY 1 · Checks if a demo grant is still available for this IP without consuming it.
   * Used to show a "Try demo" badge on RoomCard only when actually usable.
   */
  public async checkDemoAvailable(
    provider: DemoGrant["provider"],
  ): Promise<{ available: boolean; resetAt?: number }> {
    const requestId = crypto.randomUUID();
    const response = await this.requestWithTimeout<{ ok: boolean; data?: { available: boolean; resetAt?: number } }>(
      requestId,
      () => {
        this.workerIframe?.contentWindow?.postMessage(
          { type: "CHECK_DEMO_AVAILABLE", provider, requestId },
          WORKER_ORIGIN
        );
      },
      4_000,
    );
    return response.ok && response.data ? response.data : { available: false };
  }
}
