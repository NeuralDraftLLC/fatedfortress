// apps/web/src/components/RoomCard.ts

export interface RoomCardData {
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

export class RoomCard {
  private room: RoomCardData;

  constructor(room: RoomCardData) {
    this.room = room;
  }

  mount(el: HTMLElement): void {
    const truncatedHost = this.room.hostPubkey.length > 8
      ? this.room.hostPubkey.slice(0, 8) + "…"
      : this.room.hostPubkey;
    const priceBadge = this.room.access === "paid"
      ? `<span class="price-badge">$${this.room.price} USDC</span>`
      : `<span class="price-badge free">FREE</span>`;

    const participants = this.room.participantCount ?? 0;
    const spectators = this.room.spectatorCount ?? 0;
    const countLabel = participants > 0
      ? `${participants} ▲ ${spectators} ◉`
      : `${spectators} ◉ spectating`;

    const fuelPct = this.room.fuelLevel ?? 100;
    const fuelBar = `
      <div class="room-card-fuel">
        <div class="fuel-bar">
          <div class="fuel-fill" style="width:${fuelPct}%"></div>
        </div>
        <span class="fuel-label">${Math.round(fuelPct * 100)}%</span>
      </div>`;

    const card = document.createElement("div");
    card.className = "room-card";
    card.innerHTML = `
      <div class="room-card-header">
        <span class="category-glyph">[${this.room.category.toUpperCase().slice(0, 4)}]</span>
        <span class="room-name">${this.escapeHtml(this.room.name)}</span>
      </div>
      <div class="room-meta">
        <span class="host-pubkey">@${this.escapeHtml(truncatedHost)}</span>
        ${priceBadge}
      </div>
      <div class="room-counts">${countLabel}</div>
      ${fuelBar}
      <div class="room-actions">
        <button class="btn-join" data-room="${this.room.id}">JOIN</button>
        <button class="btn-spectate" data-room="${this.room.id}">SPECTATE</button>
      </div>
    `;

    card.querySelector(".btn-join")?.addEventListener("click", () => {
      window.history.pushState({}, "", `/room/${this.room.id}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    card.querySelector(".btn-spectate")?.addEventListener("click", () => {
      window.history.pushState({}, "", `/spectate/${this.room.id}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    el.appendChild(card);
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
}
