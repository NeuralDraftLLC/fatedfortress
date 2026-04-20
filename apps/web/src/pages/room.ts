// apps/web/src/pages/room.ts
import type { PaletteIntent } from "@fatedfortress/protocol";
import {
  getMyJoinedAt,
  addParticipant,
  setActiveRoomDoc,
  getParticipants,
  setMeta,
  needsKeyPolicyConsent,
  recordKeyPolicyConsent,
  getRoomId,
} from "../state/ydoc.js";
import {
  joinRoom as signalingJoin,
  upsertPresence,
  removePresence,
} from "../net/signaling.js";
import {
  WorkerBridge,
  DemoRateLimitError,
  type DemoGrant,
} from "../net/worker-bridge.js";
import { mountDemoKeyBanner, mountKeyPromptBanner } from "../components/DemoKeyBanner.js";
import { ControlPane } from "../components/ControlPane.js";
import { OutputPane } from "../components/OutputPane.js";
import { SpectatorChatView } from "../components/SpectatorChat.js";
import type { FortressRoomDoc } from "../state/ydoc.js";
import { getMyPubkey, getMyDisplayName } from "../state/identity.js";
import { showSplitModal, executePayment } from "../net/tempo.js";
import { publishToHereNow, linkHereNowUrl } from "../net/herenow.js";
import { checkHostPresence, cleanupRoomState } from "../state/presence.js";
import type { PaymentIntent } from "@fatedfortress/protocol";

// ─── PRIORITY 1: Demo Key Entry ────────────────────────────────────────────────

/** In-memory demo grant for this session. Never persisted. */
let activeDemoGrant: DemoGrant | null = null;

export function getActiveDemoGrant(): DemoGrant | null {
  if (activeDemoGrant && activeDemoGrant.expiresAt < Date.now()) {
    activeDemoGrant = null;
  }
  return activeDemoGrant;
}

/**
 * Determines how the user enters the room:
 *   own-key  → has their own key stored, proceed normally
 *   demo     → no key but demo grant obtained successfully
 *   blocked  → no key and demo quota exhausted or network failed
 */
export async function resolveEntryMode(args: {
  doc: FortressRoomDoc;
  activeProvider: DemoGrant["provider"];
  roomId: string;
}): Promise<
  | { mode: "own-key" }
  | { mode: "demo"; grant: DemoGrant }
  | { mode: "blocked"; reason: string }
> {
  const bridge = WorkerBridge.getInstance();

  // Check if the user has their own key stored — if so, skip demo entirely
  try {
    const hasOwnKey = await bridge.hasKey(args.activeProvider);
    if (hasOwnKey) return { mode: "own-key" };
  } catch {
    // Bridge unreachable (e.g., keys.fatedfortress.com unreachable locally);
    // fall through to demo path; if that also fails, show blocked.
  }

  // No stored key — try demo path
  try {
    const grant = await bridge.consumeDemoToken(args.activeProvider, args.roomId);
    activeDemoGrant = grant;
    return { mode: "demo", grant };
  } catch (err) {
    if (err instanceof DemoRateLimitError) {
      return {
        mode: "blocked",
        reason: `Demo quota exhausted. Available again ${new Date(
          err.resetAt,
        ).toLocaleTimeString()}. Connect your own key to continue.`,
      };
    }
    const isBridgeTimeout =
      err instanceof Error &&
      (err.message.includes("timed out") ||
        err.message.includes("timeout") ||
        (err as any)?.code === "REQUEST_TIMEOUT");

    return {
      mode: "blocked",
      reason: isBridgeTimeout
        ? "Could not reach demo service. Add your own API key to continue."
        : "Demo service unavailable. Add your own API key to continue.",
    };
  }
}

// ─── PRIORITY 2: Community-Key Consent Gate ────────────────────────────────────

/**
 * Renders the community-key consent modal if the room is in community mode
 * and the participant hasn't consented since the last policy change.
 * Returns a promise that resolves when the user consents or declines.
 */
