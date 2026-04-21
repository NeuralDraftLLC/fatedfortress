/**
 * Streaming LLM generation inside the sandboxed worker iframe.
 *
 * - Keys never leave this context; adapters read raw key via keystore only here.
 * - Each in-flight GENERATE is keyed by the same requestId the parent uses for
 *   CHUNK/DONE/ERROR and for ABORT_GENERATE (see router.ts).
 *
 * Export (B3): router must call AbortController.abort() by requestId — the map is
 * shared across modules, so it must be exported alongside handleGenerate.
 *
 * Medium #10 — Dynamic `import(\`./adapters/${provider}\`)` with @vite-ignore does not
 * emit adapter chunks in the worker build; static imports + ADAPTER_MAP keep every
 * adapter in the bundle and satisfy Record<ProviderId, …> at compile time.
 *
 * Quota: optional `roomId` + `participantPubkey` + `quotaTokensToReserve` when the room
 * has INIT_QUOTA (hasRoomQuota); finalise vs release in `finally`.
 *
 * Multimodal (Task 9): AdapterModule.generate() now yields AdapterYield union types.
 * Text adapters emit text_delta; image/audio adapters emit image_url/audio_url + job_id
 * (async) or direct output. All adapters still receive the same AbortSignal.
 */

import type { PublicKeyBase58, ProviderId } from "@fatedfortress/protocol";
import type { AdapterYield } from "@fatedfortress/protocol";
import { FFError, hashOutput } from "@fatedfortress/protocol";
import {
  finaliseQuotaReservation,
  hasRoomQuota,
  releaseQuotaReservation,
  reserveQuota,
} from "./budget.js";
import { hasKey, getRawKey } from "./keystore.js";
import type { InboundMessage, OutboundMessage } from "./router.js";

import * as openaiMod from "./adapters/openai.js";
import * as anthropicMod from "./adapters/anthropic.js";
import * as googleMod from "./adapters/google.js";
import * as minimaxMod from "./adapters/minimax.js";
import * as groqMod from "./adapters/groq.js";
import * as openrouterMod from "./adapters/openrouter.js";

interface AdapterModule {
  generate(opts: {
    key: string;
    model: string;
    prompt: string;
    systemPrompt: string;
    signal: AbortSignal;
  }): AsyncIterable<AdapterYield>;
}

/**
 * When PROVIDER_ALLOWLIST gains a provider, add import + entry here — TypeScript
 * enforces Record<ProviderId, AdapterModule>.
 *
 * NOTE: Adapters that haven't been updated to emit AdapterYield will continue to
 * return plain strings. A forward-compat shim wraps each adapter's string stream
 * and maps each string to { type: "text_delta", delta: string }.
 *
 * The `as unknown as AdapterModule` cast is safe: we trust the adapter's generate()
 * signature matches at runtime.
 */
const ADAPTER_MAP: Record<ProviderId, AdapterModule> = {
  openai:     openaiMod as unknown as AdapterModule,
  anthropic:  anthropicMod as unknown as AdapterModule,
  google:     googleMod as unknown as AdapterModule,
  minimax:    minimaxMod as unknown as AdapterModule,
  groq:       groqMod as unknown as AdapterModule,
  openrouter: openrouterMod as unknown as AdapterModule,
};

/**
 * Forward-compat shim: wraps an AsyncIterable<string> (legacy adapter) into
 * AsyncIterable<AdapterYield> by mapping each string chunk to text_delta.
 * This lets the yield loop below handle both old and new adapters uniformly.
 */

export const activeGenerations = new Map<string, AbortController>();

export function abortAllGenerations(): void {
  for (const controller of activeGenerations.values()) {
    controller.abort();
  }
  activeGenerations.clear();
}

export async function handleGenerate(
  msg: Extract<InboundMessage, { type: "GENERATE" }>,
  requestId: string,
  send: (msg: OutboundMessage) => void
): Promise<void> {
  if (activeGenerations.has(requestId)) {
    throw new FFError("DuplicateRequest", "A request with this ID is already in progress");
  }

  const isSpectator = msg.isSpectator ?? false;
  if (isSpectator) {
    throw new FFError(
      "SpectatorCannotGenerate",
      "Spectators cannot trigger generation — contribute your API key to participate"
    );
  }

  const provider = msg.provider as ProviderId;

  const adapter = ADAPTER_MAP[provider];
  if (!adapter) {
    throw new FFError(
      "UnknownProvider",
      `Unknown provider: "${msg.provider}". Registered: ${Object.keys(ADAPTER_MAP).join(", ")}`
    );
  }

  if (!hasKey(provider)) {
    throw new FFError("NoKeyStored", `No key stored for provider: ${provider}`);
  }

  let reservedQuota = 0;
  let quotaRoomId: string | undefined;
  let quotaParticipant: PublicKeyBase58 | undefined;
  const qr = msg.quotaTokensToReserve ?? 0;
  if (msg.roomId && msg.participantPubkey && qr > 0 && hasRoomQuota(msg.roomId)) {
    quotaRoomId = msg.roomId;
    quotaParticipant = msg.participantPubkey as PublicKeyBase58;
    reservedQuota = reserveQuota(quotaRoomId, quotaParticipant, qr);
    if (reservedQuota <= 0) {
      throw new FFError(
        "InsufficientQuota",
        "No quota available for this generation — try again later or reduce concurrent requests."
      );
    }
  }

  const controller = new AbortController();
  activeGenerations.set(requestId, controller);

  let billedSuccess = false;
  try {
    const key = getRawKey(provider);

    const rawStream = adapter.generate({
      key,
      model: msg.model,
      prompt: msg.prompt,
      systemPrompt: msg.systemPrompt,
      signal: controller.signal,
    });

    // Accept AdapterYield directly, or fall back to string stream (legacy adapter compat)
    const stream: AsyncIterable<AdapterYield> = rawStream as AsyncIterable<AdapterYield>;

    let fullTextOutput = "";

    for await (const yield_ of stream) {
      if (controller.signal.aborted) break;

      switch (yield_.type) {
        case "text_delta": {
          fullTextOutput += yield_.delta;
          send({ type: "CHUNK", requestId, chunk: yield_.delta });
          break;
        }
        case "image_url": {
          send({ type: "IMAGE_URL", requestId, url: yield_.url, alt: yield_.alt });
          break;
        }
        case "audio_url": {
          send({ type: "AUDIO_URL", requestId, url: yield_.url, durationSeconds: yield_.durationSeconds });
          break;
        }
        case "job_id": {
          send({ type: "JOB_ID", requestId, jobId: yield_.jobId, provider: yield_.provider });
          break;
        }
        case "progress": {
          send({ type: "PROGRESS", requestId, percent: yield_.percent });
          break;
        }
        case "done": {
          send({ type: "ADAPTER_DONE", requestId, adapterId: yield_.adapterId });
          break;
        }
      }
    }

    if (!controller.signal.aborted) {
      const outputHash = await hashOutput(fullTextOutput);
      send({ type: "DONE", requestId, outputHash });
      billedSuccess = true;
    }
  } finally {
    if (reservedQuota > 0 && quotaRoomId && quotaParticipant) {
      if (billedSuccess) {
        finaliseQuotaReservation(quotaRoomId, quotaParticipant, reservedQuota);
      } else {
        releaseQuotaReservation(quotaRoomId, quotaParticipant, reservedQuota);
      }
    }
    activeGenerations.delete(requestId);
  }
}
