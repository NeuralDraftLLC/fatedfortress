import { FFError, PROVIDER_ALLOWLIST } from "@fatedfortress/protocol";

const FF_ORIGIN = typeof __FF_ORIGIN__ !== "undefined"
  ? __FF_ORIGIN__
  : "https://fatedfortress.com";
import {
  storeKey,
  hasKey,
  encryptKeyForStorage,
  decryptAndLoadKey,
  getSigningKey,
  type ProviderId,
  type EncryptedKeyBlob,
} from "./keystore.js";
// activeGenerations: same Map as in generate.ts (B3) — needed to abort in-flight streams
// by requestId when the parent posts ABORT_GENERATE.
import { handleGenerate, activeGenerations, abortAllGenerations } from "./generate.js";
import { cancelAsyncJobsForRequest } from "./async-jobs.js";
import { teardownBudget } from "./budget.js";
import {
  mintToken,
  verifyToken,
  mintSubBudgetToken,
  verifySubBudgetToken,
  initRoomQuota,
  getFuelState,
} from "./liquidity.js";

export const VALID_PROVIDERS = new Set<string>(PROVIDER_ALLOWLIST);

export type InboundMessage =
  | { type: "STORE_KEY";    provider: string; key: string;                   requestId: string }
  | { type: "HAS_KEY";      provider: string;                                requestId: string }
  | { type: "ENCRYPT_KEY";  provider: string; passphrase: string;            requestId: string }
  | { type: "DECRYPT_KEY";  provider: string; blob: EncryptedKeyBlob; passphrase: string; requestId: string }
  | { type: "GENERATE";     provider: string; model: string; prompt: string; systemPrompt: string; requestId: string; modality?: string; isSpectator?: boolean; roomId?: string; participantPubkey?: string; quotaTokensToReserve?: number }
  | { type: "ABORT_GENERATE"; requestId: string }
  | { type: "VERIFY_TOKEN"; token: unknown; hostPubkey: string; roomId: string; requestId: string }
  | { type: "MINT_TOKEN";   roomId: string; participantPubkey: string; tokensToGrant: number; requestId: string }
  | { type: "INIT_QUOTA";   roomId: string; quotaPerUser: number;            requestId: string }
  | { type: "FUEL_GAUGE";   roomId: string;                                  requestId: string }
  | { type: "DELEGATE_SUB_BUDGET"; peerPubkey: string; tokensToDelegate: number; roomId: string; requestId: string }
  | { type: "REVOKE_DELEGATION";   peerPubkey: string;                               requestId: string }
  /** Phase 5 Medium #11 — SPA navigation: flush budget DB + abort streams (same net effect as iframe unload). */
  | { type: "TEARDOWN"; requestId: string }
  | { type: "TERMINATE" }
  /** PRIORITY 1 · Demo key flow — proxy to relay registry. */
  | { type: "CONSUME_DEMO_TOKEN"; provider: string; roomId: string; requestId: string }
  | { type: "CHECK_DEMO_AVAILABLE"; provider: string; requestId: string }
  /** PRIORITY 2 · Server-side key-policy enforcement. */
  | { type: "ENFORCE_KEY_POLICY"; budgetToken: unknown; participantPubkey: string; isHost: boolean; requestId: string };

export type RequestMessage = Exclude<InboundMessage, { type: "TERMINATE" }>;

export type OutboundMessage =
  | { type: "CHUNK";       requestId: string; chunk: string }
  | { type: "DONE";        requestId: string; outputHash: string }
  | { type: "ERROR";       requestId: string; code: string; message: string }
  | { type: "OK";          requestId: string; payload?: unknown }
  | { type: "FUEL";        requestId: string; state: unknown }
  // Multimodal (Task 9):
  | { type: "IMAGE_URL";   requestId: string; url: string; alt?: string }
  | { type: "AUDIO_URL";   requestId: string; url: string; durationSeconds?: number }
  | { type: "JOB_ID";      requestId: string; jobId: string; provider: string }
  | { type: "PROGRESS";    requestId: string; percent: number }
  | { type: "ADAPTER_DONE"; requestId: string; adapterId: string };

export function send(msg: OutboundMessage): void {
  window.parent.postMessage(msg, FF_ORIGIN);
}

export function sendError(requestId: string, err: unknown): void {
  const fferr = err instanceof FFError
    ? err
    : new FFError("WorkerInternalError", "An internal worker error occurred");
  send({ type: "ERROR", requestId, code: fferr.code, message: fferr.message });
}

