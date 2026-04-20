/**
 * ydoc.ts — Y.js CRDT document factory for FatedFortress rooms.
 *
 * SCHEMA IS IMMUTABLE after v1 ships. New fields are ADDITIVE ONLY.
 * See schema-migrations.ts for forward-compatibility rules.
 *
 * TYPE SELECTION RATIONALE (do not change without full review):
 *   Y.Map    — room metadata: single logical owner, key-value fields
 *   Y.Map    — participants: keyed by pubkey (Phase 5 L12 — replaces unsafe Y.Array delete/insert races)
 *   Y.Array  — receipts, templates: append-only, concurrent-safe
 *   Y.Text   — output stream: character-level concurrent edits for streaming
 *   Y.Map<V> — presence: each peer owns exactly one entry keyed by pubkey
 *
 * Wrong type choices produce irreconcilable merge conflicts under concurrent
 * edits and cannot be migrated without invalidating all existing room docs.
 */

import * as Y from "yjs";
import type {
  PublicKeyBase58,
  RoomId,
  ReceiptId,
  RoomCategory,
  RoomAccess,
  RoomRole,
} from "@fatedfortress/protocol";
import { getMyPubkey } from "./identity.js";

/** Canonical participant store (pubkey → entry). */
const PARTICIPANT_MAP_KEY = "participantMap";
/** Legacy v0 — migrated once into participantMap (see migrateParticipantsFromLegacy). */
const LEGACY_PARTICIPANTS_KEY = "participants";

export interface RoomMeta {
  id: RoomId;
  name: string;
  description: string;
  category: RoomCategory;
  access: RoomAccess;
  /** USDC price — null for free rooms */
  price: number | null;
  currency: "USDC" | null;
  systemPrompt: string;
  createdAt: number;
  schemaVersion: 1;
  /** Timestamp when room was upgraded from spectator to full room, null if not upgraded */
  upgradedAt: number | null;
  /** Public key of the active host (may differ from original hostPubkey during handoff) */
  activeHostPubkey: PublicKeyBase58;
}

export interface ParticipantEntry {
  pubkey: PublicKeyBase58;
  name: string;
  joinedAt: number;
  contributesKey: boolean;
  /** Tokens per user per hour if contributing key, null otherwise */
  quotaPerUser: number | null;
  /** Whether this participant is spectating (read-only, no API key contribution) */
  isSpectator?: boolean;
  /** Official roles assigned to this participant */
  roles?: RoomRole[];
}

export interface PresenceEntry {
  pubkey: PublicKeyBase58;
  name: string;
  /** Cursor position in the output pane as character offset, null if not focused */
  cursorOffset: number | null;
  lastSeenAt: number;
  /** Whether this presence entry belongs to a spectator */
  isSpectator?: boolean;
}

export interface SpectatorMessage {
  id: string;
  pubkey: PublicKeyBase58;
  displayName: string;
  text: string;
  ts: number;
}

export interface FortressRoomDoc {
  meta: Y.Map<RoomMeta[keyof RoomMeta]>;
  participants: Y.Map<ParticipantEntry>;
  output: Y.Text;
  receiptIds: Y.Array<ReceiptId>;
  templates: Y.Array<string>;
  presence: Y.Map<PresenceEntry>;
  /** Chat messages among spectators in a room */
  spectatorChat: Y.Array<SpectatorMessage>;
  /** The raw Y.Doc — for transport (y-webrtc) and persistence (OPFS/IndexedDB) */
  doc: Y.Doc;
}

