/**
 * apps/web/src/components/HostSettingsPanel.ts
 *
 * PRIORITY 3 · Host Settings Panel (Task 20)
 *
 * Mounts as a settings popover/drawer in the room header.
 * Controls:
 *   - Room name
 *   - Room description
 *   - Visibility (public/private)
 *   - Community keys toggle (allow participants to contribute API keys)
 *
 * Only visible to the active host (enforced by room.ts before mounting).
 */

import type { FortressRoomDoc } from "../state/ydoc.js";
import { getMyPubkey } from "../state/identity.js";
import { setAllowCommunityKeys, getAllowCommunityKeys } from "../state/ydoc.js";

export class HostSettingsPanel {
  private doc: FortressRoomDoc;
  private triggerEl: HTMLElement;
  private panelEl: HTMLElement | null = null;
  private visible = false;

  constructor(doc: FortressRoomDoc, triggerEl: HTMLElement) {
    this.doc = doc;
    this.triggerEl = triggerEl;
  }

  mount(): this {
    this.triggerEl.style.cursor = "pointer";
    this.triggerEl.title = "Room settings";
    this.triggerEl.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggle();
    });
    return this;
  }

  destroy(): void {
    this.panelEl?.remove();
    this.panelEl = null;
  }

  private toggle(): void {
    if (this.visible) {
      this.close();
    } else {
      this.open();
    }
  }

  private open(): void {
    this.visible = true;
    this.render();
    document.addEventListener("click", this.handleOutsideClick, { once: true });
    document.addEventListener("keydown", this.handleKeydown);
  }

  private close(): void {
    this.visible = false;
    this.panelEl?.remove();
    this.panelEl = null;
    document.removeEventListener("keydown", this.handleKeydown);
  }

  private readonly handleOutsideClick = (e: MouseEvent) => {
    if (this.panelEl && !this.panelEl.contains(e.target as Node) && !this.triggerEl.contains(e.target as Node)) {
      this.close();
    }
  };

  private readonly handleKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape") this.close();
  };

  private render(): void {
    this.panelEl?.remove();

    const meta = this.doc.meta;
    const name = (meta.get("name") as string) ?? "";
    const description = (meta.get("description") as string) ?? "";
    const visibility = (meta.get("visibility") as string) ?? "public";
    const allowCommunityKeys = getAllowCommunityKeys(this.doc);

    const panel = document.createElement("div");
    panel.className = "ff-settings-panel";
    panel.innerHTML = `
      <div class="ff-settings-panel__header">
        <span>Room Settings</span>
        <button class="ff-settings-panel__close" aria-label="Close settings">×</button>
      </div>
      <div class="ff-settings-panel__body">
        <label class="settings-field">
          <span>Room Name</span>
          <input type="text" id="ff-setting-name" value="${this.escapeAttr(name)}" maxlength="80" />
        </label>
        <label class="settings-field">
          <span>Description</span>
          <textarea id="ff-setting-description" rows="3" maxlength="500">${this.escapeHtml(description)}</textarea>
        </label>
        <label class="settings-field">
          <span>Visibility</span>
          <select id="ff-setting-visibility">
            <option value="public" ${visibility === "public" ? "selected" : ""}>Public</option>
            <option value="private" ${visibility === "private" ? "selected" : ""}>Private (invite only)</option>
          </select>
        </label>
        <label class="settings-field settings-field--toggle">
          <span>Allow Community Keys</span>
          <input type="checkbox" id="ff-setting-community-keys" ${allowCommunityKeys ? "checked" : ""} />
          <span class="settings-toggle-desc">Let participants contribute their own API keys to the room</span>
        </label>
        <button class="settings-save-btn" id="ff-settings-save" type="button">Save changes</button>
      </div>
    `;

    panel.querySelector(".ff-settings-panel__close")?.addEventListener("click", () => this.close());
    panel.querySelector("#ff-settings-save")?.addEventListener("click", () => this.save({
      name: (panel.querySelector("#ff-setting-name") as HTMLInputElement)?.value ?? "",
      description: (panel.querySelector("#ff-setting-description") as HTMLTextAreaElement)?.value ?? "",
      visibility: (panel.querySelector("#ff-setting-visibility") as HTMLSelectElement)?.value ?? "public",
      communityKeys: (panel.querySelector("#ff-setting-community-keys") as HTMLInputElement)?.checked ?? false,
    }));

    this.panelEl = panel;
    this.triggerEl.parentElement?.appendChild(panel);
  }

  private save(opts: { name: string; description: string; visibility: string; communityKeys: boolean }): void {
    const myPubkey = getMyPubkey();
    const activeHost = this.doc.meta.get("activeHostPubkey") as string | undefined;
    if (!myPubkey || myPubkey !== activeHost) {
      console.warn("[HostSettings] Only the active host can change settings");
      return;
    }

    this.doc.doc.transact(() => {
      this.doc.meta.set("name", opts.name.trim() || "Untitled Room");
      this.doc.meta.set("description", opts.description.trim());
      this.doc.meta.set("visibility", opts.visibility as "public" | "private");
    });

    setAllowCommunityKeys(this.doc, opts.communityKeys);
    this.close();
  }

  private escapeHtml(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  private escapeAttr(s: string): string {
    return s.replace(/"/g, "&quot;");
  }
}
