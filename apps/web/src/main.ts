/**
 * apps/web/src/main.ts — SPA shell: URL → page mount, palette, identity bootstrap.
 *
 * Routing: `/spectate/:id` is handled before the generic `/(\w+)/` matcher so spectate
 * never falls through to `table`. Palette commands that need room state use
 * `getActiveRoomDocIfSet()` only when `_currentPage === "room"`.
 *
 * Intents: `palette:select` → `dispatchIntent`; room-specific handlers listen on
 * `palette:intent` from pages (e.g. room.ts).
 */
import { openPalette, buildPaletteContext } from "./components/Palette/index.js";
import { showWelcomeModal } from "./components/WelcomeModal.js";
import { hasSeenWelcome } from "./util/storage.js";
import { createIdentity } from "./state/identity.js";
import { handleUpgradeRoom } from "./handlers/upgrade.js";
import { getActiveRoomDocIfSet } from "./state/ydoc.js";
import type { PaletteIntent } from "@fatedfortress/protocol";

const APP_ROOT = "#app";

function getContainer(): HTMLElement {
  let app = document.querySelector<HTMLElement>(APP_ROOT);
  if (!app) {
    app = document.createElement("div");
    app.id = "app";
    document.body.appendChild(app);
  }
  app.innerHTML = "";
  return app;
}

// ── Page tracking ───────────────────────────────────────────────────────────────

type PageName = "table" | "room" | "connect" | "me";
let _currentPage: PageName = "table";

function setCurrentPage(page: PageName): void {
  _currentPage = page;
}

function getCurrentPage(): PageName {
  return _currentPage;
}

// ── Page mount functions ───────────────────────────────────────────────────────

const router: Record<string, () => Promise<(() => void) | void>> = {
  table: async () => {
    setCurrentPage("table");
    const { mountTable } = await import("./pages/table.js");
    const container = getContainer();
    return mountTable(container);
  },
  room: async () => {
    setCurrentPage("room");
    const { mountRoom } = await import("./pages/room.js");
    const container = getContainer();
    const pathParts = window.location.pathname.split("/");
    const roomId = pathParts[2] || "rm_default";
    return mountRoom(roomId, container);
  },
  connect: async () => {
    setCurrentPage("connect");
    const { mountConnect } = await import("./pages/connect.js");
    const container = getContainer();
    return mountConnect(container);
  },
  me: async () => {
    setCurrentPage("me");
    const { mountMe } = await import("./pages/me.js");
    const container = getContainer();
    return mountMe(container);
  },
};

// Each page mount() returns an optional cleanup/unmount function
let currentUnmount: (() => void) | null = null;

async function route(path: string) {
  currentUnmount?.();
  currentUnmount = null;

  const spectateMatch = path.match(/^\/spectate\/(.+)/);
  if (spectateMatch) {
    setCurrentPage("room");
    const { mountRoom } = await import("./pages/room.js");
    const container = getContainer();
    currentUnmount = await mountRoom(spectateMatch[1], container, { spectate: true }) ?? null;
    return;
  }

  const roomMatch = path.match(/^\/room\/(.+)/);
  if (roomMatch) {
    window.history.replaceState({}, "", `/room/${roomMatch[1]}`);
  }

  const [, page] = path.match(/^\/(\w+)/) ?? [];
  // Root "/" explicitly redirects to /table so the lobby is the default landing screen.
  if (path === "/" || !page || !(page in router)) {
    window.history.replaceState({}, "", "/table");
    currentUnmount = null;
    return;
  }
  const mountFn = router[page as keyof typeof router];

  try {
    const unmount = await mountFn();
    currentUnmount = unmount ?? null;
  } catch (err) {
    console.error(`[main] Failed to mount page "${page}":`, err);
  }
}

// ── Intent dispatcher ─────────────────────────────────────────────────────────

async function dispatchIntent(intent: PaletteIntent): Promise<void> {
  switch (intent.type) {
    case "upgrade_room": {
      const doc = getActiveRoomDocIfSet();
      if (doc) {
        await handleUpgradeRoom(intent, doc);
      } else {
        console.warn("[dispatch] upgrade_room but no active room doc");
      }
      break;
    }
    default:
      window.dispatchEvent(new CustomEvent("palette:intent", { detail: { intent } }));
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function init() {
  try {
    await createIdentity();
  } catch (err) {
    console.warn("[main] Could not create identity:", err);
  }

  if (!hasSeenWelcome()) {
    // safeStorage: no throw in sandboxed embeds (Phase 5 #6)
    showWelcomeModal();
  }

  await route(window.location.pathname);

  window.addEventListener("popstate", () => {
    route(window.location.pathname);
  });

  window.addEventListener("palette:select", async (e: Event) => {
    const { intent } = (e as CustomEvent).detail as { intent: PaletteIntent };
    await dispatchIntent(intent);
  });
}

// ── Palette shortcut ─────────────────────────────────────────────────────────

function openPaletteWithContext(): void {
  const page = getCurrentPage();
  const roomDoc = page === "room" ? getActiveRoomDocIfSet() ?? null : null;

  const ctx = buildPaletteContext({
    currentPage: page,
    roomDoc,
    focusedReceiptId: null,
    currentModel: null,
    keyValidated: false,
    fuelLevel: null,
    herenowLinked: false,
  });
  openPalette(ctx);
}

window.addEventListener("keydown", (e) => {
  if (
    e.target instanceof HTMLInputElement ||
    e.target instanceof HTMLTextAreaElement ||
    (e.target instanceof HTMLElement && e.target.isContentEditable)
  ) return;

  if (e.key === "/" && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    openPaletteWithContext();
  }
});

// ── Service worker (production only) ──────────────────────────────────────────

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(console.error);
}

// ── Start app ─────────────────────────────────────────────────────────────────

init();
