// apps/web/src/pages/table.ts
import type { PaletteIntent } from "@fatedfortress/protocol";
import { safeStorage, KEY_HERENOW_TOKEN, KEY_ROOMS_CACHE } from "../util/storage.js";
import { RoomCard } from "../components/RoomCard.js";

interface RoomEntry {
  id: string;
  name: string;
  category: string;
  hostPubkey: string;
  access: "free" | "paid";
  price?: number;
  fuelLevel?: number;
}

let _rooms: RoomEntry[] = [];
let _listenersAttached = false;

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
    <div class="table-header">
      <h1>FATEDFORTRESS</h1>
      <p class="table-sub">Collaborative AI generation rooms</p>
      <div class="table-actions">
        <button type="button" class="btn-primary btn-create-room" id="btn-create-room">CREATE ROOM</button>
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

  // Load rooms
  loadRooms().then(() => {
    renderRooms(container);
  });

  return () => {
    container.innerHTML = "";
  };
}

async function loadRooms(): Promise<void> {
  // Token + cache paths use safeStorage — embed-safe (Phase 5); keys unchanged for upgrades
  try {
    const token = safeStorage.getItem(KEY_HERENOW_TOKEN);
    if (!token) {
      _rooms = getCachedRooms();
      return;
    }

    const response = await fetch("https://api.here.now/v1/rooms", {
      headers: {
        "Authorization": `Bearer ${token}`,
        "X-Client": "fatedfortress",
      },
    });

    if (!response.ok) {
      console.warn("[table] Failed to fetch rooms:", response.status);
      _rooms = getCachedRooms();
      return;
    }

    const data = await response.json() as { rooms?: RoomEntry[] };
    _rooms = data.rooms ?? [];
    cacheRooms(_rooms);
  } catch (err) {
    console.warn("[table] Room discovery failed, using cache:", err);
    _rooms = getCachedRooms();
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
  // Built-in sample rooms for demo purposes
  return [
    {
      id: "rm_demo001",
      name: "AI Coding Lounge",
      category: "code",
      hostPubkey: "DemoHost001",
      access: "free",
      fuelLevel: 75,
    },
    {
      id: "rm_demo002",
      name: "Animation Studio",
      category: "animation",
      hostPubkey: "DemoHost002",
      access: "paid",
      price: 100,
      fuelLevel: 40,
    },
  ];
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
  const grid = document.getElementById("room-grid");
  if (!grid) return;
  renderRoomsToGrid(_rooms);
}

function renderRoomsToGrid(rooms: RoomEntry[]): void {
  const grid = document.getElementById("room-grid");
  if (!grid) return;

  if (rooms.length === 0) {
    grid.innerHTML = `<p class="empty-msg">No rooms match your search. Try a different query or create a new room.</p>`;
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
