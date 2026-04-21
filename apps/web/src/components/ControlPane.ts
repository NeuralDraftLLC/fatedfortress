/**
 * apps/web/src/components/ControlPane.ts — Room controls (model, prompts, generation, fuel).
 *
 * Medium #12 — Fuel event leak: `ff:fuel` must use a stable listener reference stored on
 * the instance so `destroy()` can `removeEventListener` it. Inline arrows cannot be removed.
 *
 * Phase 4 — stream cache (state/handoff.ts): same model|system|user-prompt key for resume + CHUNK append.
 */
import { WorkerBridge } from "../net/worker-bridge.js";
import {
  appendStreamChunk,
  getCachedOutput,
  markStreamComplete,
} from "../state/handoff.js";
import { getMyPubkey } from "../state/identity.js";
import {
  appendOutput,
  appendOutputItem,
  getTemplates,
  getRoomId,
} from "../state/ydoc.js";
import { saveReceipt } from "../state/vault.js";
import type { FortressRoomDoc } from "../state/ydoc.js";

const ALL_MODELS = [
  { provider: "openai",     model: "gpt-4o",              label: "GPT-4o" },
  { provider: "openai",     model: "o3",                  label: "OpenAI o3" },
  { provider: "openai",     model: "o4-mini",             label: "OpenAI o4-mini" },
  { provider: "anthropic",  model: "claude-4-sonnet",      label: "Claude 4 Sonnet" },
  { provider: "anthropic",  model: "claude-4-opus",        label: "Claude 4 Opus" },
  { provider: "anthropic",  model: "claude-haiku",          label: "Claude Haiku" },
  { provider: "google",     model: "gemini-2.0-flash",    label: "Gemini 2.0 Flash" },
  { provider: "google",     model: "gemini-2.0-pro",      label: "Gemini 2.0 Pro" },
  { provider: "groq",       model: "llama-3.3-70b",       label: "Groq Llama 3.3" },
  { provider: "groq",       model: "mixtral-8x7b",         label: "Groq Mixtral" },
  { provider: "openrouter", model: "openrouter/auto",      label: "OpenRouter (auto)" },
] as const;

type ModelOption = typeof ALL_MODELS[number];

export class ControlPane {
  private doc: FortressRoomDoc;
  private container: HTMLElement;
  private bridge = WorkerBridge.getInstance();
  private fuelInterval: ReturnType<typeof setInterval> | null = null;
  private abortController: AbortController | null = null;
  /** Bound `ff:fuel` handler — same reference required for removeEventListener (#12). */
  private _fuelListener: ((e: Event) => void) | null = null;
  private demoMode: boolean;

  constructor(doc: FortressRoomDoc, demoMode = false) {
    this.doc = doc;
    this.demoMode = demoMode;
    this.container = document.createElement("div");
    this.container.className = "control-pane";
  }

