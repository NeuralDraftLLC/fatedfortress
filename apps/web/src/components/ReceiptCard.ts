// apps/web/src/components/ReceiptCard.ts
import type { Receipt } from "../state/vault.js";

export interface ReceiptData {
  id: string;
  hash?: string;
  model?: string;
  timestamp?: number;
  prompt?: string;
  parentId?: string;
  /** Multi-line ASCII fork / chain line(s) for display */
  forkLines?: string;
}

export class ReceiptCard {
  private receipt: ReceiptData;

  constructor(receipt: ReceiptData) {
    this.receipt = receipt;
  }

  mount(el: HTMLElement): void {
    const time = this.receipt.timestamp
      ? new Date(this.receipt.timestamp).toLocaleString(undefined, {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "·· pending ··";
    const forkBlock =
      this.receipt.forkLines?.trim() ?? this.defaultForkLines();
    const modelLabel = this.receipt.model ?? "unknown";
    const hashDisplay = this.receipt.hash ?? "PENDING_DIGEST";
    const promptPreview = this.receipt.prompt
      ? `<p class="receipt-prompt">${this.escapeHtml(this.receipt.prompt.slice(0, 140))}${this.receipt.prompt.length > 140 ? "…" : ""}</p>`
      : "";

    const card = document.createElement("article");
    card.className = "receipt-card";
    card.innerHTML = `
      <div class="receipt-card__ribbon">
        <span>SIGNED RECEIPT · LOCAL VAULT</span>
        <span class="receipt-card__ribbon-end">IMMUTABLE</span>
      </div>
      <div class="receipt-card__body">
        <pre class="receipt-tree">${this.escapeHtml(forkBlock)}</pre>
        <div class="receipt-meta">
          <span class="receipt-model">${this.escapeHtml(modelLabel)}</span>
          <span class="receipt-time">${this.escapeHtml(time)}</span>
        </div>
        <div class="receipt-digest-label">OUTPUT DIGEST</div>
        <pre class="receipt-hash">${this.escapeHtml(hashDisplay)}</pre>
        ${promptPreview}
      </div>
    `;

    card.addEventListener("click", () => {
      window.dispatchEvent(new CustomEvent("receipt:focus", { detail: { id: this.receipt.id } }));
    });

    el.appendChild(card);
  }

  private defaultForkLines(): string {
    const short = this.receipt.id.slice(0, 10);
    if (!this.receipt.parentId) {
      return `● GENESIS LINE\n   id  ${short}`;
    }
    const p = this.receipt.parentId.slice(0, 10);
    return `└─ FORK (child of parent chain)\n   id  ${short}\n   ←  ${p}`;
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
}

/** Build richer fork graph text from a flat receipt list (newest-first or any order). */
export function buildForkLines(receipt: Receipt, all: Receipt[]): string {
  const idS = receipt.id.slice(0, 10);
  if (!receipt.parentId) {
    return `● ROOT\n   ${idS}`;
  }
  const parent = all.find((r) => r.id === receipt.parentId);
  const p = receipt.parentId.slice(0, 10);
  if (!parent) {
    return `└─ FORK\n   ${idS}\n   ←  ${p}  (parent not loaded)`;
  }
  const pp = parent.id.slice(0, 10);
  return `└─ FORK\n   ${idS}\n   ←  ${p}  [parent ${pp}]`;
}
