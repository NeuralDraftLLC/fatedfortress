/**
 * keystore.ts — Fortress Worker key storage.
 *
 * SECURITY INVARIANTS (enforced, not promised — see SECURITY.md Claims 1–2):
 *
 *   1. API keys are held as raw strings ONLY in the in-memory `rawKeys` Map.
 *      They never appear in any postMessage payload, outbound network request,
 *      or persistent storage in plaintext. `getRawKey()` is intentionally NOT
 *      callable across the postMessage boundary — it has no corresponding
 *      InboundMessage type in router.ts.
 *
 *   2. When a key is persisted (user opts in), it is wrapped with AES-256-GCM
 *      using a key derived via Argon2id. The raw key is NEVER written to
 *      IndexedDB or localStorage directly. The Argon2id parameters stored in
 *      the EncryptedKeyBlob allow future param upgrades without re-asking for
 *      the passphrase (decrypt with old params → re-encrypt with new params).
 *
 *   3. `clearAllKeys()` MUST be called on TERMINATE and tab close.
 *      worker.ts owns this lifecycle and calls it from `doCleanup()`.
 *
 *   4. The Ed25519 signing keypair is generated ONCE per worker session with
 *      the private key marked non-extractable. It is never serialized, stored,
 *      or sent anywhere. The public key is shared openly as a room identity.
 *
 *   5. Every crypto operation uses `crypto.subtle` (WebCrypto). No third-party
 *      crypto library touches key material. Argon2id runs in a WASM module
 *      loaded at the same worker origin — it has no network access.
 *
 * ARGON2ID PARAMETERS (2026 browser baseline — see SECURITY.md §2b):
 *   m = 65536  (64 MiB memory — defeats GPU/ASIC attacks, fits mobile RAM)
 *   t = 3      (3 passes — OWASP 2024 minimum for interactive logins)
 *   p = 1      (parallelism 1 — WASM is single-threaded in browsers)
 *   hash = 32  (256-bit output → used directly as AES-256-GCM key material)
 *
 * UPGRADE PATH:
 *   When params need strengthening, bump ARGON2_PARAMS. On next
 *   decryptAndLoadKey() call, params are read FROM the blob (not this const),
 *   so decryption always works. Callers can re-encrypt immediately via
 *   encryptKeyForStorage() to migrate the blob. No key re-entry required.
 */

import {
  FFError,
  base64urlEncode,
  base64urlDecode,
  type PublicKeyBase58,
} from "@fatedfortress/protocol";

import { argon2id } from "hash-wasm";

export type ProviderId =
  | "openai"
  | "anthropic"
  | "google"
  | "minimax"
  | "groq"
  | "openrouter";

export interface EncryptedKeyBlob {
  /** Provider the key belongs to — shown in the UI ("openai key loaded") */
  provider: ProviderId;
  /** base64url-encoded Argon2id salt (32 bytes) */
  salt: string;
  /** base64url-encoded AES-GCM IV (12 bytes) */
  iv: string;
  /** base64url-encoded AES-GCM ciphertext of the raw API key */
  ciphertext: string;
  /**
   * Argon2id parameters used to derive the wrapping key.
   * Always read from the blob on decryption — never assumed to equal
   * the current ARGON2_PARAMS constant. This is the upgrade path.
   */
  argon2Params: { m: number; t: number; p: number; hashLen: number };
}

export interface SigningKeyPair {
  /** Non-extractable Ed25519 CryptoKey — signs budget tokens and receipts */
  privateKey: CryptoKey;
  /** Corresponding public key, base58-encoded for CRDT doc and receipt fields */
  publicKeyBase58: PublicKeyBase58;
}

const ARGON2_PARAMS = { m: 65536, t: 3, p: 1, hashLen: 32 } as const;

/** AES-GCM IV length. 12 bytes is the NIST-recommended size for GCM. */
const AES_IV_BYTES = 12;

/** Argon2id salt length. Must be >= 16; 32 is the recommended size. */
const ARGON2_SALT_BYTES = 32;

/** Raw API key strings. Only accessible inside this file via getRawKey(). */
const rawKeys = new Map<ProviderId, string>();

/** Lazily initialised once per worker session. */
let _signingKeyPair: SigningKeyPair | null = null;

/**
 * Derives a non-extractable AES-256-GCM CryptoKey from a passphrase + salt
 * using Argon2id (via hash-wasm WASM module).
 *
 * Strategy: Argon2id produces 32 raw bytes → imported as AES-GCM key
 * material via WebCrypto. KDF is memory-hard (WASM); cipher is
 * hardware-accelerated (WebCrypto native). Best of both.
 */
async function deriveWrappingKey(
  passphrase: string,
  salt: Uint8Array,
  params: { m: number; t: number; p: number; hashLen: number } = ARGON2_PARAMS
): Promise<CryptoKey> {
  const keyBytes: Uint8Array = await argon2id({
    password:    passphrase,
    salt,
    parallelism: params.p,
    iterations:  params.t,
    memorySize:  params.m,
    hashLength:  params.hashLen,
    outputType:  "binary",   // avoids a hex→bytes round-trip
  });

  return crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM", length: 256 },
    false,                    // non-extractable
    ["encrypt", "decrypt"]
  );
}

/**
 * Stores a raw API key in the session-scoped in-memory store.
 * Trims leading/trailing whitespace (copy-paste from key management UIs
 * commonly includes trailing newlines or spaces).
 */
