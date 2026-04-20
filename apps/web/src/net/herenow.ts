// apps/web/src/net/herenow.ts
import { safeStorage, KEY_HERENOW_TOKEN } from "../util/storage.js";

/**
 * Links a here.now permanent URL to a room's metadata in the Y.js doc.
 */
export function linkHereNowUrl(doc: any, url: string): void {
  doc.doc.transact(() => {
    doc.meta.set("hereNowUrl", url);
    doc.meta.set("hereNowLinkedAt", Date.now());
  });
}

/**
 * Publishes the current room to here.now by calling the here.now publish API.
 *
 * Note: Actual ZIP creation and upload is handled by scripts/publish.mjs (Node.js).
 * This function is a browser-side stub that stores the URL in the doc metadata
 * after the publish script has been run externally.
 *
 * In a full implementation, this would POST to a server endpoint that runs
 * the publish script and returns the URL.
 */
export async function publishToHereNow(_doc?: any): Promise<string> {
  // In production, this would call a server endpoint that:
  //   1. Runs `node scripts/publish.mjs`
  //   2. Returns the here.now URL
  //
  // For now, prompt the user to run the publish script manually.
  console.warn(
    "[herenow] Browser-side publish is not implemented.\n" +
    "To publish, run: node scripts/publish.mjs\n" +
    "Then paste the URL below."
  );

  const url = window.prompt(
    "Paste your here.now published URL:",
    "https://your-room.here.now"
  );

  if (!url || url.trim() === "" || url.startsWith("https://your-room")) {
    throw new Error("Publish cancelled or invalid URL");
  }

  return url.trim();
}

/**
 * Initiates the here.now OAuth flow for publishing.
 */
export async function linkHereNowAccount(): Promise<string> {
  const clientId = (import.meta.env.VITE_HERENOW_CLIENT_ID as string | undefined) ?? "";
  const redirectUri = `${window.location.origin}/auth/herenow/callback`;

  const authUrl = `https://here.now/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=publish`;

  const popup = window.open(authUrl, "herenow_auth", "width=600,height=700,popup=yes");
  if (!popup) {
    throw new Error("Popup was blocked. Please allow popups for here.now authorization.");
  }

  return new Promise<string>((resolve, reject) => {
    const handleCallback = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type !== "herenow_auth_callback") return;
      window.removeEventListener("message", handleCallback);
      popup.close();
      if (event.data?.token) {
        safeStorage.setItem(KEY_HERENOW_TOKEN, event.data.token); // key "herenow_token" for back compat
        resolve(event.data.token);
      } else {
        reject(new Error("Authorization failed"));
      }
    };
    window.addEventListener("message", handleCallback);

    const timeout = setTimeout(() => {
      window.removeEventListener("message", handleCallback);
      popup.close();
      reject(new Error("Authorization timed out"));
    }, 5 * 60 * 1000);

    popup.addEventListener("beforeunload", () => clearTimeout(timeout));
  });
}

export function getHereNowToken(): string | null {
  return safeStorage.getItem(KEY_HERENOW_TOKEN);
}
