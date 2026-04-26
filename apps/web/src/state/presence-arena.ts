/**
 * apps/web/src/state/presence-arena.ts
 *
 * Live Presence Arena — broadcasts which task card each connected user is
 * hovering / interacting with, and renders floating coloured avatar dots
 * anchored to those cards.
 *
 * Uses Supabase Realtime broadcast (no new infra — rides existing connection).
 * NOT Y.js — this is ephemeral UI state only, not persistent CRDT.
 *
 * API:
 *   initPresenceArena(userId, color?)  — start broadcasting + listening
 *   teardownPresenceArena()            — full cleanup (call in page teardown)
 *   updateLocalIntent(taskId, intent)  — broadcast current action
 *   wireCardHover(container)           — attach delegated hover listener
 *   renderPresenceBadges(container)    — paint avatar dots onto task cards
 *   renderHeatRings(container)         — heat ring on 2+ viewer cards
 *
 * Presence state shape:
 *   { userId, taskId, intent, color, ts }
 *
 * Color assignment:
 *   djb2 hash of userId → index into 8-colour vivid palette.
 *   Same user = same colour across all sessions.
 */

import { getSupabase } from "../auth/index.js";
import type { RealtimeChannel } from "@supabase/supabase-js";

// ── Types ──────────────────────────────────────────────────────────────────

export type PresenceIntent = "browsing" | "claiming" | "idle";

export interface ArenaPresence {
  userId: string;
  taskId: string | null;
  intent: PresenceIntent;
  color: string;
  ts: number;
}

// ── Palette ────────────────────────────────────────────────────────────────

const PALETTE = [
  "#7c3aed", // violet
  "#2563eb", // blue
  "#059669", // emerald
  "#d97706", // amber
  "#dc2626", // red
  "#db2777", // pink
  "#0891b2", // cyan
  "#65a30d", // lime
] as const;

/** Deterministic colour: same userId always maps to the same palette entry. */
export function colorForUser(userId: string): string {
  let hash = 5381;
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) + hash) ^ userId.charCodeAt(i);
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

// ── Module state ───────────────────────────────────────────────────────────

let _channel: RealtimeChannel | null = null;
let _myUserId: string | null = null;
let _myColor: string | null = null;
let _peers = new Map<string, ArenaPresence>();
let _localState: ArenaPresence | null = null;
let _broadcastThrottle: ReturnType<typeof setTimeout> | null = null;
let _hoverListener: ((e: MouseEvent) => void) | null = null;
let _hoverTarget: HTMLElement | null = null;

const THROTTLE_MS   = 100;
const PRESENCE_TTL  = 8_000;

// ── Init ───────────────────────────────────────────────────────────────────

/**
 * Start broadcasting presence and listening for peers.
 * Idempotent — tears down any previous session before starting.
 *
 * @param userId  Current user's Supabase auth id.
 * @param color   Optional override; defaults to deterministic palette colour.
 */
export function initPresenceArena(userId: string, color?: string): void {
  teardownPresenceArena();

  _myUserId = userId;
  _myColor  = color ?? colorForUser(userId);
  _peers    = new Map();

  _channel = getSupabase()
    .channel("presence-arena", { config: { broadcast: { self: false } } })
    .on("broadcast", { event: "arena" }, ({ payload }) => {
      const p = payload as ArenaPresence;
      if (!p?.userId || p.userId === _myUserId) return;
      _peers.set(p.userId, p);
      // Auto-expire peer after TTL silence
      setTimeout(() => {
        const cur = _peers.get(p.userId);
        if (cur && cur.ts === p.ts) _peers.delete(p.userId);
      }, PRESENCE_TTL);
    })
    .subscribe();
}

// ── Update local intent ────────────────────────────────────────────────────

/**
 * Update what this user is currently doing on a task card.
 * Throttled to THROTTLE_MS; fire-and-forget relay call.
 */
export function updateLocalIntent(
  taskId: string | null,
  intent: PresenceIntent,
): void {
  if (!_myUserId) return;
  _localState = {
    userId: _myUserId,
    taskId,
    intent,
    color: _myColor!,
    ts: Date.now(),
  };
  _scheduleBroadcast();
}

function _scheduleBroadcast(): void {
  if (_broadcastThrottle) return;
  _broadcastThrottle = setTimeout(() => {
    _broadcastThrottle = null;
    if (_localState && _channel) {
      _channel
        .send({ type: "broadcast", event: "arena", payload: _localState })
        .catch(() => {}); // non-critical — silently drop on relay failure
    }
  }, THROTTLE_MS);
}

// ── Hover wiring ───────────────────────────────────────────────────────────

/**
 * Attach a delegated mouseover listener to a container so that hovering a
 * task card (any element with data-task-id) broadcasts the user's presence.
 *
 * Idempotent — replaces any previous listener on a different container.
 * Call after render() populates the list.
 */
