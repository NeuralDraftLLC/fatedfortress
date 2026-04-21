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
  Modality,
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
  /** Whether participants may contribute API keys (community-key mode) */
  allowCommunityKeys: boolean;
  /** Timestamp of the last allowCommunityKeys policy change — resets participant consent */
  keyPolicyChangedAt: number;
  /** Room modality type: text, image, audio, video. Defaults to "text". */
  roomType: Modality;
  /** Timestamp of the first generation in this room (null before first gen). */
  firstGenerationAt: number | null;
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

export type PresenceState = "active" | "idle" | "away" | "generating" | "error" | "disconnected";

export type PresenceCurrentAction =
  | { type: "idle" }
  | { type: "typing"; prompt: string }
  | { type: "generating"; adapterId: string; jobId: string }
  | { type: "error"; error: string }
  | { type: "viewing_receipt"; receiptId: string };

export interface PresenceEntry {
  pubkey: PublicKeyBase58;
  name: string;
  /** Cursor position in the output pane as character offset, null if not focused */
  cursorOffset: number | null;
  lastSeenAt: number;
  /** Whether this presence entry belongs to a spectator */
  isSpectator?: boolean;
  /** 6-state presence machine */
  state: PresenceState;
  /** What the participant is currently doing (null when disconnected) */
  currentAction: PresenceCurrentAction | null;
  /** How this client is connected */
  connectedVia: "p2p" | "relay" | "spectator";
  /** Seed string for deterministic avatar generation */
  avatarSeed: string;
}

export interface SpectatorMessage {
  id: string;
  pubkey: PublicKeyBase58;
  displayName: string;
  text: string;
  ts: number;
  type: "text" | "fork" | "reaction" | "join" | "leave" | "generation" | "prompt_share" | "system";
  isDeleted: boolean;
  reactions: Record<string, string[]>;
}

export interface FortressRoomDoc {
  meta: Y.Map<RoomMeta[keyof RoomMeta]>;
  participants: Y.Map<ParticipantEntry>;
  output: Y.Text;
  /** Output items as Y.Array<Y.Map> — observable, supports reactions, soft-delete.
   *  Used for multimodal output (text deltas + image URLs + audio URLs as separate items).
   *  Fallback: if empty, fall back to reading output: Y.Text (legacy rooms). */
  outputItems: Y.Array<Y.Map<unknown>>;
  receiptIds: Y.Array<ReceiptId>;
  templates: Y.Array<string>;
  presence: Y.Map<PresenceEntry>;
  /** Chat messages among spectators in a room. Stored as Y.Map (observable, supports reactions).
   *  Y.Map<unknown> since values are heterogeneous (string, number, boolean, object). */
  spectatorChat: Y.Array<Y.Map<unknown>>;
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
  const spectatorChat = doc.getArray<unknown>("spectatorChat");
  const outputItems  = doc.getArray<Y.Map<unknown>>("outputItems");

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
      meta.set("roomType", (initialMeta as Partial<RoomMeta>).roomType ?? "text");
      meta.set("firstGenerationAt", null);
    });
  }

  return { meta, participants, output, outputItems: outputItems as unknown as Y.Array<Y.Map<unknown>>, receiptIds, templates, presence, spectatorChat: spectatorChat as unknown as Y.Array<Y.Map<unknown>>, doc };
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

/**
 * Appends a multimodal output item to outputItems (Y.Array<Y.Map>).
 * Each item has a type: "text" | "image" | "audio".
 * The resolved URL is passed directly — callers are responsible for
 * resolving opfs:// URLs before calling this if needed (see archive.ts Task 14).
 */
