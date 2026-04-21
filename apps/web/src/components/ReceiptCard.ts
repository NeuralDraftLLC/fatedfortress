// apps/web/src/components/ReceiptCard.ts
import type { Receipt } from "../state/vault.js";
import { resolveOpfsUrl } from "../net/archive.js";

export interface ReceiptData {
  id: string;
  hash?: string;
  model?: string;
  timestamp?: number;
  prompt?: string;
  parentId?: string;
  /** Multi-line ASCII fork / chain line(s) for display */
  forkLines?: string;
  /** Room type: text (default), image, audio, video */
  type?: "text" | "image" | "audio" | "video";
  /** opfs:// URLs of generated images (for re-archiving on publish) */
  outputUrls?: string[];
  /** SHA-256 of reference image used to generate this receipt (image rooms only) */
  referenceImageHash?: string;
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

    const isImage = this.receipt.type === "image";

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
        ${isImage ? `
        <div class="receipt-card__actions">
          <button class="receipt-publish-btn" type="button">Publish to here.now</button>
          <span class="receipt-publish-status" id="publish-status-${this.receipt.id}"></span>
        </div>` : ""}
      </div>
    `;

    if (isImage) {
      const publishBtn = card.querySelector(".receipt-publish-btn") as HTMLButtonElement;
      const statusEl = card.querySelector(`#publish-status-${this.receipt.id}`) as HTMLElement;
      publishBtn?.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!publishBtn || !statusEl) return;
        publishBtn.disabled = true;
        statusEl.textContent = "Publishing…";
        try {
          // Re-archive from OPFS: fetch each opfs:// URL, re-upload to here.now
          const urls = this.receipt.outputUrls ?? [];
          const publishedUrls: string[] = [];
          for (const url of urls) {
            if (url.startsWith("opfs://")) {
              const resolved = await resolveOpfsUrl(url);
              if (!resolved) continue;
              const res = await fetch(resolved);
              const blob = await res.blob();
              // Dynamically import archiveAndUpload to keep bundle split
              const { archiveAndUpload } = await import("../net/archive.js");
              const permUrl = await archiveAndUpload(
                blob,
                "receipt", // roomId
                `image-${Date.now()}.png`
              );
              if (permUrl) publishedUrls.push(permUrl);
            } else {
              // Already a permanent URL
              publishedUrls.push(url);
            }
          }
          if (publishedUrls.length > 0) {
            statusEl.textContent = `Published ${publishedUrls.length} image(s)!`;
            statusEl.style.color = "green";
          } else {
            statusEl.textContent = "No images to publish";
          }
        } catch (err) {
          statusEl.textContent = "Publish failed";
          statusEl.style.color = "red";
          console.error("[ReceiptCard] publish failed:", err);
        } finally {
          publishBtn.disabled = false;
        }
      });
    }

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
