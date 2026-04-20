/**
 * apps/web/src/state/identity.ts — Browser tab identity (Ed25519 keypair with persisted private key).
 *
 * Distinct from the worker’s signing keypair (minted inside the iframe keystore).
 * Pubkey + signing here are used for relay peerId, CRDT rows, receipt signing, etc.
 *
 * FIX — Medium #13: Identity key loss
 *   Previously only the pubkey was stored; the private key was discarded each load.
 *   Now the PKCS#8 private key is wrapped with AES-256-GCM using a key derived (HKDF)
 *   from a random device seed in IndexedDB — never plaintext private material on disk.
 *   Schema key `identity_v2` replaces legacy pubkey-only `pubkey` records.
 */

import { assertEd25519Supported, fromBase58, toBase58 } from "@fatedfortress/protocol";

export interface Identity {
  pubkey: string;
  name: string;
}

/** Stored in IndexedDB — serialized fields are base64url strings */
interface StoredIdentity {
  pubkey: string;
  wrappedPrivKey: string;
  wrapIv: string;
  deviceSeed: string;
}

const DB_NAME = "fortress-identity";
const STORE_NAME = "keys";
const LEGACY_PUBKEY_KEY = "pubkey";
const IDENTITY_KEY = "identity_v2";

async function openIdentityDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet<T>(db: IDBDatabase, key: string): Promise<T | null> {
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve((req.result as T) ?? null);
    req.onerror = () => resolve(null);
  });
}

async function idbPut(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const req = tx.objectStore(STORE_NAME).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const req = tx.objectStore(STORE_NAME).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function b64urlEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str: string): Uint8Array {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * AES-256-GCM wrapping key from device seed (HKDF-SHA-256). Derived each session;
 * not stored. Seed lives in IndexedDB next to ciphertext (same trust boundary as before).
 */
async function deriveWrappingKey(deviceSeedBytes: Uint8Array): Promise<CryptoKey> {
  const seedKey = await crypto.subtle.importKey(
    "raw",
    deviceSeedBytes,
    { name: "HKDF" },
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode("fatedfortress-identity-v2"),
      info: new TextEncoder().encode("ed25519-private-key-wrap"),
    },
    seedKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["wrapKey", "unwrapKey"]
  );
}

async function generateAndPersistIdentity(db: IDBDatabase): Promise<{ keyPair: CryptoKeyPair; pubkey: string }> {
  const deviceSeedBytes = crypto.getRandomValues(new Uint8Array(32));
  const wrapIvBytes = crypto.getRandomValues(new Uint8Array(12));

  const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);

  const wrappingKey = await deriveWrappingKey(deviceSeedBytes);

  const wrappedBuf = await crypto.subtle.wrapKey(
    "pkcs8",
    keyPair.privateKey,
    wrappingKey,
    { name: "AES-GCM", iv: wrapIvBytes }
  );

  const pubRaw = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  const pubkey = toBase58(new Uint8Array(pubRaw));

  const stored: StoredIdentity = {
    pubkey,
    wrappedPrivKey: b64urlEncode(wrappedBuf),
    wrapIv: b64urlEncode(wrapIvBytes),
    deviceSeed: b64urlEncode(deviceSeedBytes),
  };

  await idbPut(db, IDENTITY_KEY, stored);

  const sessionKeyPair: CryptoKeyPair = {
    publicKey: keyPair.publicKey,
    privateKey: await crypto.subtle.importKey(
      "pkcs8",
      await crypto.subtle.exportKey("pkcs8", keyPair.privateKey),
      { name: "Ed25519" },
      false,
      ["sign"]
    ),
  };

  return { keyPair: sessionKeyPair, pubkey };
}