export function appendOutputItem(
  room: FortressRoomDoc,
  item: { type: "text"; text: string } | { type: "image"; url: string; alt?: string } | { type: "audio"; url: string; durationSeconds?: number }
): void {
  const map = new Y.Map<unknown>();
  if (item.type === "text") {
    map.set("type", "text");
    map.set("text", item.text);
  } else if (item.type === "image") {
    map.set("type", "image");
    map.set("url", item.url);
    if (item.alt) map.set("alt", item.alt);
  } else if (item.type === "audio") {
    map.set("type", "audio");
    map.set("url", item.url);
    if (item.durationSeconds !== undefined) map.set("durationSeconds", item.durationSeconds);
  }
  room.doc.transact(() => {
    room.outputItems.push([map]);
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

/** RoomTemplate: a saved snapshot of room settings that can be reused when creating new rooms. */
export interface RoomTemplate {
  id: string;
  name: string;
  /** Saved system prompt (empty string = no override) */
  systemPrompt: string;
  /** Model reference: "provider/model" */
  modelRef: string;
  /** Room category for new rooms using this template */
  category: RoomCategory;
  /** Image-specific settings (null for text-only templates) */
  imageSettings: {
    aspectRatio?: string;
    style?: string;
    defaultNegativePrompt?: string;
  } | null;
  createdAt: number;
}

/** Save the current room's settings as a named template. */
export function saveRoomTemplate(
  room: FortressRoomDoc,
  opts: { name: string; modelRef: string; imageSettings: RoomTemplate["imageSettings"] }
): void {
  const systemPrompt = getSystemPrompt(room);
  const category = getCategory(room);
  const template: RoomTemplate = {
    id: `tpl_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
    name: opts.name,
    systemPrompt,
    modelRef: opts.modelRef,
    category,
    imageSettings: opts.imageSettings,
    createdAt: Date.now(),
  };
  // Persist as a JSON string in the templates Y.Array (opaque to Y.js)
  room.doc.transact(() => {
    room.templates.push([JSON.stringify(template)]);
  });
}

/** Load a saved template by id. Returns null if not found. */
export function getRoomTemplate(room: FortressRoomDoc, id: string): RoomTemplate | null {
  const raw = room.templates.toArray().find((t) => {
    try {
      const parsed = JSON.parse(t as string) as RoomTemplate;
      return parsed.id === id;
    } catch {
      return false;
    }
  });
  if (!raw) return null;
  try {
    return JSON.parse(raw as string) as RoomTemplate;
  } catch {
    return null;
  }
}

/** List all saved templates. */
export function listRoomTemplates(room: FortressRoomDoc): RoomTemplate[] {
  return room.templates.toArray().map((t) => {
    try {
      return JSON.parse(t as string) as RoomTemplate;
    } catch {
      return null;
    }
  }).filter((t): t is RoomTemplate => t !== null);
}

/** Apply a template's settings to the current room (systemPrompt + modelRef + imageSettings). */
export function applyRoomTemplate(room: FortressRoomDoc, template: RoomTemplate): void {
  room.doc.transact(() => {
    if (template.systemPrompt !== undefined) {
      room.meta.set("systemPrompt", template.systemPrompt);
    }
    // modelRef is applied by the ControlPane's model selector
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

let _activeRoomDoc: FortressRoomDoc | null = null;

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
    outputItems:   doc.getArray("outputItems"),
    receiptIds:    doc.getArray("receiptIds"),
    templates:     doc.getArray("templates"),
    presence:      doc.getMap("presence"),
    spectatorChat: doc.getArray<Y.Map<unknown>>("spectatorChat"),
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

// ─── PRIORITY 2: Host-Only Key Mode ───────────────────────────────────────────

/** Default: host-only key mode. Participants must NOT contribute keys unless host opts in. */
export const DEFAULT_ALLOW_COMMUNITY_KEYS = false;

/** Reads the allowCommunityKeys flag with a safe default (false for existing rooms without the field). */
export function getAllowCommunityKeys(doc: FortressRoomDoc): boolean {
  const meta = doc.meta;
  const value = meta.get("allowCommunityKeys");
  return typeof value === "boolean" ? value : DEFAULT_ALLOW_COMMUNITY_KEYS;
}

/**
 * Toggles the allowCommunityKeys flag. Only the active host may call this.
 * Guard is enforced here rather than at the CRDT layer (Y.js has no ACL).
 * Non-host callers get a thrown error — the UI should hide the toggle for non-hosts.
 */
export function setAllowCommunityKeys(
  doc: FortressRoomDoc,
  value: boolean,
): void {
  const meta = doc.meta;
  const activeHost = meta.get("activeHostPubkey");
  const myPubkey = getMyPubkey();

  if (activeHost !== myPubkey) {
    throw new Error(
      "Only the active host can change the key policy. Request a host transfer first.",
    );
  }

  doc.doc.transact(() => {
    meta.set("allowCommunityKeys", value);
    // Mark a policy-change timestamp so participants can be prompted to re-consent
    meta.set("keyPolicyChangedAt", Date.now());
  });
}

/**
 * Called on join. Returns true if the room is in community-key mode AND this
 * participant hasn't consented since the last policy change — triggering the
 * consent modal before ControlPane becomes interactive.
 */
export function needsKeyPolicyConsent(
  doc: FortressRoomDoc,
  participantPubkey: string,
): boolean {
  const meta = doc.meta;
  if (!getAllowCommunityKeys(doc)) return false;

  const participants = doc.participants;
  const p = participants.get(participantPubkey as PublicKeyBase58) as
    | { consentedToPolicyAt?: number }
    | undefined;

  const changedAt = (meta.get("keyPolicyChangedAt") as number | undefined) ?? 0;
  const consentedAt = p?.consentedToPolicyAt ?? 0;

  return consentedAt < changedAt;
}

/** Records consent after the user accepts the community-key consent modal. */
export function recordKeyPolicyConsent(
  doc: FortressRoomDoc,
  participantPubkey: string,
): void {
  const participants = doc.participants;
  const existing = participants.get(participantPubkey as PublicKeyBase58) ?? {} as ParticipantEntry;
  participants.set(participantPubkey as PublicKeyBase58, {
    ...existing,
    consentedToPolicyAt: Date.now(),
  } as ParticipantEntry);
}
