/**
 * Palette/index.ts — Command palette UI with ghost text + keyboard navigation.
 *
 * Ghost suffix: Phase 4 CommandTrie (vocabulary LCP) when non-empty; else NL parser first label.
 * Command list / Enter selection still comes from parse() — trie only accelerates typed completion.
 */

import type { PaletteIntent, PaletteContext } from "@fatedfortress/protocol";
import { parse } from "./parser.js";
import { buildCommandTrie, type CommandTrie } from "./commandTrie.js";
import "./palette.css";

export { buildPaletteContext } from "./context.js";

let overlayEl: HTMLElement | null = null;
let inputEl: HTMLInputElement | null = null;
let listEl: HTMLElement | null = null;
let ghostEl: HTMLElement | null = null;
let ghostTypedEl: HTMLElement | null = null;
let ghostSuffixEl: HTMLElement | null = null;
/** Snapshot for Tab / ArrowRight ghost acceptance */
let lastGhostSuffix = "";
let currentCtx: PaletteContext | null = null;
/** Phase 4 — trie over full vocabulary for ghost Tab completion (built each open). */
let commandTrie: CommandTrie | null = null;
let selectedIndex = -1;
let currentCandidates: Array<{ intent: PaletteIntent; confidence: number; label: string }> = [];

export function openPalette(ctx: PaletteContext): void {
  closePalette();
  selectedIndex = -1;
  currentCandidates = [];
  currentCtx = ctx;
  commandTrie = buildCommandTrie(ctx);

  overlayEl = document.createElement("div");
  overlayEl.className = "palette-overlay";
  overlayEl.innerHTML = `
    <div class="palette palette-box">
      <div class="palette-input-wrap">
        <div class="palette-ghost" aria-hidden="true">
          <span class="ghost-typed"></span><span class="ghost-suffix"></span>
        </div>
        <input class="palette-input" type="text" placeholder="type a command…" autofocus />
      </div>
      <div class="palette-list palette-results"></div>
      <div class="palette-ghost-suggestions"></div>
    </div>
  `;

  document.body.appendChild(overlayEl);

  inputEl = overlayEl.querySelector(".palette-input");
  listEl = overlayEl.querySelector(".palette-list");
  ghostEl = overlayEl.querySelector(".palette-ghost-suggestions");
  ghostTypedEl = overlayEl.querySelector(".ghost-typed");
  ghostSuffixEl = overlayEl.querySelector(".ghost-suffix");

  overlayEl.addEventListener("click", (e) => {
    if (e.target === overlayEl) closePalette();
  });

  // Keyboard navigation handler
  document.addEventListener("keydown", onKeydown);

  inputEl!.addEventListener("input", () => {
    render(inputEl!.value, ctx);
  });

  render("", ctx);
}

function closePalette(): void {
  if (overlayEl) {
    overlayEl.remove();
    overlayEl = null;
    inputEl = null;
    listEl = null;
    ghostEl = null;
    ghostTypedEl = null;
    ghostSuffixEl = null;
    lastGhostSuffix = "";
    currentCtx = null;
    selectedIndex = -1;
    currentCandidates = [];
  }
  commandTrie = null;
  document.removeEventListener("keydown", onKeydown);
}

function onKeydown(e: KeyboardEvent) {
  if (!listEl || !currentCtx) return;

  const items = Array.from(listEl.querySelectorAll(".palette-item:not(.palette-hint)"));

  if (e.key === "Tab" || e.key === "ArrowRight") {
    if (
      inputEl &&
      lastGhostSuffix.length > 0 &&
      inputEl.selectionStart === inputEl.value.length &&
      inputEl.selectionEnd === inputEl.value.length
    ) {
      e.preventDefault();
      inputEl.value += lastGhostSuffix;
      render(inputEl.value, currentCtx);
      return;
    }
    if (e.key === "Tab") return;
  }

  if (e.key === "Escape") {
    e.preventDefault();
    closePalette();
    return;
  }

  if (e.key === "Enter") {
    e.preventDefault();
    const selected = listEl?.querySelector(".palette-item.selected");
    if (selected) {
      (selected as HTMLElement).click();
    } else {
      // Click the first item if nothing selected
      const first = listEl?.querySelector(".palette-item") as HTMLElement | null;
      first?.click();
    }
    return;
  }

  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (items.length === 0) return;
    const next = Math.min(selectedIndex + 1, items.length - 1);
    setSelected(items, next);
    return;
  }

  if (e.key === "ArrowUp") {
    e.preventDefault();
    if (items.length === 0) return;
    const prev = Math.max(selectedIndex - 1, 0);
    setSelected(items, prev);
    return;
  }
}