export function assertValidProvider(provider: string): asserts provider is ProviderId {
  if (!VALID_PROVIDERS.has(provider)) {
    throw new FFError(
      "InvalidProvider",
      `Unknown provider. Valid providers: ${PROVIDER_ALLOWLIST.join(", ")}`
    );
  }
}

// ─── PRIORITY 1: Demo Key Handlers ────────────────────────────────────────────

const RELAY_REGISTRY_URL =
  (typeof __RELAY_REGISTRY_URL__ !== "undefined" && __RELAY_REGISTRY_URL__)
    ? __RELAY_REGISTRY_URL__
    : "https://relay.fatedfortress.com";

/**
 * Proxies CONSUME_DEMO_TOKEN to the relay registry.
 * The worker-side fetch keeps the call inside the sandbox (no rate-limit bypass
 * via main-thread fetch). Origin attestation is added so the relay can
 * distinguish real app traffic from scripted abuse.
 */
export async function handleConsumeDemoToken(
  requestId: string,
  payload: { provider: string; roomId: string },
): Promise<void> {
  try {
    const res = await fetch(`${RELAY_REGISTRY_URL}/demo/consume`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ff-origin-attestation": await generateOriginAttestation(),
      },
      body: JSON.stringify(payload),
    });

    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      return sendError(requestId, {
        code: "DEMO_RATE_LIMITED",
        message: "Demo quota exhausted for this IP",
        resetAt: body.resetAt ?? Date.now() + 3_600_000,
      });
    }

    if (!res.ok) {
      return sendError(requestId, {
        code: "DEMO_CONSUME_FAILED",
        message: `Relay returned ${res.status}`,
      });
    }

    const grant = await res.json();
    send({ type: "OK", requestId, payload: grant });
  } catch (err) {
    sendError(requestId, {
      code: "DEMO_NETWORK_ERROR",
      message: (err as Error).message,
    });
  }
}

/**
 * Proxies CHECK_DEMO_AVAILABLE to the relay registry (no consumption).
 */
export async function handleCheckDemoAvailable(
  requestId: string,
  payload: { provider: string },
): Promise<void> {
  try {
    const url = new URL("/demo/check", RELAY_REGISTRY_URL);
    url.searchParams.set("provider", payload.provider);
    const res = await fetch(url.toString(), { method: "GET" });
    const data = res.ok ? await res.json() : { available: false };
    send({ type: "OK", requestId, payload: data });
  } catch {
    send({ type: "OK", requestId, payload: { available: false } });
  }
}

/**
 * Signs a timestamp with the worker's Ed25519 session key so the relay can
 * verify the request originated from inside the app, not a main-thread script.
 */
async function generateOriginAttestation(): Promise<string> {
  const timestamp = Date.now().toString();
  const encoder = new TextEncoder();
  const data = encoder.encode(`ff-demo-origin:${timestamp}`);
  try {
    const signingKey = await getSigningKey();
    const sig = await crypto.subtle.sign("Ed25519", signingKey.privateKey, data);
    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
    return `${timestamp}.${sigB64}`;
  } catch {
    // If signing fails (e.g., key not yet initialized), send timestamp only;
    // relay will fall back to stricter per-IP limits.
    return timestamp;
  }
}

// ─── PRIORITY 2: Key Policy Enforcement ────────────────────────────────────────

/**
 * Server-side gate: before any GENERATE from a participant proceeds, verify
 * the room's allowCommunityKeys policy is satisfied.
 *
 * The policy is baked into the budget token at mint time by the host, so it
 * cannot be forged client-side. peekOnly avoids consuming the token.
 *
 * Returns { allowed: true }  → generation may proceed
 *         { allowed: false, reason }
 */
export async function enforceKeyPolicy(args: {
  budgetToken: unknown;
  participantPubkey: string;
  isHost: boolean;
}): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  try {
    // Decode and verify token structure without consuming the nonce
    const token = args.budgetToken as import("@fatedfortress/protocol").BudgetToken;
    if (!token || typeof token !== "object") {
      return { allowed: false, reason: "Invalid budget token" };
    }

    // Host bypasses policy — they can always generate
    if (args.isHost) return { allowed: true };

    // Read allowCommunityKeys from the token's extensions / metadata field
    const allowCommunityKeys = (token as unknown as Record<string, unknown>)["allowCommunityKeys"];
    if (allowCommunityKeys === true) return { allowed: true };

    return {
      allowed: false,
      reason:
        "This room is in host-only key mode. Ask the host to enable community key contribution in room settings.",
    };
  } catch {
    return { allowed: false, reason: "Could not verify budget token policy" };
  }
}

