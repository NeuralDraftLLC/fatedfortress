/**
 * apps/web/src/net/signaling.ts — Relay WebSocket + Y.js updates + y-webrtc TURN provider.
 *
 * SCOPE RESTRICTION (Post-Refactor v1):
 * WebRTC signaling via y-webrtc is restricted to **review session peers only.**
 * All Y.js sync, presence, and WebRTC connections must route through
 * a `review_sessions.ydoc_id` — never through room IDs.
 *
 * Legacy joinRoom / spectateRoom remain for backward compatibility.
 * New code must not create Y.js sessions outside review_sessions.
 *
 * See also: Section 6 of the Post-Refactor Implementation Brief.
 *
 * Spectate (Task 2): joinRoom(..., { spectate }) sends spectator=1 — relay skips WebRTC signaling
 * routing for those peers (they still get Y.js sync). Client ignores offer/answer/ICE when spectating.
 *
 * OPFS (Task 3): load snapshot before WebSocket connects for instant UI; 30s interval persists
 * encodeStateAsUpdate; flush on close; timer cleared on close (no leak).
 *
 * Sharding: client follows { type: "REDIRECT", shardUrl } once after connect before attaching handlers.
 *
 * TURN (Phase TURN-1):
 *   - createYjsProvider() fetches short-lived credentials from /turn-credentials on the relay,
 *     then initialises y-webrtc's WebrtcProvider with those servers in peerOpts.config.iceServers.
 *   - The existing raw-WS relay remains the y-webrtc signaling transport (signaling: [RELAY_WS_URL]).
 *   - getPeerConnections() exposes the underlying RTCPeerConnection map for ConnectionBadge.
 *   - A 10-second watchdog dispatches "ff:connection-timeout" if the provider never syncs.
 */

import { type RoomId, type PublicKeyBase58 } from "@fatedfortress/protocol";
import * as Y from "yjs";
import { WebrtcProvider } from "y-webrtc";
import {
  type FortressRoomDoc,
  createRoomDoc,
  setActiveRoomDoc,
  applyRemoteUpdate,
  serializeDoc,
  migrateParticipantsFromLegacy,
  type PresenceEntry,
  type PresenceCurrentAction,
} from "../state/ydoc.js";
import { getMyPubkey, getMyDisplayName } from "../state/identity.js";

const RELAY_ORIGIN = typeof __RELAY_ORIGIN__ !== "undefined"
  ? __RELAY_ORIGIN__
  : "wss://relay.fatedfortress.com";

// HTTP base URL for REST calls (TURN credential fetch).
// Derived from RELAY_ORIGIN by swapping wss → https / ws → http.
const RELAY_HTTP_ORIGIN = ((): string => {
  const env = typeof __RELAY_HTTP_ORIGIN__ !== "undefined"
    ? (__RELAY_HTTP_ORIGIN__ as string)
    : "";
  if (env) return env;
  // Fallback: derive from the WS origin.
  return RELAY_ORIGIN.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");
})();

export { type PresenceEntry };

const SNAPSHOT_INTERVAL_MS = 30_000;
const TURN_SYNC_TIMEOUT_MS = 10_000;

/** Active WebSocket connection + snapshot timer */
let activeWs: WebSocket | null = null;
let snapshotTimer: ReturnType<typeof setInterval> | null = null;
let snapshotRoomId: RoomId | null = null;

/** Active y-webrtc provider — one per room session */
let activeProvider: WebrtcProvider | null = null;
let syncWatchdog: ReturnType<typeof setTimeout> | null = null;

export function getRelayWebSocket(): WebSocket | null {
  return activeWs;
}

// ── Presence helpers ──────────────────────────────────────────────────────────

export function upsertPresence(doc: FortressRoomDoc, presence: Partial<PresenceEntry>): void {
  const myPubkey = getMyPubkey();
  if (!myPubkey) return;
  const existing = doc.presence.get(myPubkey);
  doc.presence.set(myPubkey, {
    pubkey: myPubkey as PublicKeyBase58,
    name: presence.name ?? existing?.name ?? getMyDisplayName(),
    cursorOffset: presence.cursorOffset ?? null,
    lastSeenAt: Date.now(),
    isSpectator: presence.isSpectator ?? false,
    // New fields (defaults — heartbeat will update state/currentAction in Task 4)
    state: presence.state ?? "active",
    currentAction: presence.currentAction ?? null,
    connectedVia: presence.connectedVia ?? "p2p",
    avatarSeed: presence.avatarSeed ?? existing?.avatarSeed ?? myPubkey as string,
  });
}

export function removePresence(doc: FortressRoomDoc): void {
  const myPubkey = getMyPubkey();
  if (!myPubkey) return;
  doc.presence.delete(myPubkey);
}

