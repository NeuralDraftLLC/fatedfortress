/**
 * apps/web/src/net/signaling.ts — Relay WebSocket + Y.js updates + Phase 4 integration.
 *
 * Spectate (Task 2): joinRoom(..., { spectate }) sends spectator=1 — relay skips WebRTC signaling
 * routing for those peers (they still get Y.js sync). Client ignores offer/answer/ICE when spectating.
 *
 * OPFS (Task 3): load snapshot before WebSocket connects for instant UI; 30s interval persists
 * encodeStateAsUpdate; flush on close; timer cleared on close (no leak).
 *
 * Sharding: client follows { type: "REDIRECT", shardUrl } once after connect before attaching handlers.
 */

import { type RoomId } from "@fatedfortress/protocol";
import * as Y from "yjs";
import {
  type FortressRoomDoc,
  createRoomDoc,
  setActiveRoomDoc,
  applyRemoteUpdate,
  serializeDoc,
  migrateParticipantsFromLegacy,
  type PresenceEntry,
} from "../state/ydoc.js";
import { getMyPubkey, getMyDisplayName } from "../state/identity.js";

const RELAY_ORIGIN = typeof __RELAY_ORIGIN__ !== "undefined"
  ? __RELAY_ORIGIN__
  : "wss://relay.fatedfortress.com";

export { type PresenceEntry };

const SNAPSHOT_INTERVAL_MS = 30_000;

/** Active connection + snapshot timer — single active room channel for this SPA session */
let activeWs: WebSocket | null = null;
let snapshotTimer: ReturnType<typeof setInterval> | null = null;
let snapshotRoomId: RoomId | null = null;

export function getRelayWebSocket(): WebSocket | null {
  return activeWs;
}

export function upsertPresence(doc: FortressRoomDoc, presence: Partial<PresenceEntry>): void {
  const myPubkey = getMyPubkey();
  if (!myPubkey) return;
  const existing = doc.presence.get(myPubkey);
  doc.presence.set(myPubkey, {
    pubkey: myPubkey,
    name: presence.name ?? existing?.name ?? getMyDisplayName(),
    cursorOffset: presence.cursorOffset ?? null,
    lastSeenAt: Date.now(),
    isSpectator: presence.isSpectator ?? false,
  });
}

export function removePresence(doc: FortressRoomDoc): void {
  const myPubkey = getMyPubkey();
  if (!myPubkey) return;
  doc.presence.delete(myPubkey);
}

/** Stops periodic OPFS writes and clears snapshotRoomId — call before joinRoom reconnect or after close flush. */
function clearSnapshotLoop(): void {
  if (snapshotTimer !== null) {
    clearInterval(snapshotTimer);
    snapshotTimer = null;
  }
  snapshotRoomId = null;
}

/** Best-effort local cache — absent file is normal on first visit. */
async function readOpfsSnapshot(roomId: string): Promise<Uint8Array | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const fileHandle = await root.getFileHandle(`ff-room-${roomId}.yjs`);
    const file = await fileHandle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
}

async function writeOpfsSnapshot(roomId: string, bytes: Uint8Array): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    const fileHandle = await root.getFileHandle(`ff-room-${roomId}.yjs`, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(bytes);
    await writable.close();
  } catch (e) {
    console.warn("[signaling] OPFS snapshot write failed:", e);
  }
}

function relayUrl(roomId: RoomId, peerId: string, spectate: boolean): string {
  const u = new URL(RELAY_ORIGIN);
  u.searchParams.set("peerId", peerId);
  u.searchParams.set("roomId", roomId);
  if (spectate) u.searchParams.set("spectator", "1");
  return u.toString();
}

function waitOpen(ws: WebSocket, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("ws open timeout")), timeoutMs);
    ws.addEventListener("open", () => { clearTimeout(t); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(t); reject(new Error("ws error")); }, { once: true });
  });
}

function waitFirstMessage(ws: WebSocket, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("first message timeout")), timeoutMs);
    ws.addEventListener(
      "message",
      (ev) => {
        clearTimeout(t);
        resolve(ev.data as string);
      },
      { once: true }
    );
  });
}

export interface JoinRoomOpts {
  spectate?: boolean;
}

