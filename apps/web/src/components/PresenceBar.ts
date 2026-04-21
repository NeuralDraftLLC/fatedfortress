/**
 * apps/web/src/components/PresenceBar.ts
 *
 * PRIORITY 2 · PresenceBar
 *
 * Renders a horizontal strip of participant avatars in the room header.
 * Each avatar is a deterministic SVG generated from the participant's avatarSeed.
 * A colored dot overlays the avatar corner to indicate presence state:
 *   active    → #22c55e (green)
 *   idle      → #eab308 (yellow)
 *   away      → #f97316 (orange)
 *   generating→ #3b82f6 (blue, pulsing)
 *   error     → #ef4444 (red)
 *   disconnected → #6b7280 (grey, dimmed)
 *
 * Tooltip on hover shows: displayName · state
 *
 * Usage:
 *   const bar = new PresenceBar(doc).mount(headerEl);
 *   bar.destroy(); // cleanup on room exit
 */

import type { FortressRoomDoc } from "../state/ydoc.js";
import type { PresenceEntry, PresenceState } from "../state/ydoc.js";

const STATE_COLORS: Record<PresenceState, string> = {
  active:      "#22c55e",
  idle:        "#eab308",
  away:        "#f97316",
  generating:  "#3b82f6",
  error:       "#ef4444",
  disconnected:"#6b7280",
};

const MAX_AVATARS = 8;

// ── Deterministic avatar ──────────────────────────────────────────────────────

/** Generate a deterministic pastel-colour SVG avatar from a seed string. */
function generateAvatarSvg(seed: string, size = 32): string {
  // Simple integer hash — good enough for avatar colours, no external deps.
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(h) % 360;
  const hue2 = (hue + 137) % 360; // approx complementary

  const c1 = `hsl(${hue},65%,55%)`;
  const c2 = `hsl(${hue2},50%,70%)`;
  const cx = size / 2;
  const r  = size / 2 - 1;

  // Deterministically pick a shape type (0=circle, 1=square, 2=triangle)
  const shapeType = Math.abs((h >> 4) & 3);

  let shape: string;
  if (shapeType === 0) {
    // Filled circle
    shape = `<circle cx="${cx}" cy="${cx}" r="${r}" fill="${c1}"/>`;
  } else if (shapeType === 1) {
    // Filled rounded rect
    shape = `<rect x="2" y="2" width="${size-4}" height="${size-4}" rx="6" fill="${c1}"/>`;
  } else {
    // Triangle
    const p = (v: number) => `${v * size}`;
    shape = `<polygon points="${p(0.5)},${p(0.08)} ${p(0.95)},${p(0.9)} ${p(0.05)},${p(0.9)}" fill="${c1}"/>`;
  }

  // Deterministically positioned accent dot
  const ax = cx + ((h >> 8) & 3) - 1.5;
  const ay = cx + ((h >> 10) & 3) - 1.5;
  const accent = `<circle cx="${ax}" cy="${ay}" r="${size * 0.12}" fill="${c2}" opacity="0.85"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${shape}${accent}</svg>`;
}

// ── PresenceBar class ─────────────────────────────────────────────────────────

export class PresenceBar {
  private doc: FortressRoomDoc;
  private el: HTMLElement;
  private unsubscribe: (() => void) | null = null;

  constructor(doc: FortressRoomDoc) {
    this.doc = doc;
    this.el = document.createElement("div");
    this.el.className = "ff-presence-bar";
    this.el.setAttribute("role", "list");
    this.el.setAttribute("aria-label", "Active participants");
  }

  mount(headerEl: HTMLElement): this {
    // Insert as the first child of the header
    headerEl.insertBefore(this.el, headerEl.firstChild);
    this.subscribe();
    return this;
  }

  destroy(): void {
    this.unsubscribe?.();
    this.el.remove();
  }

  private subscribe(): void {
    const render = () => {
      // Y.Map — iterate over values() directly
      const entries = Array.from(this.doc.presence.values()) as PresenceEntry[];
      const sorted = [...entries].sort((a, b) => {
        // Host first, then by join time
        const aHost = a.pubkey === (this.doc.meta.get("hostPubkey") as string) ? 0 : 1;
        const bHost = b.pubkey === (this.doc.meta.get("hostPubkey") as string) ? 0 : 1;
        return aHost - bHost || a.pubkey.localeCompare(b.pubkey);
      });

      const shown = sorted.slice(0, MAX_AVATARS);

      this.el.innerHTML = shown.map((entry) => {
        const color = STATE_COLORS[entry.state] ?? STATE_COLORS.disconnected;
        const initials = (entry.name ?? "?").slice(0, 2).toUpperCase();
        const isGenerating = entry.state === "generating";
        const pulseClass = isGenerating ? " ff-pb-pulse" : "";
        const tooltip = `${this.escape(entry.name)} · ${entry.state}`;

        return `
          <div class="ff-pb-avatar${isGenerating ? " ff-pb-generating" : ""}"
               role="listitem"
               title="${tooltip}"
               data-pubkey="${entry.pubkey}">
            <div class="ff-pb-svg" data-avatar-seed="${entry.avatarSeed}">
              ${generateAvatarSvg(entry.avatarSeed)}
            </div>
            <span class="ff-pb-initials" aria-hidden="true">${initials}</span>
            <span class="ff-pb-dot${pulseClass}"
                  style="background:${color}"
                  aria-hidden="true"></span>
          </div>`;
      }).join("");

      // Lazy-generate SVG avatars only on first render or avatarSeed change
      this.el.querySelectorAll<HTMLElement>("[data-avatar-seed]").forEach((el) => {
        const seed = el.dataset.avatarSeed ?? "";
        const existing = el.querySelector("svg");
        if (!existing) {
          el.innerHTML = generateAvatarSvg(seed);
        }
      });
    };

    this.doc.presence.observe(render);
    this.unsubscribe = () => this.doc.presence.unobserve(render);
    render(); // initial render
  }

  private escape(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
}
