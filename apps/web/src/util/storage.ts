/**
 * apps/web/src/util/storage.ts — Phase 5 Medium #6: iframe-safe storage.
 *
 * Sandboxed iframes without allow-same-origin throw SecurityError on localStorage.
 * SafeStorage probes once; on failure all operations use an in-memory Map.
 */

class SafeStorage {
  public readonly available: boolean;
  private fallback = new Map<string, string>();

  constructor() {
    this.available = this.probe(); // single shot — avoids throwing on every read in embeds
  }

  /** Any throw ⇒ treat storage as unavailable (sandboxed iframe, quota, privacy mode). */
  private probe(): boolean {
    try {
      const key = `__ff_probe_${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(key, "1");
      localStorage.removeItem(key);
      return true;
    } catch {
      return false;
    }
  }

  getItem(key: string): string | null {
    if (!this.available) return this.fallback.get(key) ?? null;
    try {
      return localStorage.getItem(key);
    } catch {
      // Mid-session SecurityError — degrade for this read only
      return this.fallback.get(key) ?? null;
    }
  }

  setItem(key: string, value: string): void {
    if (!this.available) {
      this.fallback.set(key, value);
      return;
    }
    try {
      localStorage.setItem(key, value);
    } catch {
      // Quota / revoke — keep session usable in RAM
      this.fallback.set(key, value);
    }
  }

  removeItem(key: string): void {
    this.fallback.delete(key); // always clear shadow copy
    if (!this.available) return;
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }

  getBoolean(key: string): boolean {
    const val = this.getItem(key);
    return val === "1" || val === "true";
  }

  setBoolean(key: string, value: boolean): void {
    this.setItem(key, value ? "1" : "0");
  }
}

export const safeStorage = new SafeStorage();

const KEY_WELCOME = "ff:hasSeenWelcome";
const KEY_PALETTE = "ff:hasSeenPalette";
const KEY_THEME = "ff:preferredTheme";
const KEY_LAST_ROOM = "ff:lastOpenedRoomId";
const KEY_DISMISSED = "ff:dismissedBanners";

/** herenow / table cache keys — keep string literals stable for existing users */
export const KEY_HERENOW_TOKEN = "herenow_token";
export const KEY_ROOMS_CACHE = "ff_rooms_cache";

export function hasSeenWelcome(): boolean {
  return safeStorage.getBoolean(KEY_WELCOME);
}

export function markWelcomeSeen(): void {
  safeStorage.setBoolean(KEY_WELCOME, true);
}

export function hasSeenPalette(): boolean {
  return safeStorage.getBoolean(KEY_PALETTE);
}

export function markPaletteSeen(): void {
  safeStorage.setBoolean(KEY_PALETTE, true);
}

export function getPreferredTheme(): "light" | "dark" | null {
  const t = safeStorage.getItem(KEY_THEME);
  if (t === "light" || t === "dark") return t;
  return null;
}

export function setPreferredTheme(theme: "light" | "dark"): void {
  safeStorage.setItem(KEY_THEME, theme);
}

export function getLastOpenedRoomId(): string | null {
  return safeStorage.getItem(KEY_LAST_ROOM);
}

export function setLastOpenedRoomId(roomId: string): void {
  safeStorage.setItem(KEY_LAST_ROOM, roomId);
}

export function isBannerDismissed(bannerId: string): boolean {
  try {
    const raw = safeStorage.getItem(KEY_DISMISSED);
    if (!raw) return false;
    return (JSON.parse(raw) as string[]).includes(bannerId);
  } catch {
    return false;
  }
}

export function dismissBanner(bannerId: string): void {
  try {
    const raw = safeStorage.getItem(KEY_DISMISSED);
    const list: string[] = raw ? JSON.parse(raw) : [];
    if (!list.includes(bannerId)) {
      list.push(bannerId);
      safeStorage.setItem(KEY_DISMISSED, JSON.stringify(list));
    }
  } catch {
    /* non-fatal */
  }
}
