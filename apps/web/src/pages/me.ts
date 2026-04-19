// apps/web/src/pages/me.ts
import { getReceipts } from "../state/vault.js";
import type { Receipt } from "../state/vault.js";
import { ReceiptCard, buildForkLines } from "../components/ReceiptCard.js";

export async function mountMe(container: HTMLElement): Promise<() => void> {
  container.innerHTML = `
    <div class="me-header">
      <h1>MY RECEIPTS</h1>
      <p class="me-sub">Your generation history</p>
    </div>
    <div class="receipt-list" id="receipt-list">
      <p class="loading-msg">Loading receipts...</p>
    </div>
  `;

  try {
    const receipts: Receipt[] = await getReceipts();
    const list = document.getElementById("receipt-list")!;

    if (receipts.length === 0) {
      list.innerHTML = `<p class="empty-msg">No receipts yet. Your generation receipts will appear here.</p>`;
    } else {
      // Sort newest first
      const sorted = [...receipts].sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
      list.innerHTML = "";

      for (const receipt of sorted) {
        const item = document.createElement("div");
        item.className = "receipt-item";
        const forkLines = buildForkLines(receipt, sorted);
        const card = new ReceiptCard({ ...receipt, forkLines });
        card.mount(item);
        list.appendChild(item);
      }
    }
  } catch (err) {
    const list = document.getElementById("receipt-list")!;
    list.innerHTML = `<p class="error-msg">Failed to load receipts: ${err}</p>`;
  }

  return () => { container.innerHTML = ""; };
}
