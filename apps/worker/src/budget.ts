/**
 * budget.ts — Budget token verification, quota management, and nonce persistence.
 *
 * Trust model (unchanged):
 *   - `hostPubkeyFromDoc` in verify* must come from the Y.js room doc, not the token.
 *   - Sub-budget wire bytes: `encodeBudgetTokenSigningMessage` uses `participantPubkey` in
 *     the object; storage uses `delegatePubkey` (B2) — keep mint/verify in lockstep.
 *   - `RoomId` is branded in protocol; use it in sub-budget mint (B1).
 *
 * FIXES APPLIED:
 *   Critical #3 — Budget nonce replay: consumed nonces persist in IndexedDB under a composite
 *     key (roomId + hostPubkey + nonce). TTL sweep runs opportunistically. Successful verify
 *     ends with `add()` so a concurrent duplicate consume loses the race (ConstraintError → replay).
 *
 *   Critical #5 — TOCTOU quota race: `quotaReservations` subtracts from available balance before
 *     work starts. Prefer reserveQuota → finaliseQuotaReservation / releaseQuotaReservation on
 *     GENERATE paths; `getRemainingQuota` subtracts consumed + reserved.
 */

import {
  type BudgetToken,
  type SubBudgetToken,
  type PublicKeyBase58,
  type RoomId,
  verifyBudgetToken,
  generateTokenId,
  generateTokenNonce,
  encodeBudgetTokenSigningMessage,
  isBudgetToken,
  BUDGET_TOKEN_TTL_MS,
  SUB_BUDGET_TOKEN_TTL_MS,
  FFError,
  base64urlEncode,
  base64urlDecode,
  fromBase58,
} from "@fatedfortress/protocol";

const ONE_HOUR_MS = 3_600_000;

export interface QuotaState {
  quotaPerUser: number;
  consumed: Map<PublicKeyBase58, number>;
  windowStart: number;
}

export interface MintTokenOptions {
  roomId: RoomId;
  participantPubkey: PublicKeyBase58;
  hostPubkey: PublicKeyBase58;
  hostSigningKey: CryptoKey;
  tokensToGrant: number;
}

export interface FuelGaugeState {
  roomId: string;
  participants: Array<{
    pubkey: PublicKeyBase58;
    fraction: number;
    consumed: number;
    reserved: number;
    quota: number;
  }>;
}

// ── Persistent nonce store ────────────────────────────────────────────────────

const NONCE_DB_NAME = "fortress-budget-nonces";
const NONCE_STORE = "nonces";