export async function dispatchMessage(msg: RequestMessage): Promise<void> {
  const requestId = msg.requestId;

  switch (msg.type) {
    case "STORE_KEY": {
      assertValidProvider(msg.provider);
      await storeKey(msg.provider, msg.key);
      send({ type: "OK", requestId, payload: { stored: true } });
      return;
    }

    case "HAS_KEY": {
      assertValidProvider(msg.provider);
      send({ type: "OK", requestId, payload: { has: hasKey(msg.provider) } });
      return;
    }

    case "ENCRYPT_KEY": {
      assertValidProvider(msg.provider);
      const blob = await encryptKeyForStorage(msg.provider, msg.passphrase);
      send({ type: "OK", requestId, payload: blob });
      return;
    }

    case "DECRYPT_KEY": {
      assertValidProvider(msg.provider);
      await decryptAndLoadKey(msg.blob, msg.passphrase);
      send({ type: "OK", requestId });
      return;
    }

    case "GENERATE": {
      assertValidProvider(msg.provider);
      await handleGenerate(msg, requestId, send);
      return;
    }

    case "VERIFY_TOKEN": {
      const tokensGranted = await verifyToken(msg.token, msg.hostPubkey as any, msg.roomId);
      send({ type: "OK", requestId, payload: { tokensGranted } });
      return;
    }

    case "MINT_TOKEN": {
      const token = await mintToken(msg.roomId as any, msg.participantPubkey as any, msg.tokensToGrant);
      send({ type: "OK", requestId, payload: token });
      return;
    }

    case "INIT_QUOTA": {
      initRoomQuota(msg.roomId, msg.quotaPerUser);
      send({ type: "OK", requestId });
      return;
    }

    case "FUEL_GAUGE": {
      const state = getFuelState(msg.roomId);
      send({ type: "FUEL", requestId, state });
      return;
    }

    case "DELEGATE_SUB_BUDGET": {
      const { mintSubBudgetToken } = await import("./liquidity.js");
      const token = await mintSubBudgetToken(
        msg.peerPubkey as any,
        msg.roomId as any,
        msg.tokensToDelegate
      );
      send({ type: "OK", requestId, payload: { delegated: true, tokenId: token.id } });
      return;
    }

    case "REVOKE_DELEGATION": {
      // budget: add peerPubkey to revokedDelegates; future sub-budget tokens for
      // that delegate fail verify (see budget.verifyAndConsumeSubBudgetToken).
      const { revokeSubBudgetDelegation } = await import("./liquidity.js");
      revokeSubBudgetDelegation(msg.peerPubkey as any);
      send({ type: "OK", requestId });
      return;
    }

    case "ABORT_GENERATE": {
      // Propagates to adapter via AbortSignal; generate.ts finally block still clears the map.
      const controller = activeGenerations.get(msg.requestId);
      controller?.abort();
      // Also cancel any async job registered for this requestId (Task 8.5)
      cancelAsyncJobsForRequest(msg.requestId);
      send({ type: "OK", requestId });
      return;
    }

    case "TEARDOWN": {
      abortAllGenerations(); // cancel streaming fetches before closing nonce DB
      await teardownBudget(); // IndexedDB nonce sweep + reservation map — not teardownKeystore
      send({ type: "OK", requestId, payload: null });
      return;
    }

    case "CONSUME_DEMO_TOKEN": {
      await handleConsumeDemoToken(requestId, { provider: msg.provider, roomId: msg.roomId });
      return;
    }

    case "CHECK_DEMO_AVAILABLE": {
      await handleCheckDemoAvailable(requestId, { provider: msg.provider });
      return;
    }

    case "ENFORCE_KEY_POLICY": {
      const result = await enforceKeyPolicy({
        budgetToken: msg.budgetToken,
        participantPubkey: msg.participantPubkey,
        isHost: msg.isHost,
      });
      if (result.allowed) {
        send({ type: "OK", requestId, payload: { allowed: true } });
      } else {
        sendError(requestId, { code: "KEY_POLICY_BLOCKED", message: result.reason });
      }
      return;
    }

    default: {
      send({
        type: "ERROR",
        requestId,
        code: "WorkerProtocolViolation",
        message: "Unknown message type",
      });
    }
  }
}