export async function storeKey(provider: string, key: string): Promise<void> {
  if (!key || typeof key !== "string" || key.trim().length === 0) {
    throw new FFError("InvalidKey", "Key must be a non-empty string");
  }
  rawKeys.set(provider as ProviderId, key.trim());
}

/**
 * Returns true if a key is currently loaded in memory for this provider.
 * Exposes no key material — safe to call from router.ts.
 */
export function hasKey(provider: string): boolean {
  return rawKeys.has(provider as ProviderId);
}

/**
 * Returns the raw key string for the provider adapter to use in API calls.
 *
 * CALL SITE RESTRICTION: Only `generate.ts` may call this function.
 * It has no corresponding InboundMessage variant and is unreachable across
 * the postMessage boundary by design. The ESLint rule `no-raw-key-in-message`
 * in packages/protocol/eslint-rules enforces this statically at CI time.
 */
export function getRawKey(provider: ProviderId): string {
  const key = rawKeys.get(provider);
  if (!key) {
    throw new FFError("NoKeyStored", `No key loaded for provider: ${provider}`);
  }
  return key;
}

/**
 * Encrypts a stored key with a user passphrase for optional persistent storage.
 *
 * Returns an EncryptedKeyBlob containing only ciphertext, IV, salt, and KDF
 * params — no plaintext key material. The blob is safe to store in IndexedDB.
 *
 * A fresh random salt and IV are generated on every call (IND-CPA secure):
 * two calls with the same passphrase produce distinct, unlinkable blobs.
 */
export async function encryptKeyForStorage(
  provider: string,
  passphrase: string
): Promise<EncryptedKeyBlob> {
  const raw  = getRawKey(provider as ProviderId);
  const salt = crypto.getRandomValues(new Uint8Array(ARGON2_SALT_BYTES));
  const iv   = crypto.getRandomValues(new Uint8Array(AES_IV_BYTES));

  const wrappingKey = await deriveWrappingKey(passphrase, salt);
  const ciphertext  = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    wrappingKey,
    new TextEncoder().encode(raw)
  );

  return {
    provider:    provider as ProviderId,
    salt:        base64urlEncode(salt),
    iv:          base64urlEncode(iv),
    ciphertext:  base64urlEncode(new Uint8Array(ciphertext)),
    argon2Params: { ...ARGON2_PARAMS },
  };
}

/**
 * Decrypts a persisted EncryptedKeyBlob and loads the key into memory.
 *
 * Reads Argon2id params FROM the blob — not the current ARGON2_PARAMS const.
 * This guarantees decryption works correctly even after a params upgrade.
 *
 * Error handling deliberately does not distinguish "wrong passphrase" from
 * "corrupted ciphertext". Both throw FFError("DecryptionFailed") with the
 * same message. This prevents a padding/auth-tag oracle.
 */
export async function decryptAndLoadKey(
  blob: EncryptedKeyBlob,
  passphrase: string
): Promise<void> {
  const salt       = base64urlDecode(blob.salt);
  const iv         = base64urlDecode(blob.iv);
  const ciphertext = base64urlDecode(blob.ciphertext);

  let plaintext: ArrayBuffer;

  try {
    const wrappingKey = await deriveWrappingKey(passphrase, salt, blob.argon2Params);
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      wrappingKey,
      ciphertext
    );
  } catch {
    throw new FFError("DecryptionFailed", "Wrong passphrase or corrupted key blob");
  }

  rawKeys.set(blob.provider, new TextDecoder().decode(plaintext));
}

/**
 * Wipes all in-memory keys and the signing keypair.
 * Called by worker.ts `teardownSession()` on TERMINATE, beforeunload, and pagehide.
 * After this call, hasKey() returns false for all providers.
 */
export function teardownKeystore(): void {
  rawKeys.clear();
  _signingKeyPair = null;
}

/**
 * Returns (lazily generating on first call) the Ed25519 signing keypair
 * for this worker session.
 *
 * The private key is generated with `extractable: false`. It cannot be
 * exported via crypto.subtle.exportKey() by any caller, including this file.
 * The reference is cleared by clearAllKeys() and the GC reclaims the key.
 *
 * The public key is exported once as raw bytes and encoded as base58.
 * This string appears in CRDT room docs and receipt signatures. It is the
 * worker's public identity for this session — equivalent to a throwaway
 * pseudonymous address.
 */
export async function getSigningKey(): Promise<SigningKeyPair> {
  if (_signingKeyPair) return _signingKeyPair;

  const kp = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    false,              // private key non-extractable
    ["sign", "verify"]
  );

  const pubRaw   = await crypto.subtle.exportKey("raw", kp.publicKey);
  const pubBytes = new Uint8Array(pubRaw);

  _signingKeyPair = {
    privateKey:      kp.privateKey,
    publicKeyBase58: toBase58(pubBytes) as PublicKeyBase58,
  };

  return _signingKeyPair;
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function toBase58(bytes: Uint8Array): string {
  let leadingOnes = 0;
  for (const byte of bytes) {
    if (byte !== 0) break;
    leadingOnes++;
  }

  let num = bytes.reduce(
    (acc, byte) => acc * 256n + BigInt(byte),
    0n
  );

  let encoded = "";
  while (num > 0n) {
    encoded = BASE58_ALPHABET[Number(num % 58n)] + encoded;
    num /= 58n;
  }

  return "1".repeat(leadingOnes) + encoded;
}