export function wireCardHover(container: HTMLElement): void {
  if (_hoverListener && _hoverTarget) {
    _hoverTarget.removeEventListener("mouseover", _hoverListener);
  }

  _hoverListener = (e: MouseEvent) => {
    const card = (e.target as Element).closest<HTMLElement>("[data-task-id]");
    updateLocalIntent(card?.dataset.taskId ?? null, "browsing");
  };

  _hoverTarget = container;
  container.addEventListener("mouseover", _hoverListener);
}

// ── Render badges ──────────────────────────────────────────────────────────

/**
 * Paint floating coloured avatar dots onto task cards.
 *
 * Algorithm:
 *   1. Build a taskId → ArenaPresence[] map from current peers.
 *   2. Remove stale dot elements (peer left the card or was evicted).
 *   3. Upsert a .ff-presence-dot for each active peer on each card.
 *
 * Safe to call after every render() — diffs by data-peer-id.
 * Uses inline styles so it works without importing a CSS file at runtime.
 *
 * @param container  The scrollable task list element (#tasks-list).
 */
export function renderPresenceBadges(container: HTMLElement): void {
  // Build: taskId → peers[]
  const byTask = new Map<string, ArenaPresence[]>();
  for (const peer of _peers.values()) {
    if (!peer.taskId) continue;
    const arr = byTask.get(peer.taskId) ?? [];
    arr.push(peer);
    byTask.set(peer.taskId, arr);
  }

  // Remove stale dots
  container.querySelectorAll<HTMLElement>(".ff-presence-dot").forEach(dot => {
    const peer = _peers.get(dot.dataset.peerId!);
    if (!peer || peer.taskId !== dot.dataset.taskId) dot.remove();
  });

  // Upsert active peer dots
  for (const [taskId, peers] of byTask) {
    const card = container.querySelector<HTMLElement>(`[data-task-id="${taskId}"]`);
    if (!card) continue;

    // Ensure card is position:relative so absolute dots anchor to it
    if (getComputedStyle(card).position === "static") {
      card.style.position = "relative";
    }

    peers.forEach((peer, i) => {
      let dot = card.querySelector<HTMLElement>(`[data-peer-id="${peer.userId}"]`);

      if (!dot) {
        dot = document.createElement("div");
        dot.className = "ff-presence-dot";
        dot.dataset.peerId = peer.userId;
        dot.dataset.taskId = taskId;
        dot.setAttribute("aria-hidden", "true");
        card.appendChild(dot);
      }

      // Update tooltip on every pass (intent may have changed)
      dot.title = peer.intent === "claiming"
        ? "Someone is claiming this…"
        : "Viewing";

      // Stack dots horizontally from the right; slide smoothly on reorder
      dot.style.cssText = `
        position: absolute;
        top: 8px;
        right: ${8 + i * 22}px;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: ${peer.color};
        border: 2px solid var(--ff-paper, #fff);
        box-shadow: 0 1px 4px rgba(0,0,0,0.25);
        z-index: 10;
        transition: right 0.2s ease;
        animation: ${peer.intent === "claiming" ? "ff-dot-pulse-fast" : "ff-dot-pulse"} 2s ease-in-out infinite;
      `;
    });
  }
}

// ── Heat rings ─────────────────────────────────────────────────────────────

/**
 * Add .ff-card--hot + data-viewer-count to cards with 2+ simultaneous viewers.
 * CSS animates the outline; the ::before pseudo-element shows "N viewing".
 *
 * @param container  The scrollable task list element (#tasks-list).
 */
export function renderHeatRings(container: HTMLElement): void {
  const byTask = new Map<string, number>();
  for (const peer of _peers.values()) {
    if (!peer.taskId) continue;
    byTask.set(peer.taskId, (byTask.get(peer.taskId) ?? 0) + 1);
  }

  container.querySelectorAll<HTMLElement>("[data-task-id]").forEach(card => {
    const count = byTask.get(card.dataset.taskId!) ?? 0;
    if (count >= 2) {
      card.classList.add("ff-card--hot");
      card.dataset.viewerCount = String(count);
    } else {
      card.classList.remove("ff-card--hot");
      delete card.dataset.viewerCount;
    }
  });
}

// ── Teardown ───────────────────────────────────────────────────────────────

/** Full cleanup. Call in the page teardown function returned by mountTasks. */
export function teardownPresenceArena(): void {
  if (_broadcastThrottle) {
    clearTimeout(_broadcastThrottle);
    _broadcastThrottle = null;
  }
  if (_hoverListener && _hoverTarget) {
    _hoverTarget.removeEventListener("mouseover", _hoverListener);
    _hoverListener = null;
    _hoverTarget   = null;
  }
  if (_channel) {
    _channel.unsubscribe().catch(() => {});
    _channel = null;
  }
  _peers.clear();
  _localState = null;
  _myUserId   = null;
  _myColor    = null;
}