function setSelected(items: Element[], index: number): void {
  items.forEach((el, i) => el.classList.toggle("selected", i === index));
  selectedIndex = index;
  items[index]?.scrollIntoView({ block: "nearest" });
}

function selectIntent(intent: PaletteIntent): void {
  closePalette();
  window.dispatchEvent(new CustomEvent("palette:select", { detail: { intent } }));
}

function updateInlineGhost(value: string, result: ReturnType<typeof parse>, _ctx: PaletteContext): void {
  if (!ghostTypedEl || !ghostSuffixEl) return;

  const typed = value;
  let suffix = "";

  // Trie wins for ghost — advances to shared prefix of all matching commands (branch-point Tab UX).
  const trieSuffix = commandTrie?.complete(typed) ?? "";
  if (trieSuffix.length > 0) {
    ghostTypedEl.textContent = typed;
    ghostSuffixEl.textContent = trieSuffix;
    lastGhostSuffix = trieSuffix;
    return;
  }

  if (result.kind === "candidates" && result.candidates.length > 0) {
    const label = result.candidates[0].label;
    const t = typed;
    if (t.trim().length === 0) {
      suffix = label;
    } else if (label.toLowerCase().startsWith(t.toLowerCase())) {
      suffix = label.slice(t.length);
    }
  } else if (result.kind === "resolved") {
    const label = result.label;
    const t = typed;
    if (label.toLowerCase().startsWith(t.toLowerCase())) {
      suffix = label.slice(t.length);
    }
  }

  ghostTypedEl.textContent = typed;
  ghostSuffixEl.textContent = suffix;
  lastGhostSuffix = suffix;
}

function render(input: string, ctx: PaletteContext): void {
  if (!listEl || !ghostEl || !inputEl) return;

  const result = parse(input, ctx);
  updateInlineGhost(input, result, ctx);

  if (result.kind === "candidates") {
    currentCandidates = result.candidates;
    selectedIndex = result.candidates.length > 0 ? 0 : -1;

    listEl.innerHTML = result.candidates
      .map(
        (c, i) => `
        <div class="palette-item${i === selectedIndex ? " selected" : ""}" data-index="${i}">
          <span class="palette-item-label">${c.label}</span>
          <span class="palette-item-conf">${(c.confidence * 100).toFixed(0)}%</span>
        </div>
      `
      )
      .join("");

    listEl.querySelectorAll(".palette-item").forEach((el) => {
      el.addEventListener("click", () => {
        const idx = parseInt(el.getAttribute("data-index") ?? "0", 10);
        selectIntent(currentCandidates[idx]?.intent);
      });
    });

    ghostEl.innerHTML = result.candidates
      .slice(0, 3)
      .map(
        (c) => `
        <div class="ghost-item">
          <span class="ghost-label">${c.label}</span>
          <span class="ghost-hint">↩ to select</span>
        </div>
      `
      )
      .join("");

    ghostEl.querySelectorAll(".ghost-item").forEach((el, i) => {
      el.addEventListener("click", () => {
        if (currentCandidates[i]) {
          selectIntent(currentCandidates[i].intent);
        }
      });
    });
  } else if (result.kind === "resolved") {
    currentCandidates = [{ intent: result.intent, confidence: result.confidence, label: result.label }];
    selectedIndex = 0;
    listEl.innerHTML = `
      <div class="palette-item palette-item-resolved selected">
        <span class="palette-item-label">${result.label}</span>
      </div>
    `;
    listEl.querySelector(".palette-item")?.addEventListener("click", () => {
      selectIntent(result.intent);
    });
    ghostEl.innerHTML = "";
  } else {
    currentCandidates = [];
    selectedIndex = -1;
    listEl.innerHTML = `
      <div class="palette-item palette-hint">${result.hint}</div>
    `;
    ghostEl.innerHTML = "";
  }
}