async function openNonceDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(NONCE_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(NONCE_STORE)) {
        const store = db.createObjectStore(NONCE_STORE);
        store.createIndex("expiresAt", "expiresAt", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function nonceDBKey(roomId: string, hostPubkey: string, nonce: string): string {
  return `${roomId}|${hostPubkey}|${nonce}`;
}

async function sweepExpiredNonces(db: IDBDatabase): Promise<void> {
  const now = Date.now();
  return new Promise((resolve) => {
    const tx = db.transaction(NONCE_STORE, "readwrite");
    const index = tx.objectStore(NONCE_STORE).index("expiresAt");
    const range = IDBKeyRange.upperBound(now, false);
    const req = index.openCursor(range);
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

async function isNonceSeen(
  db: IDBDatabase,
  roomId: string,
  hostPubkey: string,
  nonce: string
): Promise<boolean> {
  await sweepExpiredNonces(db);

  const key = nonceDBKey(roomId, hostPubkey, nonce);
  return new Promise((resolve) => {
    const tx = db.transaction(NONCE_STORE, "readonly");
    const req = tx.objectStore(NONCE_STORE).get(key);
    req.onsuccess = () => resolve(req.result !== undefined);
    req.onerror = () => resolve(false);
  });
}

/**
 * Persists a consumed nonce after successful verification.
 * IndexedDB `add` (not `put`): duplicate key ⇒ ConstraintError ⇒ replay lost race (#3).
 */
async function markNonceSeen(
  db: IDBDatabase,
  roomId: string,
  hostPubkey: string,
  nonce: string,
  tokenExpiresAt: number
): Promise<void> {
  const key = nonceDBKey(roomId, hostPubkey, nonce);
  const expiresAt = tokenExpiresAt + BUDGET_TOKEN_TTL_MS;

  return new Promise((resolve, reject) => {
    const tx = db.transaction(NONCE_STORE, "readwrite");
    const req = tx.objectStore(NONCE_STORE).add({ expiresAt }, key);
    req.onsuccess = () => resolve();
    req.onerror = () => {
      const err = req.error;
      if (err?.name === "ConstraintError") {
        reject(new FFError("BudgetTokenReplayed", "Token nonce already consumed"));
      } else {
        resolve();
      }
    };
    tx.onerror = () => resolve();
  });
}

let _nonceDB: IDBDatabase | null = null;

async function getNonceDB(): Promise<IDBDatabase> {
  if (!_nonceDB) {
    _nonceDB = await openNonceDB();
  }
  return _nonceDB;
}

// ── Quota (TOCTOU pre-reserve) ────────────────────────────────────────────────

const quotaState = new Map<string, QuotaState>();

/** In-flight token capacity held until GENERATE finalises or releases (#5). */
const quotaReservations = new Map<string, number>();

function reservationKey(roomId: string, pubkey: string): string {
  return `${roomId}|${pubkey}`;
}

export function initQuota(roomId: string, quotaPerUser: number): void {
  quotaState.set(roomId, {
    quotaPerUser,
    consumed: new Map(),
    windowStart: Date.now(),
  });
}

/** True once the host has configured pool quota for this room (`INIT_QUOTA`). */
export function hasRoomQuota(roomId: string): boolean {
  return quotaState.has(roomId);
}

export function getRemainingQuota(
  roomId: string,
  participantPubkey: PublicKeyBase58
): number {
  const state = quotaState.get(roomId);
  if (!state) return 0;

  const now = Date.now();
  if (now - state.windowStart > ONE_HOUR_MS) {
    state.consumed.clear();
    state.windowStart = now;
    for (const key of quotaReservations.keys()) {
      if (key.startsWith(`${roomId}|`)) quotaReservations.delete(key);
    }
  }

  const consumed = state.consumed.get(participantPubkey) ?? 0;
  const reserved = quotaReservations.get(reservationKey(roomId, participantPubkey)) ?? 0;
  return Math.max(0, state.quotaPerUser - consumed - reserved);
}

export function reserveQuota(
  roomId: string,
  participantPubkey: PublicKeyBase58,
  tokensRequested: number
): number {
  const available = getRemainingQuota(roomId, participantPubkey);
  if (available <= 0) return 0;

  const toReserve = Math.min(tokensRequested, available);
  const key = reservationKey(roomId, participantPubkey);
  quotaReservations.set(key, (quotaReservations.get(key) ?? 0) + toReserve);
  return toReserve;
}

export function finaliseQuotaReservation(
  roomId: string,
  participantPubkey: PublicKeyBase58,
  tokensActuallyUsed: number
): void {
  const key = reservationKey(roomId, participantPubkey);
  const reserved = quotaReservations.get(key) ?? 0;
  const toRelease = Math.min(reserved, tokensActuallyUsed);

  const newReserved = reserved - toRelease;
  if (newReserved <= 0) {
    quotaReservations.delete(key);
  } else {
    quotaReservations.set(key, newReserved);
  }

  const state = quotaState.get(roomId);
  if (state) {
    const current = state.consumed.get(participantPubkey) ?? 0;
    state.consumed.set(participantPubkey, current + tokensActuallyUsed);
  }
}

export function releaseQuotaReservation(
  roomId: string,
  participantPubkey: PublicKeyBase58,
  tokensReserved: number
): void {
  const key = reservationKey(roomId, participantPubkey);
  const current = quotaReservations.get(key) ?? 0;
  const newReserved = Math.max(0, current - tokensReserved);
  if (newReserved <= 0) {
    quotaReservations.delete(key);
  } else {
    quotaReservations.set(key, newReserved);
  }
}

/** Direct consumption for paths that skip reservation (compat). */
export function consumeQuota(
  roomId: string,
  participantPubkey: PublicKeyBase58,
  tokensUsed: number
): void {
  const state = quotaState.get(roomId);
  if (!state) return;
  const cur = state.consumed.get(participantPubkey) ?? 0;
  state.consumed.set(participantPubkey, cur + tokensUsed);
}

export async function mintBudgetToken(options: MintTokenOptions): Promise<BudgetToken | null> {
  const remaining = getRemainingQuota(options.roomId, options.participantPubkey);
  if (remaining <= 0) return null;

  const tokensToGrant = Math.min(options.tokensToGrant, remaining);
  const now = Date.now();
  const nonce = generateTokenNonce();

  const tokenData: Omit<BudgetToken, "id" | "signature"> = {
    roomId: options.roomId,
    participantPubkey: options.participantPubkey,
    hostPubkey: options.hostPubkey,
    tokensGranted: tokensToGrant,
    issuedAt: now,
    expiresAt: now + BUDGET_TOKEN_TTL_MS,
    nonce,
  };

  const message = encodeBudgetTokenSigningMessage(tokenData);
  const sigBuffer = await crypto.subtle.sign("Ed25519", options.hostSigningKey, message);
  const signature = base64urlEncode(new Uint8Array(sigBuffer)) as BudgetToken["signature"];
  const id = generateTokenId();

  return { ...tokenData, id, signature };
}

export async function verifyAndConsumeToken(
  rawToken: unknown,
  hostPubkeyFromDoc: PublicKeyBase58,
  roomId: string
): Promise<number> {
  if (!isBudgetToken(rawToken)) {
    throw new FFError("BudgetTokenForged", "Received object is not a valid BudgetToken shape");
  }

  const token = rawToken as BudgetToken;
  if (token.roomId !== roomId) {
    throw new FFError("BudgetTokenForged", `Token roomId mismatch`);
  }

  const db = await getNonceDB();
  const alreadySeen = await isNonceSeen(db, roomId, token.hostPubkey, token.nonce);
  if (alreadySeen) {
    throw new FFError("BudgetTokenReplayed", "Token nonce already seen (persisted)");
  }

  const ephemeral = new Set<string>();
  const result = await verifyBudgetToken(token, {
    hostPubkeyFromDoc,
    seenNonces: ephemeral,
  });

  await markNonceSeen(db, roomId, token.hostPubkey, token.nonce, token.expiresAt);

  return result.tokensGranted;
}

const revokedDelegates = new Set<PublicKeyBase58>();

export function revokeSubBudgetDelegation(delegatePubkey: PublicKeyBase58): void {
  revokedDelegates.add(delegatePubkey);
}

export function isDelegationRevoked(delegatePubkey: PublicKeyBase58): boolean {
  return revokedDelegates.has(delegatePubkey);
}

export function isSubBudgetToken(obj: any): obj is SubBudgetToken {
  return (
    obj &&
    typeof obj.id === "string" &&
    typeof obj.roomId === "string" &&
    typeof obj.delegatePubkey === "string" &&
    typeof obj.hostPubkey === "string" &&
    typeof obj.tokensGranted === "number" &&
    typeof obj.issuedAt === "number" &&
    typeof obj.expiresAt === "number" &&
    typeof obj.nonce === "string" &&
    typeof obj.signature === "string"
  );
}

export async function mintSubBudgetTokenForRoom(
  hostSigningKey: CryptoKey,
  hostPubkey: PublicKeyBase58,
  delegatePubkey: PublicKeyBase58,
  roomId: RoomId,
  tokensToGrant: number
): Promise<SubBudgetToken> {
  const now = Date.now();
  const nonce = generateTokenNonce();
  const tokenData = {
    roomId,
    delegatePubkey,
    hostPubkey,
    tokensGranted: tokensToGrant,
    issuedAt: now,
    expiresAt: now + SUB_BUDGET_TOKEN_TTL_MS,
    nonce,
  };

  const sigBuffer = await crypto.subtle.sign(
    "Ed25519",
    hostSigningKey,
    encodeBudgetTokenSigningMessage({
      roomId: tokenData.roomId,
      participantPubkey: tokenData.delegatePubkey,
      hostPubkey: tokenData.hostPubkey,
      tokensGranted: tokenData.tokensGranted,
      issuedAt: tokenData.issuedAt,
      expiresAt: tokenData.expiresAt,
      nonce: tokenData.nonce,
    })
  );

  return {
    ...tokenData,
    id: generateTokenId(),
    signature: base64urlEncode(new Uint8Array(sigBuffer)) as SubBudgetToken["signature"],
  };
}

export async function verifyAndConsumeSubBudgetToken(
  rawToken: unknown,
  hostPubkeyFromDoc: PublicKeyBase58,
  roomId: string
): Promise<number> {
  if (!isSubBudgetToken(rawToken)) {
    throw new FFError("SubBudgetTokenForged", "Received object is not a valid SubBudgetToken shape");
  }

  const token = rawToken as SubBudgetToken;
  if (token.roomId !== roomId) throw new FFError("SubBudgetTokenForged", "roomId mismatch");
  if (token.hostPubkey !== hostPubkeyFromDoc) throw new FFError("SubBudgetTokenForged", "Host pubkey mismatch");
  if (revokedDelegates.has(token.delegatePubkey)) throw new FFError("SubBudgetTokenRevoked", "Delegation revoked");
  if (Date.now() > token.expiresAt) throw new FFError("SubBudgetTokenExpired", "Token expired");

  const db = await getNonceDB();
  const alreadySeen = await isNonceSeen(db, roomId, token.hostPubkey, token.nonce);
  if (alreadySeen) {
    throw new FFError("SubBudgetTokenReplayed", "Token nonce already seen (persisted)");
  }

  const message = encodeBudgetTokenSigningMessage({
    roomId: token.roomId,
    participantPubkey: token.delegatePubkey,
    hostPubkey: token.hostPubkey,
    tokensGranted: token.tokensGranted,
    issuedAt: token.issuedAt,
    expiresAt: token.expiresAt,
    nonce: token.nonce,
  });

  const sigBytes = base64urlDecode(token.signature);
  let pubKeyBytes: Uint8Array;
  try {
    pubKeyBytes = fromBase58(token.hostPubkey);
  } catch {
    throw new FFError("SubBudgetTokenForged", "Invalid base58 encoding in host pubkey");
  }

  if (pubKeyBytes.length !== 32) throw new FFError("SubBudgetTokenForged", "Invalid public key length");

  const pubKey = await crypto.subtle.importKey("raw", pubKeyBytes, { name: "Ed25519" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("Ed25519", pubKey, sigBytes, message);
  if (!valid) throw new FFError("SubBudgetTokenForged", "Signature verification failed");

  await markNonceSeen(db, roomId, token.hostPubkey, token.nonce, token.expiresAt);

  return token.tokensGranted;
}

export function getFuelGaugeState(roomId: string): FuelGaugeState {
  const state = quotaState.get(roomId);
  if (!state) return { roomId, participants: [] };

  const participants: FuelGaugeState["participants"] = [];
  const seen = new Set<PublicKeyBase58>();
  const prefix = `${roomId}|`;

  for (const [pubkey, consumed] of state.consumed) {
    seen.add(pubkey);
    const reserved = quotaReservations.get(reservationKey(roomId, pubkey)) ?? 0;
    participants.push({
      pubkey,
      consumed,
      reserved,
      quota: state.quotaPerUser,
      fraction: Math.max(0, 1 - (consumed + reserved) / state.quotaPerUser),
    });
  }

  for (const key of quotaReservations.keys()) {
    if (!key.startsWith(prefix)) continue;
    const pubkey = key.slice(prefix.length) as PublicKeyBase58;
    if (seen.has(pubkey)) continue;
    seen.add(pubkey);
    const reserved = quotaReservations.get(key) ?? 0;
    participants.push({
      pubkey,
      consumed: 0,
      reserved,
      quota: state.quotaPerUser,
      fraction: Math.max(0, 1 - reserved / state.quotaPerUser),
    });
  }

  return { roomId, participants };
}

export async function teardownBudget(): Promise<void> {
  quotaState.clear();
  quotaReservations.clear();
  revokedDelegates.clear();

  try {
    const db = await getNonceDB();
    await sweepExpiredNonces(db);
  } catch {
    /* ignore */
  }
}