export async function joinRoom(
  roomId: RoomId,
  opts: JoinRoomOpts = {}
): Promise<FortressRoomDoc> {
  clearSnapshotLoop();
  if (activeWs) {
    try {
      activeWs.close();
    } catch {
      /* ignore */
    }
    activeWs = null;
  }

  const doc = createRoomDoc({ id: roomId });
  setActiveRoomDoc(doc);

  const bytes = await readOpfsSnapshot(roomId);
  if (bytes && bytes.length > 0) {
    try {
      // Hydrate before WS so UI reflects last session; relay merge remains CRDT-safe.
      Y.applyUpdate(doc.doc, bytes);
      migrateParticipantsFromLegacy(doc); // snapshot may predate participantMap migration
    } catch (e) {
      console.warn("[signaling] OPFS hydrate failed:", e);
    }
  }

  const peerId = getMyPubkey() ?? `anon_${crypto.randomUUID().slice(0, 8)}`;
  const isSpectator = opts.spectate === true;

  let ws: WebSocket;
  try {
    ws = new WebSocket(relayUrl(roomId, peerId, isSpectator));
  } catch {
    console.warn("[signaling] Could not connect to relay — running in local mode");
    return doc;
  }

  try {
    await waitOpen(ws);
  } catch {
    console.warn("[signaling] WebSocket open failed — local mode");
    return doc;
  }

  // Relay may send REDIRECT immediately; otherwise first frame may be sync (handled in dispatchPrimedMessage).
  try {
    const first = await waitFirstMessage(ws, 3000);
    const msg = JSON.parse(first) as { type?: string; shardUrl?: string };
    if (msg.type === "REDIRECT" && typeof msg.shardUrl === "string") {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      ws = new WebSocket(msg.shardUrl);
      await waitOpen(ws);
    } else {
      dispatchPrimedMessage(doc, isSpectator, first);
    }
  } catch {
    /* no primed redirect message */
  }

  activeWs = ws;
  snapshotRoomId = roomId;

  ws.addEventListener("message", (event) => {
    const data = event.data as string;
    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    if (msg.type === "offer" || msg.type === "answer" || msg.type === "ice-candidate") {
      if (isSpectator) {
        return;
      }
      console.debug("[signaling] Relay signaling message:", msg.type);
    }

    if (msg.type === "sync" && msg.update) {
      try {
        const update = new Uint8Array(msg.update);
        applyRemoteUpdate(doc, update);
      } catch (e) {
        console.warn("[signaling] Failed to apply remote update:", e);
      }
    }

    if (msg.type === "HANDOFF") {
      void import("../state/handoff.js").then(({ acceptHandoff }) => {
        try {
          acceptHandoff(doc, msg);
        } catch (e) {
          console.warn("[signaling] HANDOFF handling failed:", e);
        }
      });
    }
  });

  snapshotTimer = setInterval(() => {
    if (!snapshotRoomId) return;
    void writeOpfsSnapshot(snapshotRoomId, serializeDoc(doc));
  }, SNAPSHOT_INTERVAL_MS);

  ws.addEventListener("close", () => {
    console.log("[signaling] Disconnected from relay");
    const rid = snapshotRoomId;
    // Capture rid before clearSnapshotLoop — final flush uses last-known room id for OPFS filename.
    if (rid) {
      void writeOpfsSnapshot(rid, serializeDoc(doc));
    }
    clearSnapshotLoop();
    if (activeWs === ws) activeWs = null;
  });

  ws.addEventListener("error", (e) => {
    console.warn("[signaling] WebSocket error:", e);
  });

  return doc;
}

/** Applies the first inbound JSON if we did not swap to a shard socket (replay before main listener attaches). */
function dispatchPrimedMessage(doc: FortressRoomDoc, isSpectator: boolean, first: string): void {
  let msg: any;
  try {
    msg = JSON.parse(first);
  } catch {
    return;
  }
  if (msg.type === "offer" || msg.type === "answer" || msg.type === "ice-candidate") {
    if (isSpectator) return;
    return;
  }
  if (msg.type === "sync" && msg.update) {
    try {
      applyRemoteUpdate(doc, new Uint8Array(msg.update));
    } catch (e) {
      console.warn("[signaling] primed sync apply failed:", e);
    }
  }
}
