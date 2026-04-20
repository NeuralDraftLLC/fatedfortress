// apps/web/src/components/WelcomeModal.ts
import { markWelcomeSeen } from "../util/storage.js"; // embed-safe vs raw localStorage

export function showWelcomeModal(): void {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-box">
      <div class="modal-header">WELCOME TO FATEDFORTRESS</div>
      <div class="modal-sub">Type <kbd>/</kbd> anywhere to open the command palette.</div>
      <div class="modal-section-label">STARTER COMMANDS</div>
      <div class="cmd-list">
        <div class="cmd-row"><kbd>/spectate</kbd> <span>watch a live room</span></div>
        <div class="cmd-row"><kbd>/join rm_...</kbd> <span>join an existing room</span></div>
        <div class="cmd-row"><kbd>/connect</kbd> <span>add your API key</span></div>
        <div class="cmd-row"><kbd>/?</kbd> <span>see all commands</span></div>
      </div>
      <div class="modal-actions">
        <button class="btn-primary" id="btn-join-room">JOIN A POPULAR ROOM</button>
        <button class="btn-secondary" id="btn-add-key">ADD MY API KEY</button>
      </div>
      <button type="button" class="modal-close" id="btn-close" aria-label="Close welcome dialog">
        <span class="modal-close__glyph modal-close__glyph--text" aria-hidden="true">ESC</span>
      </button>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector("#btn-close")?.addEventListener("click", () => {
    overlay.remove();
    markWelcomeSeen();
  });
  overlay.querySelector("#btn-join-room")?.addEventListener("click", () => {
    overlay.remove();
    markWelcomeSeen();
    window.history.pushState({}, "", "/table");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  overlay.querySelector("#btn-add-key")?.addEventListener("click", () => {
    overlay.remove();
    markWelcomeSeen();
    window.history.pushState({}, "", "/connect");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
}