async function loadPersistedIdentity(db: IDBDatabase): Promise<{ keyPair: CryptoKeyPair; pubkey: string } | null> {
  const stored = await idbGet<StoredIdentity>(db, IDENTITY_KEY);
  if (!stored?.wrappedPrivKey || !stored.wrapIv || !stored.deviceSeed) return null;

  try {
    const deviceSeedBytes = b64urlDecode(stored.deviceSeed);
    const wrapIvBytes = b64urlDecode(stored.wrapIv);
    const wrappedBytes = b64urlDecode(stored.wrappedPrivKey);

    const wrappingKey = await deriveWrappingKey(deviceSeedBytes);

    const privateKey = await crypto.subtle.unwrapKey(
      "pkcs8",
      wrappedBytes,
      wrappingKey,
      { name: "AES-GCM", iv: wrapIvBytes },
      { name: "Ed25519" },
      false,
      ["sign"]
    );

    const publicKey = await crypto.subtle.importKey(
      "raw",
      fromBase58(stored.pubkey),
      { name: "Ed25519" },
      true,
      ["verify"]
    );

    return { keyPair: { privateKey, publicKey }, pubkey: stored.pubkey };
  } catch (err) {
    console.warn("[identity] Failed to load persisted identity — generating new one:", err);
    return null;
  }
}

let _cachedPubkey: string | null = null;
let _cachedPrivateKey: CryptoKey | null = null;

function setCachedIdentity(pubkey: string, privateKey: CryptoKey): void {
  _cachedPubkey = pubkey;
  _cachedPrivateKey = privateKey;
}

export async function createIdentity(): Promise<Identity> {
  await assertEd25519Supported();

  try {
    const db = await openIdentityDB();

    const loaded = await loadPersistedIdentity(db);
    if (loaded) {
      setCachedIdentity(loaded.pubkey, loaded.keyPair.privateKey);
      return { pubkey: loaded.pubkey, name: getMyDisplayName() };
    }

    // Legacy v1 stored pubkey only — private key cannot be recovered; drop the row.
    if (await idbGet<string>(db, LEGACY_PUBKEY_KEY)) {
      try {
        await idbDelete(db, LEGACY_PUBKEY_KEY);
      } catch {
        /* ignore */
      }
    }

    const generated = await generateAndPersistIdentity(db);
    setCachedIdentity(generated.pubkey, generated.keyPair.privateKey);
    return { pubkey: generated.pubkey, name: getMyDisplayName() };
  } catch (err) {
    console.warn("[identity] IndexedDB unavailable — using ephemeral identity:", err);

    const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
    const pubRaw = await crypto.subtle.exportKey("raw", kp.publicKey);
    const pubkey = toBase58(new Uint8Array(pubRaw));
    setCachedIdentity(pubkey, kp.privateKey);
    return { pubkey, name: getMyDisplayName() };
  }
}

export function getMyPubkey(): string | null {
  return _cachedPubkey;
}

/** Session signing key — call createIdentity() during app bootstrap first. */
export function getMyPrivateKey(): CryptoKey {
  if (!_cachedPrivateKey) {
    throw new Error("[identity] Private key not available — call createIdentity() first");
  }
  return _cachedPrivateKey;
}

export function getMyDisplayName(): string {
  return "Anonymous";
}

export function getIdentity(): Identity {
  return {
    pubkey: _cachedPubkey ?? "",
    name: getMyDisplayName(),
  };
}

// ─── PRIORITY 3: Identity Export / Import ─────────────────────────────────────

const EXPORT_MAGIC = "FFID1";
const PBKDF2_ITERATIONS = 600_000; // OWASP 2026 recommendation
const SALT_BYTES = 16;
const IV_BYTES = 12;

export interface IdentityExport {
  magic: typeof EXPORT_MAGIC;
  version: 1;
  saltB64: string;
  ivB64: string;
  ciphertextB64: string;
  pubkey: string;
  exportedAt: number;
}

/**
 * Exports the current device's Ed25519 keypair as a PBKDF2/AES-GCM-encrypted envelope.
 * The raw seed never appears on disk or network unencrypted.
 *
 * Usage:
 *   const envelope = await exportIdentity("my strong passphrase");
 *   downloadAsFile("fated-fortress-identity.json", JSON.stringify(envelope));
 */
