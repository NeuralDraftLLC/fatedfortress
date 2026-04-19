/**
 * components/FuelGauge.ts — Token quota fuel gauge for pooled rooms.
 *
 * Visual: ████░░░░ 420/1000 tokens left
 * Per-participant breakdown in tooltip/expanded view.
 *
 * Data source: FUEL postMessage from host's Fortress Worker.
 * Polling: every 30s when room is open.
 */

import { WorkerBridge, type FuelGaugeState } from "../net/worker-bridge.js";
import { type RoomId } from "@fatedfortress/protocol";

export class FuelGauge {
  private element: HTMLElement;
  private roomId: RoomId;
  private pollInterval: number | null = null;

  constructor(containerId: string, roomId: RoomId) {
    this.roomId = roomId;
    this.element = document.createElement("div");
    this.element.className = "fuel-gauge";
    this.element.style.fontFamily = "JetBrains Mono, monospace";
    this.element.style.border = "1px solid #000";
    this.element.style.padding = "8px";
    this.element.style.display = "inline-block";

    const container = document.getElementById(containerId);
    if (container) {
      container.appendChild(this.element);
    }

    this.startPolling();
  }

  public startPolling() {
    this.update();
    this.pollInterval = window.setInterval(() => this.update(), 30000);
  }

  public stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  private async update() {
    try {
      const state = await WorkerBridge.getInstance().requestFuelGauge(this.roomId);
      this.render(state);
    } catch (err) {
      console.error("Failed to update fuel gauge:", err);
      this.element.innerText = "Fuel: ERROR";
    }
  }

  private render(state: FuelGaugeState) {
    if (state.participants.length === 0) {
      this.element.innerText = "FREE ROOM (unlimited fuel)";
      return;
    }

    // Calculate aggregate fuel
    let totalConsumed = 0;
    let totalQuota = 0;
    for (const p of state.participants) {
      totalConsumed += p.consumed;
      totalQuota += p.quota;
    }

    const remaining = Math.max(0, totalQuota - totalConsumed);
    const fraction = totalQuota > 0 ? remaining / totalQuota : 0;
    const barWidth = 10;
    const filledBlocks = Math.round(fraction * barWidth);
    const emptyBlocks = barWidth - filledBlocks;

    const bar = "█".repeat(filledBlocks) + "░".repeat(emptyBlocks);

    // Build tooltip text
    const tooltip = state.participants
      .map((p) => `${p.pubkey.slice(0, 8)}...: ${p.quota - p.consumed}/${p.quota}`)
      .join("\n");

    this.element.title = `Per-participant breakdown:\n${tooltip}`;
    this.element.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px;">
        <span style="letter-spacing: -1px;">${bar}</span>
        <span>${remaining}/${totalQuota} tokens left</span>
      </div>
    `;
  }
}