  mount(el: HTMLElement): void {
    const templates = getTemplates(this.doc);
    const roomId = getRoomId(this.doc);
    const roomType = this.doc.meta.get("roomType") as string ?? "text";
    const isImage = roomType === "image";

    const demoBanner = this.demoMode
      ? `<div class="demo-banner" id="demo-banner">
          <span class="demo-banner__text">You're on a demo key &middot; Add yours to unlock full generation</span>
          <a href="/connect" class="demo-banner__link">Add key</a>
          <button class="demo-banner__dismiss" id="demo-banner-dismiss" aria-label="Dismiss">&times;</button>
        </div>`
      : "";

    // Image-specific extras (only rendered when roomType === "image")
    const imageExtras = isImage ? `
      <div class="control-section">
        <label>ASPECT RATIO</label>
        <div class="chip-group" id="aspect-ratio-group">
          ${["1:1", "16:9", "9:16", "4:3", "3:4"].map(ratio =>
            `<button class="chip${ratio === "1:1" ? " chip--active" : ""}" data-ratio="${ratio}">${ratio}</button>`
          ).join("")}
        </div>
      </div>
      <div class="control-section">
        <label>NEGATIVE PROMPT</label>
        <textarea id="negative-prompt" placeholder="What to avoid..."></textarea>
      </div>
      <div class="control-section">
        <label>SEED <span style="font-weight:normal">(0 = random)</span></label>
        <input type="number" id="seed-input" min="0" max="4294967295" placeholder="0" style="width:100%">
      </div>
      <div class="control-section">
        <label>STYLE PRESETS</label>
        <select id="style-select">
          <option value="">None</option>
          <option value="photorealistic">Photorealistic</option>
          <option value="illustration">Illustration</option>
          <option value="digital-art">Digital Art</option>
          <option value="anime">Anime</option>
          <option value="watercolor">Watercolor</option>
          <option value="pixel-art">Pixel Art</option>
        </select>
      </div>` : "";

    this.container.innerHTML = `
      ${demoBanner}
      <div class="control-section">
        <label>MODEL</label>
        <select id="model-select">
          ${ALL_MODELS.map((m) =>
            `<option value="${m.provider}/${m.model}">${m.label}</option>`
          ).join("")}
        </select>
      </div>
      <div class="control-section">
        <label>SYSTEM PROMPT</label>
        <textarea id="system-prompt" placeholder="Optional system prompt..."></textarea>
      </div>
      ${imageExtras}
      <div class="control-section">
        <label>PROMPT</label>
        <textarea id="prompt-input" placeholder="Enter your prompt..."></textarea>
        <button id="btn-generate">GENERATE</button>
        <button id="btn-abort" style="display:none">STOP</button>
      </div>
      ${templates.length > 0 ? `
      <div class="control-section">
        <label>TEMPLATES</label>
        <div class="templates-list">
          ${templates.slice(0, 5).map((t) =>
            `<button class="template-btn" data-template="${this.escapeAttr(t)}">${this.escapeHtml(t.slice(0, 40))}…</button>`
          ).join("")}
        </div>
      </div>
      ` : ""}
      <div class="control-section">
        <label>FUEL</label>
        <div class="fuel-gauge" id="fuel-gauge">
          <div class="fuel-bar">
            <div class="fuel-fill" id="fuel-fill" style="width:100%"></div>
          </div>
          <span class="fuel-label" id="fuel-label">--</span>
        </div>
      </div>
    `;

    el.appendChild(this.container);

    // Generate button
    this.container.querySelector("#btn-generate")?.addEventListener("click", () => this.handleGenerate());
    this.container.querySelector("#prompt-input")?.addEventListener("keydown", (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") this.handleGenerate();
    });

    // Abort button
    this.container.querySelector("#btn-abort")?.addEventListener("click", () => {
      this.abortController?.abort();
    });

    // Template buttons
    this.container.querySelectorAll(".template-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tmpl = btn.getAttribute("data-template") ?? "";
        const promptEl = this.container.querySelector("#prompt-input") as HTMLTextAreaElement;
        if (promptEl) promptEl.value = tmpl;
      });
    });

    // Demo banner dismiss
    this.container.querySelector("#demo-banner-dismiss")?.addEventListener("click", () => {
      const banner = this.container.querySelector("#demo-banner");
      if (banner) banner.remove();
    });

    // Aspect ratio chips (image rooms only)
    if (isImage) {
      this.container.querySelectorAll<HTMLElement>("[data-ratio]").forEach((chip) => {
        chip.style.cursor = "pointer";
        chip.addEventListener("click", () => {
          this.container.querySelectorAll<HTMLElement>("[data-ratio]").forEach((c) =>
            c.classList.remove("chip--active"));
          chip.classList.add("chip--active");
        });
      });
    }

    // Start fuel polling
    this.startFuelPolling(roomId);
  }

  destroy(): void {
    if (this.fuelInterval !== null) {
      clearInterval(this.fuelInterval);
      this.fuelInterval = null;
    }
    if (this._fuelListener !== null) {
      window.removeEventListener("ff:fuel", this._fuelListener);
      this._fuelListener = null;
    }
    this.abortController?.abort();
  }

  private async handleGenerate(): Promise<void> {
    const promptEl = this.container.querySelector("#prompt-input") as HTMLTextAreaElement;
    const systemEl = this.container.querySelector("#system-prompt") as HTMLTextAreaElement;
    const modelEl = this.container.querySelector("#model-select") as HTMLSelectElement;
    const generateBtn = this.container.querySelector("#btn-generate") as HTMLButtonElement;
    const abortBtn = this.container.querySelector("#btn-abort") as HTMLButtonElement;

    // Stable cache key for stream resume (must not include cached prefix appended below).
    const promptKey = promptEl.value.trim();
    if (!promptKey) return;

    const roomId = getRoomId(this.doc);
    const roomType = this.doc.meta.get("roomType") as string ?? "text";
    const [provider, model] = modelEl.value.split("/") as [string, string];
    const systemPrompt = systemEl.value.trim();

    // Phase 4 handoff.ts — prepend partial stream after host drop so worker continues from tail.
    const cached = await getCachedOutput(model, systemPrompt, promptKey);
    let prompt = promptKey;
    if (cached) {
      prompt = `${cached}\n--- resume ---\n${promptKey}`;
    }

    // Image-specific params
    const imageParams = roomType === "image" ? {
      aspectRatio: (this.container.querySelector(".chip--active[data-ratio]") as HTMLElement)?.dataset.ratio ?? "1:1",
      negativePrompt: (this.container.querySelector("#negative-prompt") as HTMLTextAreaElement)?.value ?? "",
      seed: parseInt((this.container.querySelector("#seed-input") as HTMLInputElement)?.value ?? "0", 10) || 0,
      style: (this.container.querySelector("#style-select") as HTMLSelectElement)?.value ?? "",
    } : undefined;

    // Create abort controller for this generation
    this.abortController = new AbortController();
    generateBtn.style.display = "none";
    abortBtn.style.display = "inline-block";

    try {
      const myPk = getMyPubkey();
      const outputHash = await this.bridge.requestGenerate(
        {
          provider,
          model,
          prompt,
          systemPrompt,
          modality: roomType,
          imageParams,
          signal: this.abortController.signal,
          roomId,
          participantPubkey: myPk ?? undefined,
          quotaTokensToReserve: myPk ? 1 : undefined,
        },
        {
          onChunk: (chunk) => {
            void appendStreamChunk(model, systemPrompt, promptKey, chunk);
            appendOutput(this.doc, chunk);
          },
          onImageUrl: (url, alt) => {
            // Append as image output item (outputItems — Task 14)
            appendOutputItem(this.doc, { type: "image", url, alt });
          },
          onDone: async (hash) => {
            void markStreamComplete(model, systemPrompt, promptKey, hash);
            console.log("[ControlPane] generation done:", hash);
            generateBtn.style.display = "inline-block";
            abortBtn.style.display = "none";

            // Receipts require a real user key — skip in demo mode.
            if (!this.demoMode) {
              try {
                await saveReceipt({
                  id: `rcp_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
                  hash,
                  model: `${provider}/${model}`,
                  timestamp: Date.now(),
                  prompt: prompt.slice(0, 200),
                  type: roomType as "text" | "image" | "audio" | "video",
                });
              } catch (e) {
                console.warn("[ControlPane] failed to save receipt:", e);
              }
            }
          },
          onError: (code, message) => {
            console.error(`[ControlPane] generation error: ${code} ${message}`);
            generateBtn.style.display = "inline-block";
            abortBtn.style.display = "none";
          },
        }
      );
    } catch (err) {
      console.error("[ControlPane] generation failed:", err);
      generateBtn.style.display = "inline-block";
      abortBtn.style.display = "none";
    }
  }

  private startFuelPolling(roomId: string): void {
    const fillEl = () => this.container.querySelector("#fuel-fill") as HTMLElement | null;
    const labelEl = () => this.container.querySelector("#fuel-label") as HTMLElement | null;

    const poll = async () => {
      try {
        const state = await this.bridge.requestFuelGauge(roomId as any);
        const total = state.participants.reduce((sum: number, p: any) => sum + (p.quota ?? 0), 0);
        const consumed = state.participants.reduce(
          (sum: number, p: any) => sum + (p.consumed ?? 0) + (p.reserved ?? 0),
          0
        );
        const pct = total > 0 ? Math.max(0, 100 - (consumed / total * 100)) : 100;
        const fill = fillEl();
        const label = labelEl();
        if (fill) fill.style.width = `${pct}%`;
        if (label) label.textContent = `${state.participants.length} participant(s) · ${pct.toFixed(0)}% fuel`;
      } catch {
        const label = labelEl();
        if (label) label.textContent = "fuel unavailable";
      }
    };

    poll();
    this.fuelInterval = setInterval(poll, 5000);

    this._fuelListener = (e: Event) => {
      const state = (e as CustomEvent).detail as any;
      if (state?.roomId != null && state.roomId !== roomId) return;
      const total = state.participants.reduce((sum: number, p: any) => sum + (p.quota ?? 0), 0);
      const consumed = state.participants.reduce(
        (sum: number, p: any) => sum + (p.consumed ?? 0) + (p.reserved ?? 0),
        0
      );
      const pct = total > 0 ? Math.max(0, 100 - (consumed / total * 100)) : 100;
      const fill = fillEl();
      const label = labelEl();
      if (fill) fill.style.width = `${pct}%`;
      if (label) label.textContent = `${state.participants?.length ?? 0} participant(s) · ${pct.toFixed(0)}% fuel`;
    };
    window.addEventListener("ff:fuel", this._fuelListener);
  }

  private escapeAttr(str: string): string {
    return str.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  private escapeHtml(str: string): string {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
}
