import * as Y from "yjs";
import type { SpectatorMessage } from "../state/ydoc.js";
import type { FortressRoomDoc } from "../state/ydoc.js";
import { getMyPubkey, getMyDisplayName } from "../state/identity.js";
import type { PublicKeyBase58 } from "@fatedfortress/protocol";

export class SpectatorChatView {
  private doc: FortressRoomDoc;
  private viewer: HTMLElement;
  private input: HTMLInputElement;
  private unsubscribe: (() => void) | null = null;

  constructor(doc: FortressRoomDoc) {
    this.doc = doc;
  }

  mount(el: HTMLElement): void {
    this.viewer = document.createElement("div");
    this.viewer.className = "spectator-chat-viewer";
    this.input = document.createElement("input");
    this.input.placeholder = "Chat with other spectators...";
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && this.input.value.trim()) {
        this.send(this.input.value.trim());
        this.input.value = "";
      }
    });
    el.appendChild(this.viewer);
    el.appendChild(this.input);
    this.subscribe();
  }

  destroy(): void {
    this.unsubscribe?.();
  }

  private send(text: string): void {
    const myPubkey = getMyPubkey();
    if (!myPubkey) return;
    const displayName = getMyDisplayName();
    // NOTE: this.doc is FortressRoomDoc, which has a .doc: Y.Doc property.
    // transact() lives on Y.Doc, so this.doc.doc.transact() is correct.
    const msgMap = new Y.Map();
    msgMap.set("id",          crypto.randomUUID());
    msgMap.set("pubkey",       myPubkey as PublicKeyBase58);
    msgMap.set("displayName",   displayName);
    msgMap.set("text",         text);
    msgMap.set("ts",           Date.now());
    msgMap.set("type",         "text");
    msgMap.set("isDeleted",    false);
    msgMap.set("reactions",    {} as Record<string, string[]>);
    // All fields set inside the same transact() — no partial writes on crash.
    this.doc.doc.transact(() => {
      this.doc.spectatorChat.push([msgMap]);
    });
  }

  private formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  private subscribe(): void {
    const render = () => {
      // Cast to union — TypeScript can't infer that items can be Y.Map from the
      // Y.Array<SpectatorMessage> type, so we widen explicitly here.
      // Duck-type check: SpectatorMessage is a plain object, Y.Map has a .get() method.
      // This avoids the `instanceof Y.Map` issue (Y.Map in this yjs version is generic).
      const messages = this.doc.spectatorChat.toArray();
      this.viewer.innerHTML = messages
        .map(m => {
          if (typeof (m as Y.Map<unknown>).get === "function") {
            // New format: Y.Map entry (observable, supports reactions and soft-delete)
            const mm = m as Y.Map<unknown>;
            const msg = {
              id:          mm.get("id")          as string,
              pubkey:      mm.get("pubkey")      as PublicKeyBase58,
              displayName: mm.get("displayName") as string,
              text:        mm.get("text")        as string,
              ts:          mm.get("ts")          as number,
              type:        (mm.get("type")        ?? "text") as SpectatorMessage["type"],
              isDeleted:   (mm.get("isDeleted")   ?? false) as boolean,
            };
            const deletedClass = msg.isDeleted ? " spc-deleted" : "";
            return `<div class="spc-msg${deletedClass}"><span class="spc-ts">${this.formatTime(msg.ts)}</span> <span class="spc-name">@${this.escape(msg.displayName)}</span>: <span class="spc-text">${this.escape(msg.text)}</span></div>`;
          }
          // Legacy format: raw object (read-only, pre-fix rooms)
          const mo = m as unknown as SpectatorMessage;
          return `<div class="spc-msg"><span class="spc-ts">${this.formatTime(mo.ts)}</span> <span class="spc-name">@${this.escape(mo.displayName)}</span>: <span class="spc-text">${this.escape(mo.text)}</span></div>`;
        })
        .join("");
      this.viewer.scrollTop = this.viewer.scrollHeight;
    };
    this.doc.spectatorChat.observe(render);
    this.unsubscribe = () => this.doc.spectatorChat.unobserve(render);
  }

  private escape(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
}
