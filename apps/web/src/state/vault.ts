// apps/web/src/state/vault.ts

export interface Receipt {
  id: string;
  hash?: string;
  model?: string;
  timestamp: number;
  prompt?: string;
  parentId?: string;
  /** Room type: text (default), image, audio, video */
  type?: "text" | "image" | "audio" | "video";
  /** Permanent published URLs for multimodal outputs (populated after here.now upload) */
  outputUrls?: string[];
  /** SHA-256 of the reference image used to generate this receipt (image rooms only) */
  referenceImageHash?: string;
}

const DB_NAME = "fortress-vault";
const STORE_NAME = "receipts";

async function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveReceipt(receipt: Receipt): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const req = tx.objectStore(STORE_NAME).put(receipt);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function getReceipts(): Promise<Receipt[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror = () => reject(req.error);
  });
}

export async function getReceiptById(id: string): Promise<Receipt | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(id);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}
