/**
 * apps/web/src/state/presence-arena.ts
 *
 * Live Presence Arena — broadcasts which task card each connected user is
 * hovering / interacting with, and renders floating colored avatar dots
 * anchored to those cards.
 *
 * Uses Supabase Realtime broadcast (no new infra — rides the existing channel
 * infrastructure). NOT Y.js — this is ephemeral UI state, not persistent CRDT.
 *
 * API:
 *   initPresenceArena(userId, color?)   — start broadcasting + listening
 *   teardownPresenceArena()             — full cleanup (call in page teardown)
 *   updateLocalIntent(taskId, intent)   — update what this user is doing
 *   renderPresenceBadges(container)     — paint avatar dots onto task cards
 *   renderHeatRings(container)          — highlight hot cards (2+ viewers)
 *   wireCardHover(container)            — wire mouseover → presence updates
 *
 * Presence state shape:
 *   { userId, taskId, intent, color, ts }
 *
 * Color assignment:
 *   Deterministic hash of userId → one of 8 vivid palette colors.
 *   Same user = same color across all sessions.
 */

import { getSupabase } from "../auth/index.js";
import type { RealtimeChannel } from "@supabase/supabase-js";

// ── Types ──────────────────────────────────────────────────────────────────────

export type PresenceIntent = "browsing" | "claiming" | "idle";

export interface ArenaPresence {
  userId: string;
  taskId: string | null;
  intent: PresenceIntent;
  color: string;
  ts: number;
}

// ── Palette ────────────────────────────────────────────────────────────────────

const PALETTE = [
  "#7c3aed", // violet
  "#2563eb", // blue
  "#059669", // emerald
  "#d97706", // amber
  "#dc2626", // red
  "#db2777", // pink
  "#0891b2", // cyan
  "#65a30d", // lime
];

/** Deterministic color from userId — same user always gets the same color. */
export function colorForUser(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) - hash + userId.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

// ── Module state ───────────────────────────────────────────────────────────────

let _channel: RealtimeChannel | null = null;
let _myUserId: string | null = null;
let _myColor: string | null = null;
let _peers = new Map<string, ArenaPresence>();
let _localState: ArenaPresence | null = null;
let _broadcastThrottle: ReturnType<typeof setTimeout> | null = null;
let _hoverListener: ((e: MouseEvent) => void) | null = null;
let _hoverTarget: HTMLElement | null = null;

const THROTTLE_MS = 100;
const PRESENCE_TTL_MS = 8_000; // remove peer after 8s of silence

// ── Init ───────────────────────────────────────────────────────────────────────

/**
 * Start broadcasting presence and listening for peers.
 * Idempotent — safe to call multiple times (tears down previous state first).
 *
 * @param userId  the current user's Supabase auth id
 * @param color   optional color override; defaults to deterministic palette color
 */
export function initPresenceArena(
  userId: string,
  color?: string,
): void {
  teardownPresenceArena(); // clean up any stale state

  _myUserId = userId;
  _myColor = color ?? colorForUser(userId);
  _peers = new Map();

  _channel = getSupabase()
    .channel("presence-arena", { config: { broadcast: { self: false } } })
    .on("broadcast", { event: "arena" }, ({ payload }) => {
      const p = payload as ArenaPresence;
      if (!p?.userId || p.userId === _myUserId) return;
      _peers.set(p.userId, p);

      // TTL-based peer expiry — remove if no fresher message arrives
      setTimeout(() => {
        const current = _peers.get(p.userId);
        if (current && current.ts === p.ts) _peers.delete(p.userId);
      }, PRESENCE_TTL_MS);
    })
    .subscribe();
}

// ── Update local intent ────────────────────────────────────────────────────────