// ── OPFS helpers ──────────────────────────────────────────────────────────────

function clearSnapshotLoop(): void {
  if (snapshotTimer !== null) {
    clearInterval(snapshotTimer);
    snapshotTimer = null;
  }
  snapshotRoomId = null;
}

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
    await writable.write(bytes as unknown as FileSystemWriteChunkType);
    await writable.close();
  } catch (e) {
    console.warn("[signaling] OPFS snapshot write failed:", e);
  }
}

// ── TURN credential fetch ─────────────────────────────────────────────────────

type IceServerEntry = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

const STUN_FALLBACK: IceServerEntry[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

async function fetchIceServers(): Promise<IceServerEntry[]> {
  try {
    const res = await fetch(`${RELAY_HTTP_ORIGIN}/turn-credentials`, {
      method: "GET",
      credentials: "omit",
    });
    if (!res.ok) throw new Error(`/turn-credentials returned ${res.status}`);
    const data = await res.json() as { iceServers: IceServerEntry | IceServerEntry[] };
    const turnEntry = data.iceServers;
    if (!turnEntry || (Array.isArray(turnEntry) && turnEntry.length === 0)) {
      // Relay returned empty — TURN not yet configured; use STUN only.
      return STUN_FALLBACK;
    }
    const entries = Array.isArray(turnEntry) ? turnEntry : [turnEntry];
    return [...STUN_FALLBACK, ...entries];
  } catch (err) {
    console.warn("[signaling] TURN credential fetch failed — STUN only:", err);
    return STUN_FALLBACK;
  }
}

// ── y-webrtc provider ─────────────────────────────────────────────────────────

/**
 * Creates a y-webrtc WebrtcProvider for the given room doc.
 *
 * The existing relay WebSocket is the signaling transport.
 * TURN credentials are injected into peerOpts.config.iceServers — this is the
 * correct nesting for simple-peer / y-webrtc (not peerOpts.iceServers).
 *
 * A 10-second watchdog fires "ff:connection-timeout" if the provider never
 * emits a "synced" event, so the UI can warn the user.
 */
async function createYjsProvider(roomId: RoomId, doc: FortressRoomDoc): Promise<WebrtcProvider> {
  // Destroy any existing provider before creating a new one.
  if (activeProvider) {
    try { activeProvider.destroy(); } catch { /* ignore */ }
    activeProvider = null;
  }
  if (syncWatchdog !== null) {
    clearTimeout(syncWatchdog);
    syncWatchdog = null;
  }

  const iceServers = await fetchIceServers();

  // y-webrtc signaling URL uses the same relay WS endpoint with roomId param.
  const signalingUrl = `${RELAY_ORIGIN}?roomId=${encodeURIComponent(roomId)}`;

  const provider = new WebrtcProvider(roomId, doc.doc, {
    signaling: [signalingUrl],
    peerOpts: {
      config: {
        // ↑ Must be nested at peerOpts.config — not peerOpts directly.
        // simple-peer passes this object straight into new RTCPeerConnection(config).
        iceServers,
        iceTransportPolicy: "all",  // try direct UDP first; fall through to TURN
        iceCandidatePoolSize: 10,   // pre-gather candidates to speed up hole-punching
      },
    },
  });

  // 10-second watchdog: if provider never syncs, warn the UI.
  syncWatchdog = setTimeout(() => {
    syncWatchdog = null;
    window.dispatchEvent(new CustomEvent("ff:connection-timeout"));
  }, TURN_SYNC_TIMEOUT_MS);

  provider.on("synced", () => {
    if (syncWatchdog !== null) {
      clearTimeout(syncWatchdog);
      syncWatchdog = null;
    }
  });

  activeProvider = provider;
  return provider;
}

// ── RTCPeerConnection accessor for ConnectionBadge ────────────────────────────

/**
 * Returns a snapshot of the underlying RTCPeerConnection instances managed by
 * y-webrtc's simple-peer instances.
 *
 * y-webrtc exposes provider.room.webrtcConns: Map<peerId, WebrtcConn>.
 * Each WebrtcConn has a .peer property (SimplePeer instance) whose ._pc
 * property is the raw RTCPeerConnection.
 *
 * Returns an empty map when not yet connected or when running spectator-only.
 */
export function getPeerConnections(): Map<string, RTCPeerConnection> {
  const result = new Map<string, RTCPeerConnection>();
  if (!activeProvider) return result;

  // Type assertion: y-webrtc types don't fully expose room internals.
  const room = (activeProvider as any).room as
    | { webrtcConns: Map<string, { peer: { _pc: RTCPeerConnection | null } }> }
    | null
    | undefined;

  if (!room?.webrtcConns) return result;

  room.webrtcConns.forEach((conn, peerId) => {
    const pc = conn?.peer?._pc;
    if (pc) result.set(peerId, pc);
  });

  return result;
}

// ── WebSocket relay helpers (unchanged from original) ─────────────────────────

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
    ws.addEventListener("message", (ev) => { clearTimeout(t); resolve(ev.data as string); }, { once: true });
  });
}