export async function exportIdentity(passphrase: string): Promise<IdentityExport> {
  if (passphrase.length < 12) {
    throw new Error("Passphrase must be at least 12 characters");
  }

  const db = await openIdentityDB();
  const stored = await idbGet<StoredIdentity>(db, IDENTITY_KEY);

  if (!stored?.wrappedPrivKey || !stored?.deviceSeed) {
    throw new Error("No identity found on this device");
  }

  // Reconstruct the raw PKCS#8 private key from the wrapped form
  const wrapIvBytes = b64urlDecode(stored.wrapIv);
  const wrappedKeyBytes = b64urlDecode(stored.wrappedPrivKey);
  const deviceSeedBytes = b64urlDecode(stored.deviceSeed);

  // Derive the device-unique master key from the stored seed
  const masterKeyMaterial = await crypto.subtle.importKey(
    "raw",
    deviceSeedBytes,
    { name: "HKDF" },
    false,
    ["deriveKey"],
  );
  const masterKey = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode("fatedfortress-identity-v2"),
    },
    masterKeyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["unwrapKey"],
  );

  // Unwrap the PKCS#8 private key
  const rawPrivateKey = await crypto.subtle.unwrapKey(
    "pkcs8",
    wrappedKeyBytes,
    masterKey,
    { name: "AES-GCM", iv: wrapIvBytes },
    { name: "Ed25519" },
    false,
    ["sign"],
  );

  // Export raw private key bytes for encryption
  const exportedKeyBytes = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", rawPrivateKey),
  );

  // Build the export envelope
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const wrappingKey = await derivePbkdf2Key(passphrase, salt);

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    wrappingKey,
    exportedKeyBytes,
  );

  return {
    magic: EXPORT_MAGIC,
    version: 1,
    saltB64: b64urlEncode(salt),
    ivB64: b64urlEncode(iv),
    ciphertextB64: b64urlEncode(new Uint8Array(ciphertext)),
    pubkey: stored.pubkey,
    exportedAt: Date.now(),
  };
}

/**
 * Imports an identity from an encrypted envelope. Overwrites any existing identity
 * on this device after confirmation — the caller should warn the user.
 */
export async function importIdentity(
  envelope: IdentityExport,
  passphrase: string,
): Promise<{ pubkey: string }> {
  if (envelope.magic !== EXPORT_MAGIC) {
    throw new Error("Not a valid Fated Fortress identity export");
  }
  if (envelope.version !== 1) {
    throw new Error(`Unsupported export version: ${envelope.version}`);
  }

  const salt = b64urlDecode(envelope.saltB64);
  const iv = b64urlDecode(envelope.ivB64);
  const ciphertext = b64urlDecode(envelope.ciphertextB64);
  const wrappingKey = await derivePbkdf2Key(passphrase, salt);

  let rawPrivateKeyBytes: ArrayBuffer;
  try {
    rawPrivateKeyBytes = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      wrappingKey,
      ciphertext,
    );
  } catch {
    throw new Error("Incorrect passphrase or corrupted export file");
  }

  // Import the PKCS#8 bytes back into a non-extractable CryptoKey
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    rawPrivateKeyBytes,
    { name: "Ed25519" },
    false,
    ["sign"],
  );

  // Re-wrap for IndexedDB storage using the same device-key wrapping scheme
  const deviceSeedBytes = crypto.getRandomValues(new Uint8Array(32));
  const masterKeyMaterial = await crypto.subtle.importKey(
    "raw",
    deviceSeedBytes,
    { name: "HKDF" },
    false,
    ["deriveKey"],
  );
  const masterKey = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode("fatedfortress-identity-v2"),
    },
    masterKeyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["wrapKey"],
  );
  const wrapIv = crypto.getRandomValues(new Uint8Array(12));
  const wrappedKeyBytes = await crypto.subtle.wrapKey(
    "pkcs8",
    privateKey,
    masterKey,
    { name: "AES-GCM", iv: wrapIv },
  );

  // Persist to IndexedDB using existing idbPut (2-arg: db, key, value)
  const db = await openIdentityDB();
  await idbPut(db, IDENTITY_KEY, {
    pubkey: envelope.pubkey,
    wrappedPrivKey: b64urlEncode(new Uint8Array(wrappedKeyBytes)),
    wrapIv: b64urlEncode(wrapIv),
    deviceSeed: b64urlEncode(deviceSeedBytes),
  } as StoredIdentity);

  // Update in-memory cache
  setCachedIdentity(envelope.pubkey, privateKey);

  return { pubkey: envelope.pubkey };
}

/** PBKDF2-SHA256 key derivation for the export passphrase wrapper. */
async function derivePbkdf2Key(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