export async function gateKeyPolicyConsent(
  doc: FortressRoomDoc,
): Promise<"consented" | "declined"> {
  const myPubkey = getMyPubkey() ?? "";
  if (!needsKeyPolicyConsent(doc, myPubkey)) return "consented";

  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "ff-consent-modal";
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-modal", "true");
    backdrop.innerHTML = `
      <div class="ff-consent-modal-backdrop"></div>
      <div class="ff-consent-modal-content">
        <h2>Community-Powered Room</h2>
        <p>
          This room's host has enabled <strong>Community Keys</strong>. If you
          contribute an API key, it will be used for collaborative generation
          alongside other participants. Your key is stored only on your device
          and never leaves this browser — but the room's generations consume
          your quota.
        </p>
        <p class="ff-text-muted">
          You can leave the room now, or continue as a spectator (read-only, no
          key required), or accept and contribute your key.
        </p>
        <div class="ff-consent-modal-actions">
          <button data-action="leave">Leave room</button>
          <button data-action="spectate">Spectate only</button>
          <button data-action="consent" class="ff-primary">I understand, continue</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);

    backdrop.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      const action = (target as HTMLElement & { dataset?: { action?: string } }).dataset?.action;
      if (!action) return;

      if (action === "consent") {
        recordKeyPolicyConsent(doc, myPubkey);
        backdrop.remove();
        resolve("consented");
      } else if (action === "spectate" || action === "leave") {
        backdrop.remove();
        resolve("declined");
        if (action === "leave") {
          window.location.hash = "#/table";
        }
      }
    });
  });
}

// ─── State ─────────────────────────────────────────────────────────────────────

let cleanup: (() => void) | null = null;
let presenceInterval: ReturnType<typeof setInterval> | null = null;

interface MountRoomOptions {
  spectate?: boolean;
}

// ── Banner & Modal helpers ────────────────────────────────────────────────────

function showBanner(message: string, duration = 5000): void {
  const banner = document.createElement("div");
  banner.className = "upgrade-banner";
  banner.textContent = message;
  document.body.appendChild(banner);
  setTimeout(() => banner.remove(), duration);
}

function showPaymentModal(opts: {
  amount: number;
  onConfirm: () => void;
  hostAddress?: string;
}): void {
  const platformAddress = import.meta.env.VITE_PLATFORM_WALLET ?? "";

  showSplitModal({
    amount: opts.amount,
    type: "entry_fee",
    hostAddress: opts.hostAddress ?? "",
    platformAddress,
    onConfirm: (intent: PaymentIntent) => {
      executePayment({
        intent,
        onSuccess: () => {
          opts.onConfirm();
        },
        onError: (err) => {
          showBanner(`Payment failed: ${err}`, 8000);
        },
      });
    },
    onCancel: () => {
      console.log("[room] Payment cancelled");
    },
  });
}

// ── Room entry helpers ────────────────────────────────────────────────────────

async function enterRoom(doc: FortressRoomDoc, isSpectator = false): Promise<void> {
  const myPubkey = getMyPubkey();
  if (myPubkey) {
    addParticipant(doc, {
      pubkey: myPubkey as any,
      name: getMyDisplayName(),
      joinedAt: Date.now(),
      contributesKey: false,
      quotaPerUser: null,
      isSpectator,
    });
  }
  console.log("[room] entering room", isSpectator ? "(spectator)" : "");
}

async function joinRoom(roomId: string, opts: MountRoomOptions = {}): Promise<FortressRoomDoc> {
  // Relay tags spectator=1 — server skips WebRTC signaling fan-out; OPFS/spectate handled in signaling.ts.
  const doc = await signalingJoin(roomId as any, { spectate: opts.spectate === true });
  const meta = doc.meta;

  // Check if already a participant
  const myPubkey = getMyPubkey() ?? "";
  const existing = getParticipants(doc).find((p: any) => p.pubkey === myPubkey);

  if (opts.spectate) {
    // Spectators join without payment
    showBanner("You are spectating — your messages only reach other spectators.");
    await enterRoom(doc, true);
    return doc;
  }

  if (existing) {
    // Already joined
    return doc;
  }

  if (meta.get("access") === "paid") {
    const upgradedAt = meta.get("upgradedAt") as number | null;
    const myJoinedAt = getMyJoinedAt(doc);
    const isGrandfathered = upgradedAt !== null && myJoinedAt < upgradedAt;

    if (isGrandfathered) {
      showBanner("You joined before the room was upgraded — your access is free.");
    } else {
      const price = meta.get("price") as number;
      showPaymentModal({
        amount: price,
        hostAddress: meta.get("hostPubkey") as string,
        onConfirm: () => enterRoom(doc, false),
      });
      return doc;
    }
  }

  await enterRoom(doc, false);
  return doc;
}

// ── Intent handlers ────────────────────────────────────────────────────────────

function handleIntent(doc: FortressRoomDoc, demoMode: boolean) {
  window.addEventListener("palette:intent", async (e: Event) => {
    const { intent } = (e as CustomEvent).detail as { intent: PaletteIntent };

    switch (intent.type) {
      case "create_room": {
        showBanner("Room creation: navigate to /room/new to create a room");
        break;
      }

      case "join_room": {
        window.history.pushState({}, "", `/room/${intent.roomId}`);
        window.dispatchEvent(new PopStateEvent("popstate"));
        break;
      }

      case "spectate_room": {
        if (intent.roomId) {
          window.history.pushState({}, "", `/spectate/${intent.roomId}`);
        } else {
          const roomId = doc.meta.get("id") as string;
          window.history.pushState({}, "", `/spectate/${roomId}`);
        }
        window.dispatchEvent(new PopStateEvent("popstate"));
        break;
      }

      case "switch_model": {
        window.dispatchEvent(new CustomEvent("room:switch_model", { detail: intent }));
        break;
      }

      case "set_system_prompt": {
        setMeta(doc, { systemPrompt: intent.prompt });
        showBanner("System prompt updated");
        break;
      }

      case "publish": {
        if (intent.target === "room") {
          try {
            showBanner("Publishing room to here.now...");
            const url = await publishToHereNow(doc as any);
            linkHereNowUrl(doc as any, url);
            showBanner(`Room published: ${url}`);
          } catch (err) {
            showBanner(`Publish failed: ${err}`, 8000);
          }
        }
        break;
      }

      case "pay": {
        if (intent.roomId) {
          const targetRoomId = intent.roomId;
          if (targetRoomId !== doc.meta.get("id")) {
            showBanner("Navigate to the paid room first to pay");
            break;
          }
        }
        const price = doc.meta.get("price") as number | null;
        if (price) {
          showPaymentModal({
            amount: price,
            hostAddress: doc.meta.get("hostPubkey") as string,
            onConfirm: () => showBanner("Payment successful!"),
          });
        }
        break;
      }

      case "upgrade_room": {
        break;
      }

      case "fork_receipt": {
        if (demoMode) {
          showBanner("Fork is disabled on a demo key — add your own key to unlock");
          break;
        }
        showBanner("Fork: select a receipt to fork from /me page");
        window.history.pushState({}, "", "/me");
        window.dispatchEvent(new PopStateEvent("popstate"));
        break;
      }

      case "invite": {
        const roomId = doc.meta.get("id") as string;
        const inviteUrl = `${window.location.origin}/room/${roomId}`;
        await navigator.clipboard.writeText(inviteUrl).catch(() => {});
        showBanner(`Invite link copied: /room/${roomId.slice(0, 12)}...`);
        break;
      }

      case "search": {
        window.history.pushState({}, "", "/table");
        window.dispatchEvent(new PopStateEvent("popstate"));
        break;
      }

      case "link_herenow": {
        showBanner("here.now linking: implement OAuth flow");
        break;
      }

      case "open_connect": {
        window.history.pushState({}, "", "/connect");
        window.dispatchEvent(new PopStateEvent("popstate"));
        break;
      }

      case "open_me": {
        window.history.pushState({}, "", "/me");
        window.dispatchEvent(new PopStateEvent("popstate"));
        break;
      }

      case "help": {
        showBanner("Commands: /create, /join, /spectate, /connect, /me, /?");
        break;
      }

      case "claim_role": {
        const myPubkey = getMyPubkey();
        if (myPubkey && intent.role) {
          const { updateParticipant } = await import("../state/ydoc.js");
          updateParticipant(doc, myPubkey, { roles: [intent.role] as any });
          showBanner(`You claimed the role: ${intent.role}`);
        }
        break;
      }

      case "list_roles": {
        const participants = getParticipants(doc);
        const roleMap: Record<string, string[]> = {};
        for (const p of participants) {
          const roles = (p as any).roles ?? [];
          for (const role of roles) {
            if (!roleMap[role]) roleMap[role] = [];
            roleMap[role].push(p.name || "Anonymous");
          }
        }
        const lines = Object.entries(roleMap).map(([role, names]) =>
          `${role}: ${names.join(", ")}`
        );
        const msg = lines.length > 0
          ? `Roles:\n${lines.join("\n")}`
          : "No roles assigned yet.";
        showBanner(msg);
        break;
      }

      default:
        console.debug("[room] Unhandled intent:", (intent as any).type);
    }
  });
}

// ── Spectator-only mount (extracted when user declines community-key consent) ──

function mountSpectatorRoom(doc: FortressRoomDoc, container: HTMLElement): () => void {
  const splitPane = document.createElement("div");
  splitPane.className = "room-split";
  splitPane.innerHTML = `
    <div class="room-header">
      <span class="room-title">${(doc.meta.get("name") as string) ?? "Room"}</span>
      <span class="spectator-badge">SPECTATING</span>
      <button class="btn-leave" id="btn-leave">LEAVE</button>
    </div>
    <div class="room-control-pane"></div>
    <div class="room-output-pane"></div>
  `;
  container.appendChild(splitPane);

  const chatEl = document.createElement("div");
  chatEl.className = "spectator-chat";
  const chatView = new SpectatorChatView(doc);
  chatView.mount(chatEl);
  splitPane.querySelector(".room-control-pane")!.appendChild(chatEl);

  const outputEl = splitPane.querySelector(".room-output-pane")!;
  const outputPane = new OutputPane(doc);
  outputPane.mount(outputEl);

  upsertPresence(doc, { name: getMyDisplayName(), isSpectator: true });

  presenceInterval = setInterval(() => {
    upsertPresence(doc, { name: getMyDisplayName(), isSpectator: true });
  }, 5000);

  splitPane.querySelector("#btn-leave")?.addEventListener("click", () => {
    window.history.pushState({}, "", "/table");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });

  cleanup = () => {
    removePresence(doc);
    if (presenceInterval) clearInterval(presenceInterval);
    cleanupRoomState(getRoomId(doc));
    splitPane.remove();
  };

  return cleanup;
}

// ── Main mount ────────────────────────────────────────────────────────────────

export async function mountRoom(
  roomId: string,
  container: HTMLElement,
  opts: MountRoomOptions = {}
): Promise<() => void> {
  const doc = await joinRoom(roomId, opts);

  // ── PRIORITY 2: Community-key consent gate ──────────────────────────
  const consentResult = await gateKeyPolicyConsent(doc);
  if (consentResult === "declined") {
    // Re-join as spectator
    const spectatorDoc = await joinRoom(roomId, { spectate: true });
    setActiveRoomDoc(spectatorDoc);
    return mountSpectatorRoom(spectatorDoc, container);
  }

  // ── PRIORITY 1: Demo key or own-key resolution ──────────────────────
  const activeProvider: DemoGrant["provider"] = "openai";
  const entry = await resolveEntryMode({ doc, activeProvider, roomId });
  const bridge = WorkerBridge.getInstance();

  if (entry.mode === "blocked") {
    mountKeyPromptBanner(entry.reason);
  } else if (entry.mode === "demo") {
    const onConnectKey = () => {
      window.history.pushState({}, "", "/connect");
      window.dispatchEvent(new PopStateEvent("popstate"));
    };
    mountDemoKeyBanner(entry.grant, onConnectKey);
  }

  // Register as active doc for other modules
  setActiveRoomDoc(doc);

  const myPubkey = getMyPubkey() ?? "";
  const participant = getParticipants(doc).find((p: any) => p.pubkey === myPubkey);
  const isSpectator = opts.spectate ?? participant?.isSpectator ?? false;
  const demoMode = entry.mode === "demo";

  // Create layout
  const splitPane = document.createElement("div");
  splitPane.className = "room-split";
  splitPane.innerHTML = `
    <div class="room-header">
      <span class="room-title">${(doc.meta.get("name") as string) ?? "Room"}</span>
      ${isSpectator ? '<span class="spectator-badge">SPECTATING</span>' : ""}
      <button class="btn-leave" id="btn-leave">LEAVE</button>
    </div>
    <div class="room-control-pane"></div>
    <div class="room-output-pane"></div>
  `;
  container.appendChild(splitPane);

  let controlPane: ControlPane | null = null;
  if (isSpectator) {
    const chatEl = document.createElement("div");
    chatEl.className = "spectator-chat";
    const chatView = new SpectatorChatView(doc);
    chatView.mount(chatEl);
    splitPane.querySelector(".room-control-pane")!.appendChild(chatEl);
  } else {
    const controlEl = splitPane.querySelector(".room-control-pane")!;
    controlPane = new ControlPane(doc, demoMode);
    controlPane.mount(controlEl);
  }

  const outputEl = splitPane.querySelector(".room-output-pane")!;
  const outputPane = new OutputPane(doc);
  outputPane.mount(outputEl);

  // Initial presence
  upsertPresence(doc, { name: getMyDisplayName(), isSpectator });

  // Register intent handlers
  handleIntent(doc, demoMode);

  // Heartbeat presence updates every 5s
  presenceInterval = setInterval(() => {
    upsertPresence(doc, { name: getMyDisplayName(), isSpectator });
    try {
      checkHostPresence(doc);
    } catch {}
  }, 5000);

  // Leave button
  splitPane.querySelector("#btn-leave")?.addEventListener("click", () => {
    window.history.pushState({}, "", "/table");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });

  cleanup = () => {
    void bridge.requestTeardown();
    controlPane?.destroy();
    outputPane.destroy();
    removePresence(doc);
    if (presenceInterval) clearInterval(presenceInterval);
    cleanupRoomState(roomId);
    splitPane.remove();
  };

  return cleanup;
}