export function createRoomDoc(initialMeta?: Partial<RoomMeta>): FortressRoomDoc {
  const doc = new Y.Doc();

  const meta         = doc.getMap<RoomMeta[keyof RoomMeta]>("meta");
  const participants = doc.getMap<ParticipantEntry>(PARTICIPANT_MAP_KEY); // not LEGACY_PARTICIPANTS_KEY
  const output       = doc.getText("output");
  const receiptIds   = doc.getArray<ReceiptId>("receiptIds");
  const templates    = doc.getArray<string>("templates");
  const presence     = doc.getMap<PresenceEntry>("presence");
  const spectatorChat = doc.getArray<SpectatorMessage>("spectatorChat");

  if (initialMeta) {
    doc.transact(() => {
      meta.set("id", initialMeta.id ?? (`rm_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}` as RoomId));
      meta.set("name", initialMeta.name ?? "Untitled Room");
      meta.set("description", initialMeta.description ?? "");
      meta.set("category", initialMeta.category ?? "general");
      meta.set("access", initialMeta.access ?? "free");
      meta.set("price", initialMeta.price ?? null);
      meta.set("currency", initialMeta.currency ?? null);
      meta.set("systemPrompt", initialMeta.systemPrompt ?? "");
      meta.set("createdAt", initialMeta.createdAt ?? Date.now());
      meta.set("schemaVersion", 1);
      meta.set("upgradedAt", null);
      meta.set("activeHostPubkey", initialMeta.activeHostPubkey ?? ("" as PublicKeyBase58));
    });
  }

  return { meta, participants, output, receiptIds, templates, presence, spectatorChat, doc };
}

export const getRoomId     = (r: FortressRoomDoc): RoomId      => r.meta.get("id")     as RoomId;
export const getRoomName   = (r: FortressRoomDoc): string       => (r.meta.get("name")  as string) ?? "Untitled Room";
export const getRoomAccess = (r: FortressRoomDoc): RoomAccess   => (r.meta.get("access") as RoomAccess) ?? "free";
export const getRoomPrice  = (r: FortressRoomDoc): number|null  => (r.meta.get("price") as number|null) ?? null;
export const getCategory   = (r: FortressRoomDoc): RoomCategory => (r.meta.get("category") as RoomCategory) ?? "general";
export const getSystemPrompt = (r: FortressRoomDoc): string     => (r.meta.get("systemPrompt") as string) ?? "";
export const getCreatedAt  = (r: FortressRoomDoc): number       => (r.meta.get("createdAt") as number) ?? 0;
export const getOutputText = (r: FortressRoomDoc): string       => r.output.toString();
export const getReceiptIds = (r: FortressRoomDoc): ReceiptId[]  => r.receiptIds.toArray();
export const getTemplates  = (r: FortressRoomDoc): string[]     => r.templates.toArray();
export const getPresence   = (r: FortressRoomDoc): PresenceEntry[] => Array.from(r.presence.values());
export const getParticipants = (r: FortressRoomDoc): ParticipantEntry[] => {
  migrateParticipantsFromLegacy(r); // OPFS/remote may still carry legacy array ops
  return Array.from(r.participants.values()).sort((a, b) => a.joinedAt - b.joinedAt);
};

export function setMeta(
  room: FortressRoomDoc,
  patch: Partial<Omit<RoomMeta, "id" | "createdAt" | "schemaVersion">>
): void {
  room.doc.transact(() => {
    for (const k in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) {
        room.meta.set(k, patch[k as keyof typeof patch] as RoomMeta[keyof RoomMeta]);
      }
    }
  });
}

export function appendOutput(room: FortressRoomDoc, chunk: string): void {
  room.doc.transact(() => {
    room.output.insert(room.output.length, chunk);
  });
}

export function clearOutput(room: FortressRoomDoc): void {
  room.doc.transact(() => {
    if (room.output.length > 0) {
      room.output.delete(0, room.output.length);
    }
  });
}

export function addReceiptId(room: FortressRoomDoc, id: ReceiptId): void {
  room.doc.transact(() => {
    room.receiptIds.push([id]);
  });
}

export function addTemplate(room: FortressRoomDoc, template: string): void {
  room.doc.transact(() => {
    room.templates.push([template]);
  });
}

/**
 * Upserts a presence entry for a peer.
 * Each peer is the sole writer for their own presence entry (keyed by pubkey).
 * Concurrent writes from different peers never conflict — different keys.
 */
export function upsertPresence(room: FortressRoomDoc, entry: PresenceEntry): void {
  room.doc.transact(() => {
    room.presence.set(entry.pubkey, { ...entry, lastSeenAt: Date.now() });
  });
}

export function removePresence(room: FortressRoomDoc, pubkey: PublicKeyBase58): void {
  room.doc.transact(() => {
    room.presence.delete(pubkey);
  });
}

/**
 * Returns the currently active room doc, creating one if it doesn't exist.
 * In a multi-room app this would be keyed by roomId; for now we maintain
 * a single active doc in memory.
 */
