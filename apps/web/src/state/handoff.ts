/**
 * handoff.ts — Ephemeral Y.js handoff (Part A) + Minimax stream cache (Part B), Phase 4.
 *
 * Part A: Host serializes the Y.js doc, wraps a handoff token (SubBudgetToken shape, purpose: handoff,
 * tokensGranted: 0), and sends { type: "HANDOFF" } on the relay. The delegate applies the snapshot
 * and sets activeHostPubkey. Host Ed25519 signing is expected to be done in the keystore worker in
 * a follow-up; the wire shape is valid for acceptHandoff() shape checks.
 *
 * Part B: Stream output cache for mid-stream host drop — appendStreamChunk on each CHUNK, markStreamComplete
 * on DONE, getCachedOutput before starting generation. TTL 10m, max 50 entries, LRU by last access.
 */

import type { PublicKeyBase58, RoomId, SubBudgetToken } from "@fatedfortress/protocol";
import {
  base64urlEncode,
  base64urlDecode,
  generateTokenId,
  generateTokenNonce,
  SUB_BUDGET_TOKEN_TTL_MS,
} from "@fatedfortress/protocol";
import type { FortressRoomDoc } from "./ydoc.js";
import { getRoomId, serializeDoc, setMeta, applyRemoteUpdate } from "./ydoc.js";
import { getMyPubkey } from "./identity.js";
import { getRelayWebSocket } from "../net/signaling.js";

// ── Part A: Y.js handoff ─────────────────────────────────────────────────────

export interface HandoffWireMessage {
  type: "HANDOFF";
  targetPeerId: string;
  token: SubBudgetToken;
  yjsUpdateBase64: string;
  fromHostPubkey: string;
}

/**
 * Serializes the full Y.js state and queues a HANDOFF for the delegate (via relay targetPeerId routing).
 * Signature on `token` is a placeholder until the keystore worker exposes a MINT_HANDOFF op.
 */
export function initiateHandoff(
  doc: FortressRoomDoc,
  delegatePubkey: PublicKeyBase58
): void {
  const roomId = getRoomId(doc) as RoomId;
  const hostPubkey = (doc.meta.get("activeHostPubkey") as string) || (doc.meta.get("hostPubkey") as string);
  const myPk = getMyPubkey();
  if (!myPk || !hostPubkey) {
    console.warn("[handoff] Missing pubkey for handoff");
    return;
  }

  const update = serializeDoc(doc);
  const yjsUpdateBase64 = base64urlEncode(update);

  const now = Date.now();
  const token: SubBudgetToken = {
    id: generateTokenId(),
    roomId,
    delegatePubkey,
    hostPubkey: hostPubkey as PublicKeyBase58,
    tokensGranted: 0,
    issuedAt: now,
    expiresAt: now + SUB_BUDGET_TOKEN_TTL_MS,
    nonce: generateTokenNonce(),
    // Wire placeholder — real Ed25519 via keystore worker must mint before delegate spends budget (Phase 2 path).
    signature: "" as SubBudgetToken["signature"],
    purpose: "handoff",
  };

  const ws = getRelayWebSocket();
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn("[handoff] No relay socket — HANDOFF not sent");
    return;
  }

  const msg: HandoffWireMessage = {
    type: "HANDOFF",
    targetPeerId: delegatePubkey,
    token,
    yjsUpdateBase64,
    fromHostPubkey: myPk,
  };
  ws.send(JSON.stringify(msg));
}

/**
 * Applies incoming HANDOFF if it targets this peer and passes basic validity checks.
 * Idempotent: applyRemoteUpdate merges safely over partial relay sync.
 */
export function acceptHandoff(doc: FortressRoomDoc, raw: unknown): void {
  if (!raw || typeof raw !== "object") return;
  const msg = raw as Partial<HandoffWireMessage>;
  if (msg.type !== "HANDOFF") return;

  const myPk = getMyPubkey();
  if (!myPk || msg.token?.delegatePubkey !== myPk) return;

  const roomId = getRoomId(doc);
  if (msg.token.roomId !== roomId) return;
  if (msg.token.purpose !== "handoff") return;
  if (Date.now() > msg.token.expiresAt) return;

  if (typeof msg.yjsUpdateBase64 === "string" && msg.yjsUpdateBase64.length > 0) {
    try {
      const bytes = base64urlDecode(msg.yjsUpdateBase64);
      applyRemoteUpdate(doc, bytes);
    } catch {
      console.warn("[handoff] Failed to apply Y.js snapshot");
    }
  }

  setMeta(doc, {
    activeHostPubkey: msg.token.delegatePubkey as PublicKeyBase58,
  });
}

// ── Part B: Minimax stream cache (generic provider stream resume) ─────────────

const STREAM_CACHE_TTL_MS = 10 * 60 * 1000;
const STREAM_CACHE_MAX = 50;

interface CacheEntry {
  text: string;
  startedAt: number;
  lastAccess: number;
  outputHash: string | null;
}

const streamCache = new Map<string, CacheEntry>();

function touchEviction(): void {
  const now = Date.now();
  // Drop stale entries first…
  for (const [k, e] of streamCache) {
    if (now - e.lastAccess > STREAM_CACHE_TTL_MS) streamCache.delete(k);
  }
  // …then trim by oldest lastAccess if still above cap (bounded RAM for long sessions).
  while (streamCache.size > STREAM_CACHE_MAX) {
    let oldestKey = "";
    let oldest = Infinity;
    for (const [k, e] of streamCache) {
      if (e.lastAccess < oldest) {
        oldest = e.lastAccess;
        oldestKey = k;
      }
    }
    if (oldestKey) streamCache.delete(oldestKey);
    else break;
  }
}

async function sha256Hex(parts: string[]): Promise<string> {
  const enc = new TextEncoder();
  const joined = parts.join("|");
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(joined));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Cache key: model | systemPrompt | prompt */
export async function streamCacheKey(model: string, systemPrompt: string, prompt: string): Promise<string> {
  return sha256Hex([model, systemPrompt, prompt]);
}

export async function appendStreamChunk(
  model: string,
  systemPrompt: string,
  prompt: string,
  chunk: string
): Promise<void> {
  const key = await streamCacheKey(model, systemPrompt, prompt);
  touchEviction();
  const now = Date.now();
  const prev = streamCache.get(key);
  streamCache.set(key, {
    text: (prev?.text ?? "") + chunk,
    startedAt: prev?.startedAt ?? now,
    lastAccess: now,
    outputHash: null,
  });
}

export async function markStreamComplete(
  model: string,
  systemPrompt: string,
  prompt: string,
  outputHash: string
): Promise<void> {
  const key = await streamCacheKey(model, systemPrompt, prompt);
  const ent = streamCache.get(key);
  if (ent) {
    ent.outputHash = outputHash;
    ent.lastAccess = Date.now();
  }
}

/** Returns cached partial/final text for resume-after-drop (prepend to generation input). */
export async function getCachedOutput(
  model: string,
  systemPrompt: string,
  prompt: string
): Promise<string | null> {
  touchEviction();
  const key = await streamCacheKey(model, systemPrompt, prompt);
  const ent = streamCache.get(key);
  if (!ent || Date.now() - ent.lastAccess > STREAM_CACHE_TTL_MS) return null;
  ent.lastAccess = Date.now();
  return ent.text.length > 0 ? ent.text : null;
}
