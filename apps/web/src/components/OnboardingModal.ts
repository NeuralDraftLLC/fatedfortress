/**
 * apps/web/src/components/OnboardingModal.ts
 *
 * PRIORITY 3 · 3-Step Onboarding Modal (Task 21)
 *
 * Shown once per session on the room page when onboarding hasn't been completed.
 * Steps:
 *   1. Pick your craft (modality cards: text / image / audio / video)
 *   2. Auto-play demo (5-second animated demo)
 *   3. Try it (pre-filled prompt + Go button)
 */

const SESSION_KEY = "ff_onboarding_done";

const MODALITY_OPTIONS: Array<{ id: string; label: string; description: string; icon: string; placeholder: string }> = [
  { id: "text",  label: "Text",    description: "Write, rewrite, summarize, translate",   icon: "✏️",  placeholder: "e.g. Write a haiku about a rainy afternoon" },
  { id: "image", label: "Image",   description: "Generate images from a text prompt",      icon: "🖼",  placeholder: "e.g. A cyberpunk city at night, neon rain" },
  { id: "audio", label: "Audio",   description: "Generate music or sound effects",         icon: "🎵",  placeholder: "e.g. Upbeat lo-fi hip hop, 120 BPM" },
  { id: "video", label: "Video",  description: "Generate short video clips",                icon: "🎬",  placeholder: "e.g. A flowing lava lamp, 10 seconds" },
];

export class OnboardingModal {
  private step = 1;
  private selectedModality: string = "text";
  private overlayEl: HTMLElement | null = null;
  private modalEl: HTMLElement | null = null;
  private onComplete: ((modality: string, prompt: string) => void) | null = null;

  show(onComplete: (modality: string, prompt: string) => void): void {
    if (sessionStorage.getItem(SESSION_KEY)) return;
    this.step = 1;
    this.selectedModality = "text";
    this.onComplete = onComplete;
    this.render();
    document.body.appendChild(this.overlayEl!);
  }

  destroy(): void {
    this.overlayEl?.remove();
    this.overlayEl = null;
    this.modalEl = null;
  }