let _activeRoomDoc: FortressRoomDoc | null = null;

export function getActiveRoomDoc(roomId: RoomId): FortressRoomDoc {
  if (!_activeRoomDoc || getRoomId(_activeRoomDoc) !== roomId) {
    _activeRoomDoc = createRoomDoc({ id: roomId });
  }
  return _activeRoomDoc;
}

export function setActiveRoomDoc(doc: FortressRoomDoc): void {
  _activeRoomDoc = doc;
}

/** Returns the active room doc without requiring a roomId — returns null if none is set */
export function getActiveRoomDocIfSet(): FortressRoomDoc | null {
  return _activeRoomDoc;
}

/**
 * Returns the joinedAt timestamp for the current user, or Date.now() if not found.
 */
export function getMyJoinedAt(doc: FortressRoomDoc): number {
  const myPubkey = getMyPubkey();
  if (!myPubkey) return Date.now();
  migrateParticipantsFromLegacy(doc);
  const participant = doc.participants.get(myPubkey as PublicKeyBase58);
  return participant?.joinedAt ?? Date.now();
}

/**
 * One-time copy from legacy Y.Array("participants") → Y.Map(participantMap), then clear the array.
 * Safe if multiple peers run concurrently — set-by-pubkey is last-write-wins per key.
 */
export function migrateParticipantsFromLegacy(room: FortressRoomDoc): void {
  const legacy = room.doc.getArray<ParticipantEntry>(LEGACY_PARTICIPANTS_KEY);
  if (legacy.length === 0) return;
  room.doc.transact(() => {
    for (const entry of legacy.toArray()) {
      const k = entry.pubkey as string;
      if (!room.participants.has(k)) {
        room.participants.set(k, entry); // first writer wins if races with another replica
      }
    }
    legacy.delete(0, legacy.length); // stop replaying duplicate array inserts on sync
  });
}

/**
 * Adds a participant. Idempotent — one entry per pubkey (Y.Map last-write-wins).
 */
export function addParticipant(room: FortressRoomDoc, participant: ParticipantEntry): void {
  migrateParticipantsFromLegacy(room);
  room.doc.transact(() => {
    const k = participant.pubkey as string;
    if (!room.participants.has(k)) {
      room.participants.set(k, participant);
    }
  });
}

/**
 * Updates an existing participant's fields. Merge-safe per pubkey.
 */
export function updateParticipant(room: FortressRoomDoc, pubkey: string, patch: Partial<ParticipantEntry>): void {
  migrateParticipantsFromLegacy(room);
  room.doc.transact(() => {
    const existing = room.participants.get(pubkey as PublicKeyBase58);
    if (!existing) return;
    room.participants.set(pubkey as PublicKeyBase58, { ...existing, ...patch } as ParticipantEntry);
  });
}

/** Serializes the full doc state as a binary update for transport/storage */
export function serializeDoc(room: FortressRoomDoc): Uint8Array {
  return Y.encodeStateAsUpdate(room.doc);
}

/**
 * Hydrates a FortressRoomDoc from a binary update.
 * Used in fork flow: fetch(here.now url) → hydrateDoc(bytes)
 */
export function hydrateDoc(update: Uint8Array): FortressRoomDoc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  const fortress: FortressRoomDoc = {
    meta:          doc.getMap("meta"),
    participants:  doc.getMap<ParticipantEntry>(PARTICIPANT_MAP_KEY),
    output:        doc.getText("output"),
    receiptIds:    doc.getArray("receiptIds"),
    templates:     doc.getArray("templates"),
    presence:      doc.getMap("presence"),
    spectatorChat: doc.getArray<SpectatorMessage>("spectatorChat"),
    doc,
  };
  migrateParticipantsFromLegacy(fortress);
  return fortress;
}

/**
 * Merges a remote update into an existing doc (used by y-webrtc peer sync).
 * Y.js guarantees this is conflict-free regardless of application order.
 */
export function applyRemoteUpdate(room: FortressRoomDoc, update: Uint8Array): void {
  Y.applyUpdate(room.doc, update);
  migrateParticipantsFromLegacy(room); // peer may still emit old "participants" array CRDT ops
}
