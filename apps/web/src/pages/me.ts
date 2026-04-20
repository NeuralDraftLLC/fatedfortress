// apps/web/src/pages/me.ts
import { getReceipts } from "../state/vault.js";
import type { Receipt } from "../state/vault.js";
import { ReceiptCard, buildForkLines } from "../components/ReceiptCard.js";
import { exportIdentity, importIdentity, type IdentityExport } from "../state/identity.js";
import { getMyPubkey } from "../state/identity.js";

// ─── PRIORITY 3: Identity Export / Import UI ───────────────────────────────────

function renderIdentitySection(container: HTMLElement): void {
  const section = document.createElement("section");
  section.className = "ff-me-identity";
  section.innerHTML = `
    <h2>Your identity</h2>
    <p class="ff-text-muted">
      Your Ed25519 pubkey signs every receipt you create. Export it to a
      passphrase-protected file so you don't lose your history if you clear
      site data or switch devices.
    </p>
    <div class="ff-me-identity-actions">
      <button data-action="export" type="button">Export identity</button>
      <button data-action="import" type="button">Import identity</button>
    </div>
    <input type="file" data-role="import-file" accept=".json" hidden />
  `;

  const exportBtn = section.querySelector('[data-action="export"]') as HTMLButtonElement;
  const importBtn = section.querySelector('[data-action="import"]') as HTMLButtonElement;
  const fileInput = section.querySelector('[data-role="import-file"]') as HTMLInputElement;

  exportBtn.addEventListener("click", async () => {
    const passphrase = await promptPassphrase(
      "Choose a passphrase to protect your export (min 12 characters)",
    );
    if (!passphrase) return;

    try {
      const envelope = await exportIdentity(passphrase);
      downloadJSON("fated-fortress-identity.json", envelope);
    } catch (err) {
      alert(`Export failed: ${(err as Error).message}`);
    }
  });

  importBtn.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;

    const confirmed = confirm(
      "Importing will REPLACE your current identity permanently. " +
        "Your current device identity will be UNRECOVERABLE unless you have " +
        "already exported it. Continue?",
    );
    if (!confirmed) return;

    const passphrase = await promptPassphrase("Enter the passphrase for this export");
    if (!passphrase) return;

    try {
      const text = await file.text();
      const envelope = JSON.parse(text) as IdentityExport;
      const result = await importIdentity(envelope, passphrase);
      alert(`Identity restored. Pubkey: ${result.pubkey.slice(0, 16)}…`);
      window.location.reload();
    } catch (err) {
      alert(`Import failed: ${(err as Error).message}`);
    }
  });

  container.appendChild(section);
}

// ─── PRIORITY 3: Fork-Receipt Action ─────────────────────────────────────────

/**
 * Adds a "Fork this receipt" button to a ReceiptCard element.
 * Clicking navigates to /room?seed=<receiptId> where the room pre-fills from the receipt.
 */
function attachForkAction(cardEl: HTMLElement, receipt: Receipt): void {
  const forkBtn = document.createElement("button");
  forkBtn.className = "ff-receipt-fork";
  forkBtn.type = "button";
  forkBtn.textContent = "Fork this receipt →";
  forkBtn.addEventListener("click", () => {
    const url = new URL(window.location.href);
    url.hash = `#/room?seed=${encodeURIComponent(receipt.id)}`;
    window.location.href = url.toString();
  });
  cardEl.appendChild(forkBtn);
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

async function promptPassphrase(label: string): Promise<string | null> {
  const value = prompt(label);
  return value && value.length >= 12 ? value : null;
}

function downloadJSON(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ─── Main mount ────────────────────────────────────────────────────────────────

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

  // ── Identity section ─────────────────────────────────────────────────
  renderIdentitySection(container);

  // ── Receipts list ───────────────────────────────────────────────────
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
        attachForkAction(item, receipt); // PRIORITY 3: fork CTA
        list.appendChild(item);
      }
    }
  } catch (err) {
    const list = document.getElementById("receipt-list")!;
    list.innerHTML = `<p class="error-msg">Failed to load receipts: ${err}</p>`;
  }

  return () => { container.innerHTML = ""; };
}