/**
 * Update what this user is currently doing on a task card.
 * Immediately queues a throttled broadcast to all peers.
 *
 * @param taskId  the task being interacted with, or null when leaving
 * @param intent  'browsing' | 'claiming' | 'idle'
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
  scheduleBroadcast();
}

function scheduleBroadcast(): void {
  if (_broadcastThrottle) return;
  _broadcastThrottle = setTimeout(() => {
    _broadcastThrottle = null;
    if (_localState && _channel) {
      _channel
        .send({ type: "broadcast", event: "arena", payload: _localState })
        .catch(() => {}); // fire-and-forget — presence is non-critical
    }
  }, THROTTLE_MS);
}

// ── Hover wiring ───────────────────────────────────────────────────────────────

/**
 * Attach a delegated mouseover listener to a task list container.
 * Hovering any [data-task-id] card broadcasts this user's presence on it.
 *
 * Idempotent — replaces any previous listener.
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

// ── Render presence badges ─────────────────────────────────────────────────────

/**
 * Paint floating colored avatar dots onto task cards based on current peer state.
 * Uses data-peer-id to diff — safe to call frequently without DOM churn.
 *
 * Dots are positioned in the top-right corner of each card, stacked horizontally.
 * A 'claiming' peer gets a fast pulse animation; 'browsing' gets a slow pulse.
 *
 * @param container  the scrollable task list container (e.g. #tasks-list)
 */
export function renderPresenceBadges(container: HTMLElement): void {
  // Build map: taskId → array of ArenaPresence
  const byTask = new Map<string, ArenaPresence[]>();
  for (const peer of _peers.values()) {
    if (!peer.taskId) continue;
    const existing = byTask.get(peer.taskId) ?? [];
    existing.push(peer);
    byTask.set(peer.taskId, existing);
  }

  // Remove dots for peers no longer on this card
  container.querySelectorAll<HTMLElement>(".ff-presence-dot").forEach((dot) => {
    const peerId = dot.dataset.peerId!;
    const taskId = dot.dataset.taskId!;
    const peer = _peers.get(peerId);
    if (!peer || peer.taskId !== taskId) dot.remove();
  });

  // Upsert dots for active peers
  for (const [taskId, peers] of byTask) {
    const card = container.querySelector<HTMLElement>(
      `[data-task-id="${taskId}"]`,
    );
    if (!card) continue;

    // Ensure card can anchor absolutely-positioned dots
    if (getComputedStyle(card).position === "static") {
      card.style.position = "relative";
    }

    peers.forEach((peer, i) => {
      let dot = card.querySelector<HTMLElement>(
        `[data-peer-id="${peer.userId}"]`,
      );

      if (!dot) {
        dot = document.createElement("div");
        dot.className = "ff-presence-dot";
        dot.dataset.peerId = peer.userId;
        dot.dataset.taskId = taskId;
        dot.setAttribute("aria-hidden", "true");
        dot.setAttribute(
          "title",
          peer.intent === "claiming"
            ? "Someone is claiming this..."
            : "Viewing",
        );
        card.appendChild(dot);
      }

      // Stack dots horizontally from top-right; animate by intent
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
        animation: ${
          peer.intent === "claiming"
            ? "ff-dot-pulse-fast"
            : "ff-dot-pulse"
        } 2s ease-in-out infinite;
      `;
    });
  }
}

// ── Heat rings ─────────────────────────────────────────────────────────────────

/**
 * Add a pulsing amber border glow to cards with 2+ simultaneous viewers.
 * Adds .ff-card--hot class and data-viewer-count attribute.
 * CSS handles the animation (see presence-arena.css).
 *
 * @param container  the scrollable task list container
 */
export function renderHeatRings(container: HTMLElement): void {
  const byTask = new Map<string, number>();
  for (const peer of _peers.values()) {
    if (!peer.taskId) continue;
    byTask.set(peer.taskId, (byTask.get(peer.taskId) ?? 0) + 1);
  }

  container.querySelectorAll<HTMLElement>("[data-task-id]").forEach((card) => {
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

// ── Teardown ───────────────────────────────────────────────────────────────────

/** Full cleanup — call in the page teardown return fn. */
export function teardownPresenceArena(): void {
  if (_broadcastThrottle) {
    clearTimeout(_broadcastThrottle);
    _broadcastThrottle = null;
  }
  if (_hoverListener && _hoverTarget) {
    _hoverTarget.removeEventListener("mouseover", _hoverListener);
    _hoverListener = null;
    _hoverTarget = null;
  }
  if (_channel) {
    _channel.unsubscribe().catch(() => {});
    _channel = null;
  }
  _peers.clear();
  _localState = null;
  _myUserId = null;
  _myColor = null;
}
