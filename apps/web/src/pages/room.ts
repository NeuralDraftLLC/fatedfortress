// apps/web/src/pages/room.ts
import type { PaletteIntent } from "@fatedfortress/protocol";
import {
  getMyJoinedAt,
  addParticipant,
  setActiveRoomDoc,
  getParticipants,
  setMeta,
} from "../state/ydoc.js";
import {
  joinRoom as signalingJoin,
  upsertPresence,
  removePresence,
} from "../net/signaling.js";
import { WorkerBridge } from "../net/worker-bridge.js";
import { ControlPane } from "../components/ControlPane.js";
import { OutputPane } from "../components/OutputPane.js";
import { SpectatorChatView } from "../components/SpectatorChat.js";
import type { FortressRoomDoc } from "../state/ydoc.js";
import { getMyPubkey, getMyDisplayName } from "../state/identity.js";
import { showSplitModal, executePayment } from "../net/tempo.js";
import { publishToHereNow, linkHereNowUrl } from "../net/herenow.js";
import { checkHostPresence, cleanupRoomState } from "../state/presence.js";
import type { PaymentIntent } from "@fatedfortress/protocol";

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

function handleIntent(doc: FortressRoomDoc) {
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
        // The ControlPane handles this via the model selector — trigger a re-render
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
        // Handled by main.ts dispatchIntent, but also update local state
        break;
      }

      case "fork_receipt": {
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

// ── Main mount ────────────────────────────────────────────────────────────────

export async function mountRoom(
  roomId: string,
  container: HTMLElement,
  opts: MountRoomOptions = {}
): Promise<() => void> {
  const doc = await joinRoom(roomId, opts);

  // Register as active doc for other modules
  setActiveRoomDoc(doc);

  const myPubkey = getMyPubkey() ?? "";
  const participant = getParticipants(doc).find((p: any) => p.pubkey === myPubkey);
  const isSpectator = opts.spectate ?? participant?.isSpectator ?? false;

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
    controlPane = new ControlPane(doc);
    controlPane.mount(controlEl);
  }

  const outputEl = splitPane.querySelector(".room-output-pane")!;
  const outputPane = new OutputPane(doc);
  outputPane.mount(outputEl);

  // Initial presence
  upsertPresence(doc, { name: getMyDisplayName(), isSpectator });

  // Register intent handlers
  handleIntent(doc);

  // Heartbeat presence updates every 5s
  presenceInterval = setInterval(() => {
    upsertPresence(doc, { name: getMyDisplayName(), isSpectator });
    // Also check for host presence staleness
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
    void WorkerBridge.getInstance().requestTeardown(); // pushState unmount — beforeunload may not run
    controlPane?.destroy();
    outputPane.destroy();
    removePresence(doc);
    if (presenceInterval) clearInterval(presenceInterval);
    cleanupRoomState(roomId);
    splitPane.remove();
  };

  return cleanup;
}