// ── Ephemeral relay helpers ────────────────────────────────────────────────────

/**
 * Sends a TYPING_START or TYPING_STOP message to the relay for broadcast to
 * other participants in the same room. These are fire-and-forget — the relay
 * relays them without storing. Callers handle errors silently.
 *
 * @param roomId  The current room
 * @param prompt  Current prompt text (sent only with TYPING_START; "" on TYPING_STOP)
 */
export function broadcastTyping(roomId: RoomId, prompt: string): void {
  if (!activeWs || activeWs.readyState !== WebSocket.OPEN) return;
  const myPubkey = getMyPubkey();
  if (!myPubkey) return;
  const msg = {
    type: prompt ? "TYPING_START" : "TYPING_STOP",
    roomId,
    pubkey: myPubkey as PublicKeyBase58,
    prompt: prompt || "",
    ts: Date.now(),
  };
  try {
    activeWs.send(JSON.stringify(msg));
  } catch {
    // Silent fail — ephemeral
  }
}

// ── joinRoom ──────────────────────────────────────────────────────────────────

export interface JoinRoomOpts {
  spectate?: boolean;
}

export async function joinRoom(
  roomId: RoomId,
  opts: JoinRoomOpts = {}
): Promise<FortressRoomDoc> {
  clearSnapshotLoop();
  if (activeWs) {
    try { activeWs.close(); } catch { /* ignore */ }
    activeWs = null;
  }

  const doc = createRoomDoc({ id: roomId });
  setActiveRoomDoc(doc);

  const bytes = await readOpfsSnapshot(roomId);
  if (bytes && bytes.length > 0) {
    try {
      Y.applyUpdate(doc.doc, bytes);
      migrateParticipantsFromLegacy(doc);
    } catch (e) {
      console.warn("[signaling] OPFS hydrate failed:", e);
    }
  }

  const peerId = getMyPubkey() ?? `anon_${crypto.randomUUID().slice(0, 8)}`;
  const isSpectator = opts.spectate === true;

  // Spin up the y-webrtc provider (fetches TURN creds, creates WebrtcProvider).
  // Spectators don't need p2p mesh — skip provider to avoid unnecessary ICE churn.
  if (!isSpectator) {
    void createYjsProvider(roomId, doc);
  }

  // ── Raw-WS relay (Y.js sync + server-side room state) ────────────────────
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

  try {
    const first = await waitFirstMessage(ws, 3000);
    const msg = JSON.parse(first) as { type?: string; shardUrl?: string };
    if (msg.type === "REDIRECT" && typeof msg.shardUrl === "string") {
      try { ws.close(); } catch { /* ignore */ }
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
      if (isSpectator) return;
      console.debug("[signaling] Relay signaling message:", msg.type);
    }

    if (msg.type === "sync" && msg.update) {
      try {
        applyRemoteUpdate(doc, new Uint8Array(msg.update));
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

    if (msg.type === "TYPING_START" || msg.type === "TYPING_STOP") {
      // Relay ephemeral: update presence.currentAction without persisting to Y.Doc.
      // Re-dispatch on the local doc so any PresenceBar subscriber re-renders.
      if (msg.pubkey !== (getMyPubkey() as string)) {
        const action: PresenceCurrentAction = msg.type === "TYPING_START"
          ? { type: "typing", prompt: msg.prompt ?? "" }
          : { type: "idle" };
        try {
          upsertPresence(doc, { pubkey: msg.pubkey, currentAction: action });
        } catch { /* ignore stale relay messages */ }
      }
    }
  });

  snapshotTimer = setInterval(() => {
    if (!snapshotRoomId) return;
    void writeOpfsSnapshot(snapshotRoomId, serializeDoc(doc));
  }, SNAPSHOT_INTERVAL_MS);

  ws.addEventListener("close", () => {
    console.warn("[signaling] Disconnected from relay");
    const rid = snapshotRoomId;
    if (rid) void writeOpfsSnapshot(rid, serializeDoc(doc));
    clearSnapshotLoop();
    if (activeWs === ws) activeWs = null;
  });

  ws.addEventListener("error", (e) => {
    console.warn("[signaling] WebSocket error:", e);
  });

  return doc;
}

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
