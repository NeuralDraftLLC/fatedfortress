// apps/web/src/pages/me.ts
import { getReceipts } from "../state/vault.js";
import type { Receipt } from "../state/vault.js";
import { ReceiptCard, buildForkLines } from "../components/ReceiptCard.js";
import { exportIdentity, importIdentity, type IdentityExport } from "../state/identity.js";
import { getMyPubkey } from "../state/identity.js";

// ─── Fork tree graph ──────────────────────────────────────────────────────────────

interface GraphNode {
  receipt: Receipt;
  children: GraphNode[];
}

/** Build a directed acyclic graph of receipts by parentId. */
function buildReceiptGraph(receipts: Receipt[]): GraphNode[] {
  const byId = new Map<string, Receipt>();
  for (const r of receipts) byId.set(r.id, r);

  const roots: GraphNode[] = [];
  const nodes = new Map<string, GraphNode>();

  for (const r of receipts) {
    nodes.set(r.id, { receipt: r, children: [] });
  }

  for (const [, node] of nodes) {
    const parentId = node.receipt.parentId;
    if (parentId && nodes.has(parentId)) {
      nodes.get(parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

/** Render the fork tree as a CSS grid with ASCII art. */
function renderReceiptMap(receipts: Receipt[], container: HTMLElement): void {
  if (receipts.length === 0) {
    container.innerHTML = `<p class="empty-msg">No receipts to visualize.</p>`;
    return;
  }

  const graph = buildReceiptGraph(receipts);

  const renderNode = (node: GraphNode, depth: number): string => {
    const short = node.receipt.id.slice(0, 10);
    const model = node.receipt.model ?? "unknown";
    const prefix = depth === 0 ? "●" : "├─";
    const indent = "  ".repeat(depth);
    const childrenHtml = node.children.map((child) => renderNode(child, depth + 1)).join("");
    return `<div class="receipt-tree-node"><span class="receipt-tree-prefix">${indent}${prefix}</span> <span class="receipt-tree-id">${short}</span> <span class="receipt-tree-model">${model}</span></div>${childrenHtml}`;
  };

  container.innerHTML = `<div class="receipt-map">${graph.map((root) => renderNode(root, 0)).join("")}</div>`;
}

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
    <div class="me-tabs" id="me-tabs">
      <button class="me-tab me-tab--active" data-tab="list">Receipts</button>
      <button class="me-tab" data-tab="map">Receipt Map</button>
    </div>
    <div class="receipt-list" id="receipt-list"></div>
    <div class="receipt-map-container" id="receipt-map-container" style="display:none"></div>
  `;

  // ── Identity section ─────────────────────────────────────────────────
  renderIdentitySection(container);

  // ── Tabs ───────────────────────────────────────────────────────────
  const listEl = document.getElementById("receipt-list")!;
  const mapEl = document.getElementById("receipt-map-container")!;
  listEl.innerHTML = `<p class="loading-msg">Loading receipts...</p>`;

  container.querySelectorAll<HTMLButtonElement>(".me-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      container.querySelectorAll(".me-tab").forEach((t) => t.classList.remove("me-tab--active"));
      tab.classList.add("me-tab--active");
      const tabName = tab.dataset.tab;
      if (tabName === "map") {
        listEl.style.display = "none";
        mapEl.style.display = "block";
      } else {
        listEl.style.display = "block";
        mapEl.style.display = "none";
      }
    });
  });

  // ── Receipts list ───────────────────────────────────────────────────
  try {
    const receipts: Receipt[] = await getReceipts();

    if (receipts.length === 0) {
      listEl.innerHTML = `<p class="empty-msg">No receipts yet. Your generation receipts will appear here.</p>`;
    } else {
      const sorted = [...receipts].sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
      listEl.innerHTML = "";

      for (const receipt of sorted) {
        const item = document.createElement("div");
        item.className = "receipt-item";
        const forkLines = buildForkLines(receipt, sorted);
        const card = new ReceiptCard({ ...receipt, forkLines });
        card.mount(item);
        attachForkAction(item, receipt);
        listEl.appendChild(item);
      }

      // Render map (hidden by default)
      renderReceiptMap(receipts, mapEl);
    }
  } catch (err) {
    listEl.innerHTML = `<p class="error-msg">Failed to load receipts: ${err}</p>`;
  }

  return () => { container.innerHTML = ""; };
}
