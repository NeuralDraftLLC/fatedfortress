import { FFError, PROVIDER_ALLOWLIST } from "@fatedfortress/protocol";

const FF_ORIGIN = typeof __FF_ORIGIN__ !== "undefined"
  ? __FF_ORIGIN__
  : "https://fatedfortress.com";
import {
  storeKey,
  hasKey,
  encryptKeyForStorage,
  decryptAndLoadKey,
  type ProviderId,
  type EncryptedKeyBlob,
} from "./keystore.js";
// activeGenerations: same Map as in generate.ts (B3) — needed to abort in-flight streams
// by requestId when the parent posts ABORT_GENERATE.
import { handleGenerate, activeGenerations } from "./generate.js";
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
  | { type: "GENERATE";     provider: string; model: string; prompt: string; systemPrompt: string; requestId: string; isSpectator?: boolean; roomId?: string; participantPubkey?: string; quotaTokensToReserve?: number }
  | { type: "ABORT_GENERATE"; requestId: string }
  | { type: "VERIFY_TOKEN"; token: unknown; hostPubkey: string; roomId: string; requestId: string }
  | { type: "MINT_TOKEN";   roomId: string; participantPubkey: string; tokensToGrant: number; requestId: string }
  | { type: "INIT_QUOTA";   roomId: string; quotaPerUser: number;            requestId: string }
  | { type: "FUEL_GAUGE";   roomId: string;                                  requestId: string }
| { type: "DELEGATE_SUB_BUDGET"; peerPubkey: string; tokensToDelegate: number; roomId: string; requestId: string }
| { type: "REVOKE_DELEGATION";   peerPubkey: string;                               requestId: string }
  /** Phase 5 Medium #11 — SPA navigation: flush budget DB + abort streams (same net effect as iframe unload). */
  | { type: "TEARDOWN"; requestId: string }
  | { type: "TERMINATE" };

export type RequestMessage = Exclude<InboundMessage, { type: "TERMINATE" }>;

export type OutboundMessage =
  | { type: "CHUNK";  requestId: string; chunk: string }
  | { type: "DONE";   requestId: string; outputHash: string }
  | { type: "ERROR";  requestId: string; code: string; message: string }
  | { type: "OK";     requestId: string; payload?: unknown }
  | { type: "FUEL";   requestId: string; state: unknown };

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
      const token = await mintToken(msg.roomId, msg.participantPubkey as any, msg.tokensToGrant);
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
      send({ type: "OK", requestId });
      return;
    }

    case "TEARDOWN": {
      abortAllGenerations(); // cancel streaming fetches before closing nonce DB
      await teardownBudget(); // IndexedDB nonce sweep + reservation map — not teardownKeystore
      send({ type: "OK", requestId, payload: null });
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
