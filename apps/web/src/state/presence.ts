// apps/web/src/state/presence.ts
// Host presence detection, ephemeral handoff logic, and 15s heartbeat with
// presence state machine for FatedFortress rooms.

import type { FortressRoomDoc } from "./ydoc.js";
import type { PresenceState, PresenceCurrentAction } from "./ydoc.js";
import { upsertPresence } from "../net/signaling.js";
import { getMyPubkey } from "./identity.js";

// ── Host handoff ───────────────────────────────────────────────────────────────

export interface RoomState {
  handoffTriggered: boolean;
}

const roomStates = new Map<string, RoomState>();
const DISCONNECT_THRESHOLD_MS = 30_000;

function getRoomState(roomId: string): RoomState {
  if (!roomStates.has(roomId)) {
    roomStates.set(roomId, { handoffTriggered: false });
  }
  return roomStates.get(roomId)!;
}

export function checkHostPresence(room: FortressRoomDoc): void {
  const roomId = room.meta.get("id") as string;
  const roomState = getRoomState(roomId);
  const hostPubkey = room.meta.get("hostPubkey") as string | undefined;
  const activeHostPubkey = room.meta.get("activeHostPubkey") as string | undefined;

  if (!hostPubkey) return;

  const hostPresence = room.presence.get(hostPubkey);
  if (!hostPresence) return;

  const stale = Date.now() - hostPresence.lastSeenAt > DISCONNECT_THRESHOLD_MS;

  if (!stale) {
    roomState.handoffTriggered = false;
    const originalHost = room.meta.get("hostPubkey") as string;
    if (originalHost && originalHost !== activeHostPubkey) {
      room.doc.transact(() => {
        room.meta.set("activeHostPubkey", originalHost as any);
      });
    }
    return;
  }

  if (stale && !roomState.handoffTriggered) {
    roomState.handoffTriggered = true;
    void initiateHandoff(room);
  }
}

async function initiateHandoff(room: FortressRoomDoc): Promise<void> {
  const delegateKey = getMyPubkey();
  if (!delegateKey) {
    console.warn("[presence] Cannot initiate handoff: no identity pubkey available");
    return;
  }

  room.doc.transact(() => {
    room.meta.set("activeHostPubkey", delegateKey as any);
  });

  console.log(`[presence] Host handoff initiated. New active host: ${delegateKey}`);
}

export function cleanupRoomState(roomId: string): void {
  roomStates.delete(roomId);
}

// ── Presence heartbeat ────────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 15_000;
const IDLE_THRESHOLD_MS = 60_000;      // → idle after 1 min
const AWAY_THRESHOLD_MS = 300_000;     // → away after 5 min

interface HeartbeatState {
  roomId: string;
  doc: FortressRoomDoc;
  intervalId: ReturnType<typeof setInterval>;
  lastActivity: number;
  /** Guard: set_generating stops the heartbeat-derived idle cycle */
  isGenerating: boolean;
}

const heartbeatMap = new Map<string, HeartbeatState>();

function getHeartbeat(roomId: string): HeartbeatState | undefined {
  return heartbeatMap.get(roomId);
}

function computeState(hb: HeartbeatState): PresenceState {
  if (hb.isGenerating) return "generating";
  const idle = Date.now() - hb.lastActivity;
  if (idle > AWAY_THRESHOLD_MS) return "away";
  if (idle > IDLE_THRESHOLD_MS) return "idle";
  return "active";
}

function computeAction(state: PresenceState): PresenceCurrentAction {
  switch (state) {
    case "active":
    case "idle":
    case "away":
      return { type: "idle" };
    case "generating":
      return { type: "generating", adapterId: "", jobId: "" };
    case "error":
      return { type: "error", error: "" };
    case "disconnected":
      return { type: "idle" };
  }
}

function heartbeatTick(hb: HeartbeatState): void {
  const state = computeState(hb);
  const action = computeAction(state);
  upsertPresence(hb.doc, { state, currentAction: action });
}

/** Start 15s heartbeat for a room. Call once per room join. */
export function startPresenceHeartbeat(doc: FortressRoomDoc): void {
  const roomId = doc.meta.get("id") as string;
  if (heartbeatMap.has(roomId)) {
    stopPresenceHeartbeat(roomId); // idempotent restart
  }

  const now = Date.now();
  const hb: HeartbeatState = {
    roomId,
    doc,
    lastActivity: now,
    isGenerating: false,
    intervalId: setInterval(() => heartbeatTick(hb), HEARTBEAT_INTERVAL_MS),
  };

  heartbeatMap.set(roomId, hb);

  // Activity listeners reset lastActivity and bump state → active
  const onActivity = () => {
    hb.lastActivity = Date.now();
    if (!hb.isGenerating) {
      upsertPresence(hb.doc, { state: "active", currentAction: { type: "idle" } });
    }
  };
  document.addEventListener("mousemove", onActivity, { passive: true });
  document.addEventListener("keydown", onActivity, { passive: true });

  // Store listener refs for cleanup (attach to hb for access)
  (hb as HeartbeatState & { _activity: () => void })._activity = onActivity;

  // Immediate first tick to set initial presence
  heartbeatTick(hb);
}

/** Stop heartbeat and remove activity listeners. Call on room exit. */
export function stopPresenceHeartbeat(roomId: string): void {
  const hb = heartbeatMap.get(roomId);
  if (!hb) return;

  clearInterval(hb.intervalId);
  document.removeEventListener("mousemove", (hb as HeartbeatState & { _activity: () => void })._activity);
  document.removeEventListener("keydown", (hb as HeartbeatState & { _activity: () => void })._activity);
  heartbeatMap.delete(roomId);
}

/**
 * Called by ControlPane when generation starts — disables the heartbeat-derived
 * idle/away cycle so the state stays "generating".
 *
 * After generation ends, call `setPresenceGenerating(false, doc, roomId)` to restore.
 */
export function setPresenceGenerating(isGenerating: boolean, doc: FortressRoomDoc): void {
  const roomId = doc.meta.get("id") as string;
  const hb = getHeartbeat(roomId);
  if (!hb) return;

  hb.isGenerating = isGenerating;
  if (isGenerating) {
    upsertPresence(doc, {
      state: "generating",
      currentAction: { type: "idle" }, // Will be refined per-job in Task 9
    });
  } else {
    // Return to heartbeat control
    hb.lastActivity = Date.now();
    const state = computeState(hb);
    const action = computeAction(state);
    upsertPresence(doc, { state, currentAction: action });
  }
}
