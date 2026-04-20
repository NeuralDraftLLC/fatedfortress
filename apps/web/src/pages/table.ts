// apps/web/src/pages/table.ts
import type { PaletteIntent } from "@fatedfortress/protocol";
import { safeStorage, KEY_HERENOW_TOKEN, KEY_ROOMS_CACHE } from "../util/storage.js";
import { RoomCard } from "../components/RoomCard.js";

export interface RoomEntry {
  id: string;
  name: string;
  category: string;
  hostPubkey: string;
  access: "free" | "paid";
  price?: number;
  fuelLevel?: number;
  participantCount?: number;
  spectatorCount?: number;
}

let _rooms: RoomEntry[] = [];
let _listenersAttached = false;
let _autoRefreshTimer: ReturnType<typeof setTimeout> | null = null;

function attachIntentListeners() {
  if (_listenersAttached) return;
  _listenersAttached = true;

  window.addEventListener("palette:intent", (e: Event) => {
    const { intent } = (e as CustomEvent).detail as { intent: PaletteIntent };
    switch (intent.type) {
      case "search": {
        if (intent.query || intent.category) {
          filterAndRender(intent.category ?? null, intent.query ?? "");
        }
        break;
      }
      case "create_room": {
        const roomId = `rm_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
        window.history.pushState({}, "", `/room/${roomId}`);
        window.dispatchEvent(new PopStateEvent("popstate"));
        break;
      }
      default:
        break;
    }
  });
}

export function mountTable(container: HTMLElement): () => void {
  attachIntentListeners();

  container.innerHTML = `
    <div class="lobby-hero">
      <h1>FATEDFORTRESS</h1>
      <p class="lobby-hero__sub">Collaborative AI generation rooms</p>
      <div class="lobby-hero__actions">
        <button type="button" class="btn-primary btn-create-room" id="btn-create-room">Create Public Room</button>
      </div>
    </div>
    <div class="room-grid" id="room-grid">
      <p class="loading-msg">Loading rooms...</p>
    </div>
  `;

  document.getElementById("btn-create-room")?.addEventListener("click", () => {
    const roomId = `rm_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    window.history.pushState({}, "", `/room/${roomId}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });

  loadRooms().then(() => {
    renderRooms(container);
    startAutoRefresh(container);
  });

  return () => {
    if (_autoRefreshTimer !== null) {
      clearTimeout(_autoRefreshTimer);
      _autoRefreshTimer = null;
    }
    container.innerHTML = "";
  };
}

async function loadRooms(): Promise<void> {
  // 1. Fetch live rooms from relay HTTP endpoint (primary source).
  const relayRooms = await fetchFromRelay();
  if (relayRooms.length > 0) {
    _rooms = relayRooms;
    cacheRooms(_rooms);
    return;
  }

  // 2. Fall back to here.now published rooms.
  try {
    const token = safeStorage.getItem(KEY_HERENOW_TOKEN);
    if (token) {
      const response = await fetch("https://api.here.now/v1/rooms", {
        headers: {
          "Authorization": `Bearer ${token}`,
          "X-Client": "fatedfortress",
        },
      });
      if (response.ok) {
        const data = await response.json() as { rooms?: RoomEntry[] };
        if (data.rooms && data.rooms.length > 0) {
          _rooms = data.rooms;
          cacheRooms(_rooms);
          return;
        }
      }
    }
  } catch {
    /* fall through to cache */
  }

  // 3. Use cached rooms as last resort.
  _rooms = getCachedRooms();
}

async function fetchFromRelay(): Promise<RoomEntry[]> {
  try {
    // VITE_RELAY_URL is set in wrangler / dev environment; fall back gracefully.
    const relayBase =
      (import.meta.env.VITE_RELAY_URL as string | undefined) ??
      "https://relay.fatedfortress.com";
    const res = await fetch(`${relayBase}/rooms`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return [];
    const data = await res.json() as { rooms?: RoomEntry[] };
    return data.rooms ?? [];
  } catch {
    return [];
  }
}

function getCachedRooms(): RoomEntry[] {
  try {
    const cached = safeStorage.getItem(KEY_ROOMS_CACHE);
    return cached ? JSON.parse(cached) : getDefaultRooms();
  } catch {
    return getDefaultRooms();
  }
}

function cacheRooms(rooms: RoomEntry[]): void {
  try {
    safeStorage.setItem(KEY_ROOMS_CACHE, JSON.stringify(rooms));
  } catch {}
}

function getDefaultRooms(): RoomEntry[] {
  return [
    {
      id: "rm_demo001",
      name: "AI Coding Lounge",
      category: "code",
      hostPubkey: "DemoHost001",
      access: "free",
      fuelLevel: 75,
      participantCount: 0,
      spectatorCount: 0,
    },
    {
      id: "rm_demo002",
      name: "Animation Studio",
      category: "animation",
      hostPubkey: "DemoHost002",
      access: "paid",
      price: 100,
      fuelLevel: 40,
      participantCount: 0,
      spectatorCount: 0,
    },
  ];
}

function startAutoRefresh(container: HTMLElement): void {
  _autoRefreshTimer = setTimeout(async () => {
    await loadRooms();
    renderRooms(container);
    startAutoRefresh(container);
  }, 15_000);
}

function filterAndRender(category: string | null, query: string): void {
  const filtered = _rooms.filter((r) => {
    const matchesCategory = !category || r.category === category;
    const matchesQuery = !query ||
      r.name.toLowerCase().includes(query.toLowerCase()) ||
      r.hostPubkey.toLowerCase().includes(query.toLowerCase());
    return matchesCategory && matchesQuery;
  });
  renderRoomsToGrid(filtered);
}

function renderRooms(container: HTMLElement): void {
  renderRoomsToGrid(_rooms);
}

function renderRoomsToGrid(rooms: RoomEntry[]): void {
  const grid = document.getElementById("room-grid");
  if (!grid) return;

  if (rooms.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-state__icon">◈</div>
        <p class="empty-state__title">No public rooms right now</p>
        <p class="empty-state__sub">Be the first to create one and start a jam.</p>
        <div class="empty-state__arrow" aria-hidden="true">↓</div>
        <div class="empty-state__cta">
          <button type="button" class="btn-primary btn-create-room" id="btn-create-room-empty">Create Public Room</button>
        </div>
      </div>`;
    grid.querySelector("#btn-create-room-empty")?.addEventListener("click", () => {
      const roomId = `rm_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
      window.history.pushState({}, "", `/room/${roomId}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    return;
  }

  grid.innerHTML = "";
  for (const room of rooms) {
    const item = document.createElement("div");
    item.className = "room-card-wrapper";
    const card = new RoomCard(room);
    card.mount(item);
    grid.appendChild(item);
  }
}
