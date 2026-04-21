// apps/web/src/components/OutputPane.ts
// Multimodal output: reads from outputItems (Y.Array<Y.Map>) when available,
// falls back to legacy output (Y.Text) for rooms created before the migration.
// Image URLs (opfs://) are resolved via archive.resolveOpfsUrl before rendering.

import * as Y from "yjs";
import { resolveOpfsUrl } from "../net/archive.js";

export class OutputPane {
  private doc: any;
  private container: HTMLElement;
  private outputEl: HTMLElement;
  private unsubscribe: (() => void) | null = null;

  constructor(doc: any) {
    this.doc = doc;
    this.container = document.createElement("div");
    this.container.className = "output-pane";
  }

  mount(el: HTMLElement): void {
    this.outputEl = document.createElement("div");
    this.outputEl.className = "output-content";
    this.container.appendChild(this.outputEl);
    el.appendChild(this.container);

    const render = async () => {
      const outputItems = this.doc.outputItems;
      const legacyOutput = this.doc.output;

      if (outputItems && outputItems.length > 0) {
        this.outputEl.innerHTML = "";

        // Process items with Promise.allSettled — one failure doesn't block others
        const results = await Promise.allSettled(
          Array.from(outputItems).map(async (item) => {
            if (typeof (item as Y.Map<unknown>).get !== "function") return null;
            const mm = item as Y.Map<unknown>;
            const type = mm.get("type") as string | undefined;

            if (type === "text") {
              const text = mm.get("text") as string ?? "";
              const p = document.createElement("pre");
              p.className = "output-text-item";
              p.textContent = text;
              return p;
            }

            if (type === "image") {
              let url = mm.get("url") as string ?? "";
              // Resolve opfs:// pseudo-URLs to blob: URLs for rendering (Task 14 Validation B)
              if (url.startsWith("opfs://")) {
                const resolved = await resolveOpfsUrl(url);
                if (resolved) url = resolved;
              }
              const wrapper = document.createElement("div");
              wrapper.className = "output-image-wrapper";

              const img = document.createElement("img");
              img.className = "output-image-item";
              img.src = url;
              img.alt = (mm.get("alt") as string) ?? "Generated image";
              img.loading = "lazy";

              const actions = document.createElement("div");
              actions.className = "output-image-actions";

              const downloadBtn = document.createElement("button");
              downloadBtn.className = "img-action-btn";
              downloadBtn.textContent = "↓";
              downloadBtn.title = "Download image";
              downloadBtn.addEventListener("click", () => this.downloadImage(url));

              const refBtn = document.createElement("button");
              refBtn.className = "img-action-btn";
              refBtn.textContent = "↗";
              refBtn.title = "Use as reference";
              refBtn.addEventListener("click", () => this.useAsReference(url));

              actions.appendChild(downloadBtn);
              actions.appendChild(refBtn);
              wrapper.appendChild(img);
              wrapper.appendChild(actions);
              return wrapper;
            }

            if (type === "audio") {
              let url = mm.get("url") as string ?? "";
              if (url.startsWith("opfs://")) {
                const resolved = await resolveOpfsUrl(url);
                if (resolved) url = resolved;
              }
              const audio = document.createElement("audio");
              audio.controls = true;
              audio.src = url;
              audio.className = "output-audio-item";
              return audio;
            }

            return null;
          })
        );

        for (const result of results) {
          if (result.status === "fulfilled" && result.value) {
            this.outputEl.appendChild(result.value);
          }
        }

        if (this.outputEl.children.length === 0) {
          this.renderEmpty();
        }
      } else {
        const text = legacyOutput ? legacyOutput.toString() : "";
        if (text) {
          this.outputEl.innerHTML = `<pre>${this.escape(text)}</pre>`;
        } else {
          this.renderEmpty();
        }
      }
    };

    const outputItems = this.doc.outputItems;
    if (outputItems) outputItems.observe(render);
    const legacyOutput = this.doc.output;
    if (legacyOutput) legacyOutput.observe(render);

    this.unsubscribe = () => {
      if (outputItems) outputItems.unobserve(render);
      if (legacyOutput) legacyOutput.unobserve(render);
    };

    render();
  }

  private renderEmpty(): void {
    this.outputEl.innerHTML = `<pre class="output-placeholder">Waiting for generation...</pre>`;
  }

  private escape(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  private downloadImage(url: string): void {
    const a = document.createElement("a");
    a.href = url;
    a.download = `ff-image-${Date.now()}.png`;
    a.click();
  }

  /** Fires a custom event that the ControlPane can listen for to pre-fill the prompt. */
  private useAsReference(imageUrl: string): void {
    window.dispatchEvent(new CustomEvent("ff:image-reference", {
      detail: { imageUrl },
    }));
  }

  destroy(): void {
    this.unsubscribe?.();
  }
}