  private render(): void {
    this.overlayEl?.remove();

    const overlay = document.createElement("div");
    overlay.className = "ff-onboarding-overlay";
    overlay.innerHTML = `
      <div class="ff-onboarding-modal">
        <div class="ff-onboarding-progress">
          <div class="ff-onboarding-step-bar" style="width:${this.step * 33.33}%"></div>
        </div>
        <div class="ff-onboarding-content" id="ff-onboarding-content"></div>
        <div class="ff-onboarding-footer" id="ff-onboarding-footer"></div>
      </div>
    `;

    this.overlayEl = overlay;
    this.modalEl = overlay.querySelector(".ff-onboarding-modal") as HTMLElement;

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) this.close();
    });

    this.renderStep();
    document.body.appendChild(overlay);
  }

  private renderStep(): void {
    const content = this.modalEl?.querySelector("#ff-onboarding-content") as HTMLElement | null | undefined;
    const footer = this.modalEl?.querySelector("#ff-onboarding-footer") as HTMLElement | null | undefined;
    if (!content || !footer) return;

    if (this.step === 1) this.renderStep1(content, footer);
    else if (this.step === 2) this.renderStep2(content, footer);
    else this.renderStep3(content, footer);
  }

  // ── Step 1: Pick your craft ───────────────────────────────────────────

  private renderStep1(content: HTMLElement, footer: HTMLElement): void {
    content.innerHTML = `
      <div class="ff-onboarding-step-title">Welcome to FatedFortress</div>
      <div class="ff-onboarding-step-sub">Pick your craft to get started</div>
      <div class="ff-onboarding-cards">
        ${MODALITY_OPTIONS.map((opt) => `
          <button class="ff-onboarding-card ${this.selectedModality === opt.id ? "ff-onboarding-card--selected" : ""}" data-modality="${opt.id}">
            <span class="ff-onboarding-card-icon">${opt.icon}</span>
            <span class="ff-onboarding-card-label">${opt.label}</span>
            <span class="ff-onboarding-card-desc">${opt.description}</span>
          </button>
        `).join("")}
      </div>
    `;

    footer.innerHTML = `<button class="ff-onboarding-btn ff-onboarding-btn--primary" id="ff-ob-next">Next</button>`;

    content.querySelectorAll<HTMLButtonElement>(".ff-onboarding-card").forEach((card) => {
      card.addEventListener("click", () => {
        this.selectedModality = card.dataset.modality ?? "text";
        content.querySelectorAll(".ff-onboarding-card").forEach((c) => c.classList.remove("ff-onboarding-card--selected"));
        card.classList.add("ff-onboarding-card--selected");
      });
    });

    footer.querySelector("#ff-ob-next")?.addEventListener("click", () => { this.step = 2; this.renderStep(); });
  }

  // ── Step 2: Auto-play demo ────────────────────────────────────────────

  private renderStep2(content: HTMLElement, footer: HTMLElement): void {
    content.innerHTML = `
      <div class="ff-onboarding-step-title">Here's how it works</div>
      <div class="ff-onboarding-step-sub">Watch the magic in 5 seconds</div>
      <div class="ff-onboarding-demo" id="ff-ob-demo">
        <div class="ff-ob-demo-prompt">"${MODALITY_OPTIONS.find((o) => o.id === this.selectedModality)?.placeholder ?? "Your prompt here"}"</div>
        <div class="ff-ob-demo-cursor">|</div>
        <div class="ff-ob-demo-generate">
          <div class="ff-ob-demo-spinner"></div>
          <span>Generating...</span>
        </div>
        <div class="ff-ob-demo-output">
          <span class="ff-ob-demo-dots">...</span>
        </div>
      </div>
      <div class="ff-ob-demo-progress"><div id="ff-ob-demo-bar"></div></div>
    `;

    footer.innerHTML = `<button class="ff-onboarding-btn ff-onboarding-btn--ghost" id="ff-ob-skip">Skip demo</button>
                         <button class="ff-onboarding-btn ff-onboarding-btn--primary" id="ff-ob-next2">Next</button>`;

    // Animate the demo
    const bar = document.getElementById("ff-ob-demo-bar") as HTMLElement | null;
    const dots = content.querySelector(".ff-ob-demo-dots") as HTMLElement | null;
    const output = content.querySelector(".ff-ob-demo-output") as HTMLElement | null;
    const generateEl = content.querySelector(".ff-ob-demo-generate") as HTMLElement | null;
    const cursor = content.querySelector(".ff-ob-demo-cursor") as HTMLElement | null;

    let elapsed = 0;
    const interval = setInterval(() => {
      elapsed += 100;
      const pct = Math.min((elapsed / 5000) * 100, 100);
      if (bar) bar.style.width = `${pct}%`;

      // Typing cursor blink
      if (cursor) cursor.style.opacity = String(Math.sin(elapsed / 200) > 0 ? 1 : 0);

      // After 40% show generating spinner
      if (elapsed > 2000 && generateEl) {
        generateEl.style.opacity = "1";
        cursor.style.display = "none";
      }

      // After 70% show dots animating
      if (elapsed > 3500 && dots) {
        const dotCount = Math.floor((elapsed - 3500) / 300) % 4;
        dots.textContent = ".".repeat(dotCount || 1);
      }

      // After 90% show output
      if (elapsed > 4500 && output) {
        output.style.opacity = "1";
        if (dots) dots.textContent = "";
      }

      if (elapsed >= 5000) {
        clearInterval(interval);
        if (output) output.innerHTML = `<span class="ff-ob-demo-success">✓ Output ready!</span>`;
      }
    }, 100);

    footer.querySelector("#ff-ob-skip")?.addEventListener("click", () => { this.step = 3; this.renderStep(); });
    footer.querySelector("#ff-ob-next2")?.addEventListener("click", () => { this.step = 3; this.renderStep(); });
  }

  // ── Step 3: Try it ────────────────────────────────────────────────────

  private renderStep3(content: HTMLElement, footer: HTMLElement): void {
    const opt = MODALITY_OPTIONS.find((o) => o.id === this.selectedModality) ?? MODALITY_OPTIONS[0];

    content.innerHTML = `
      <div class="ff-onboarding-step-title">Try it now</div>
      <div class="ff-onboarding-step-sub">Type your first prompt and hit Go</div>
      <div class="ff-onboarding-try">
        <div class="ff-ob-modality-badge">${opt.icon} ${opt.label}</div>
        <textarea
          id="ff-ob-prompt"
          rows="3"
          maxlength="1000"
          placeholder="${opt.placeholder}"
        >${opt.id === "text" ? "Write a haiku about artificial intelligence" : ""}</textarea>
        <div class="ff-ob-prompt-hint">Press <kbd>Enter</kbd> to go, or <kbd>Esc</kbd> to skip</div>
      </div>
    `;

    footer.innerHTML = `<button class="ff-onboarding-btn ff-onboarding-btn--ghost" id="ff-ob-back2">← Back</button>
                         <button class="ff-onboarding-btn ff-onboarding-btn--primary" id="ff-ob-go">Go →</button>`;

    const textarea = content.querySelector("#ff-ob-prompt") as HTMLTextAreaElement;
    textarea?.focus();

    const go = () => {
      const prompt = textarea?.value.trim() ?? "";
      sessionStorage.setItem(SESSION_KEY, "1");
      this.onComplete?.(this.selectedModality, prompt);
      this.destroy();
    };

    textarea?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); go(); }
      if (e.key === "Escape") { sessionStorage.setItem(SESSION_KEY, "1"); this.destroy(); }
    });

    footer.querySelector("#ff-ob-go")?.addEventListener("click", go);
    footer.querySelector("#ff-ob-back2")?.addEventListener("click", () => { this.step = 2; this.renderStep(); });
  }

  private close(): void {
    sessionStorage.setItem(SESSION_KEY, "1");
    this.destroy();
  }
}
