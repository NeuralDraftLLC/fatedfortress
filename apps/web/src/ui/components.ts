/**
 * apps/web/src/ui/components.ts — FatedFortress UI primitive library.
 *
 * All UI primitives return HTML strings.
 * Pages compose them into full screens.
 *
 * Design principles:
 * - CSS-class-based, no inline styles in JS
 * - All user-facing text is a parameter (enables i18n, theme replacement)
 * - Components are pure functions: (props) => string
 * - Components know nothing about Supabase, edge functions, or routing
 *
 * The component system is intentionally minimal:
 *   container.innerHTML = renderShell({ contentHtml: Btn({ label: "Submit", ... }) + ... })
 *
 * For stateful interactions, pages query DOM elements post-render and bind listeners.
 * A future layer can add hooks/render functions as the team needs.
 */

export {};

// ---------------------------------------------------------------------------
// Icon helper
// ---------------------------------------------------------------------------

/** Google Material Symbols icon — renders as inline span */
export function Icon(name: string, opts?: { size?: number; fill?: boolean; class?: string }): string {
  const size = opts?.size ?? 20;
  const fill = opts?.fill ? 1 : 0;
  const cls = opts?.class ? ` ${opts.class}` : "";
  return `<span class="material-symbols-outlined${cls}" style="font-size:${size}px;font-variation-settings:'FILL' ${fill}" data-icon="${name}">${name}</span>`;
}

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

export type BtnVariant = "primary" | "secondary" | "ghost" | "danger";
export type BtnSize = "sm" | "md" | "lg";

export interface BtnProps {
  label: string;
  variant?: BtnVariant;
  size?: BtnSize;
  disabled?: boolean;
  loading?: boolean;
  icon?: string;         // material symbol name
  iconRight?: string;    // material symbol name
  class?: string;
  id?: string;
  type?: "button" | "submit" | "reset";
}

export function Btn(p: BtnProps): string {
  const variant = p.variant ?? "primary";
  const size = p.size ?? "md";
  const cls = [
    "ff-btn",
    `ff-btn--${variant}`,
    p.disabled || p.loading ? "ff-btn--disabled" : "",
    p.class ?? "",
  ].filter(Boolean).join(" ");

  const iconLeft = p.icon ? Icon(p.icon, { size: size === "sm" ? 14 : size === "lg" ? 20 : 16 }) + " " : "";
  const iconRight = p.iconRight ? " " + Icon(p.iconRight, { size: size === "sm" ? 14 : size === "lg" ? 20 : 16 }) : "";
  const label = p.loading ? `<span class="ff-btn__spinner"></span>${p.label}` : p.label;

  return `<button
    ${p.id ? `id="${p.id}"` : ""}
    type="${p.type ?? "button"}"
    class="${cls.trim()}"
    ${p.disabled || p.loading ? "disabled" : ""}
    data-btn="true"
  >${iconLeft}${label}${iconRight}</button>`;
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

export interface CardProps {
  id?: string;
  class?: string;
  children: string;
  hoverable?: boolean;
}

export function Card(p: CardProps): string {
  const cls = ["ff-card", p.hoverable ? "ff-card--hoverable" : "", p.class ?? ""].filter(Boolean).join(" ");
  return `<div ${p.id ? `id="${p.id}"` : ""} class="${cls.trim()}">${p.children}</div>`;
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export interface PanelProps {
  id?: string;
  class?: string;
  children: string;
  accent?: "rust" | "gold" | "none";
  noPadding?: boolean;
}

export function Panel(p: PanelProps): string {
  const accent = p.accent ?? "none";
  const cls = [
    "ff-panel",
    accent === "rust" ? "ff-panel--rust" : "",
    accent === "gold" ? "ff-panel--gold" : "",
    p.noPadding ? "ff-panel--no-padding" : "",
    p.class ?? "",
  ].filter(Boolean).join(" ");
  return `<div ${p.id ? `id="${p.id}"` : ""} class="${cls.trim()}">${p.children}</div>`;
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

export type BadgeVariant = "success" | "warning" | "error" | "info" | "neutral" | "gold";

export interface BadgeProps {
  label: string;
  variant?: BadgeVariant;
  icon?: string;        // material symbol name
  class?: string;
  id?: string;
}

export function Badge(p: BadgeProps): string {
  const variant = p.variant ?? "neutral";
  const cls = ["ff-badge", `ff-badge--${variant}`, p.class ?? ""].filter(Boolean).join(" ");
  const icon = p.icon ? Icon(p.icon, { size: 12 }) + " " : "";
  return `<span ${p.id ? `id="${p.id}"` : ""} class="${cls.trim()}">${icon}${escHtml(p.label)}</span>`;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface InputProps {
  id?: string;
  name?: string;
  label?: string;
  type?: "text" | "email" | "password" | "number" | "url" | "search" | "tel";
  placeholder?: string;
  value?: string;
  required?: boolean;
  disabled?: boolean;
  error?: string;
  hint?: string;
  class?: string;
  autocomplete?: string;
  min?: number | string;
  max?: number | string;
  step?: number | string;
}

export function Input(p: InputProps): string {
  const err = p.error;
  const cls = ["ff-input-wrapper", err ? "ff-input-wrapper--error" : "", p.class ?? ""].filter(Boolean).join(" ");
  return `<div class="${cls.trim()}">
    ${p.label ? `<label class="ff-label" for="${p.id ?? p.name ?? ""}">${escHtml(p.label)}${p.required ? ' <span class="ff-label__required">*</span>' : ""}</label>` : ""}
    <input
      ${p.id ? `id="${p.id}"` : ""}
      ${p.name ? `name="${p.name}"` : ""}
      type="${p.type ?? "text"}"
      class="ff-input${err ? " ff-input--error" : ""}"
      placeholder="${escHtml(p.placeholder ?? "")}"
      value="${escHtml(p.value ?? "")}"
      ${p.required ? "required" : ""}
      ${p.disabled ? "disabled" : ""}
      ${p.autocomplete ? `autocomplete="${p.autocomplete}"` : ""}
      ${p.min !== undefined ? `min="${p.min}"` : ""}
      ${p.max !== undefined ? `max="${p.max}"` : ""}
      ${p.step !== undefined ? `step="${p.step}"` : ""}
    />
    ${err ? `<span class="ff-input-error">${escHtml(err)}</span>` : ""}
    ${p.hint && !err ? `<span class="ff-input-hint">${escHtml(p.hint)}</span>` : ""}
  </div>`;
}

// ---------------------------------------------------------------------------
// Select
// ---------------------------------------------------------------------------

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps {
  id?: string;
  name?: string;
  label?: string;
  options: SelectOption[];
  value?: string;
  required?: boolean;
  disabled?: boolean;
  error?: string;
  class?: string;
  placeholder?: string;
}

export function Select(p: SelectProps): string {
  const cls = ["ff-select-wrapper", p.error ? "ff-select-wrapper--error" : "", p.class ?? ""].filter(Boolean).join(" ");
  const opts = p.placeholder
    ? `<option value="">${escHtml(p.placeholder)}</option>${p.options.map(o => `<option value="${escHtml(o.value)}"${o.value === p.value ? " selected" : ""}${o.disabled ? " disabled" : ""}>${escHtml(o.label)}</option>`).join("")}`
    : p.options.map(o => `<option value="${escHtml(o.value)}"${o.value === p.value ? " selected" : ""}${o.disabled ? " disabled" : ""}>${escHtml(o.label)}</option>`).join("");

  return `<div class="${cls.trim()}">
    ${p.label ? `<label class="ff-label" for="${p.id ?? p.name ?? ""}">${escHtml(p.label)}${p.required ? ' <span class="ff-label__required">*</span>' : ""}</label>` : ""}
    <select
      ${p.id ? `id="${p.id}"` : ""}
      ${p.name ? `name="${p.name}"` : ""}
      class="ff-select${p.error ? " ff-select--error" : ""}"
      ${p.required ? "required" : ""}
      ${p.disabled ? "disabled" : ""}
    >${opts}</select>
    ${p.error ? `<span class="ff-select-error">${escHtml(p.error)}</span>` : ""}
  </div>`;
}

// ---------------------------------------------------------------------------
// Textarea
// ---------------------------------------------------------------------------

export interface TextareaProps {
  id?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  value?: string;
  required?: boolean;
  disabled?: boolean;
  error?: string;
  hint?: string;
  rows?: number;
  maxlength?: number;
  class?: string;
}

export function Textarea(p: TextareaProps): string {
  const cls = ["ff-textarea-wrapper", p.error ? "ff-textarea-wrapper--error" : "", p.class ?? ""].filter(Boolean).join(" ");
  return `<div class="${cls.trim()}">
    ${p.label ? `<label class="ff-label" for="${p.id ?? p.name ?? ""}">${escHtml(p.label)}${p.required ? ' <span class="ff-label__required">*</span>' : ""}</label>` : ""}
    <textarea
      ${p.id ? `id="${p.id}"` : ""}
      ${p.name ? `name="${p.name}"` : ""}
      class="ff-textarea${p.error ? " ff-textarea--error" : ""}"
      placeholder="${escHtml(p.placeholder ?? "")}"
      rows="${p.rows ?? 4}"
      ${p.maxlength ? `maxlength="${p.maxlength}"` : ""}
      ${p.required ? "required" : ""}
      ${p.disabled ? "disabled" : ""}
    >${escHtml(p.value ?? "")}</textarea>
    ${p.error ? `<span class="ff-textarea-error">${escHtml(p.error)}</span>` : ""}
    ${p.hint && !p.error ? `<span class="ff-textarea-hint">${escHtml(p.hint)}</span>` : ""}
  </div>`;
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export interface ModalProps {
  id?: string;
  title: string;
  children: string;
  footerHtml?: string;
  size?: "sm" | "md" | "lg";
  onClose?: string;    // CSS class to toggle visibility, e.g. "hidden"
}

export function Modal(p: ModalProps): string {
  const size = p.size ?? "md";
  return `<div
    ${p.id ? `id="${p.id}"` : ""}
    class="ff-modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby="${p.id ? p.id + "-title" : "modal-title"}"
  >
    <div class="ff-modal__backdrop" data-modal-close="true"></div>
    <div class="ff-modal__panel ff-modal__panel--${size}">
      <div class="ff-modal__header">
        <h2 class="ff-modal__title" id="${p.id ? p.id + "-title" : "modal-title"}">${escHtml(p.title)}</h2>
        <button class="ff-modal__close" data-modal-close="true" aria-label="Close">
          ${Icon("close", { size: 20 })}
        </button>
      </div>
      <div class="ff-modal__body">${p.children}</div>
      ${p.footerHtml ? `<div class="ff-modal__footer">${p.footerHtml}</div>` : ""}
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Toast / Notification
// ---------------------------------------------------------------------------

export type ToastVariant = "success" | "error" | "warning" | "info";

export interface ToastProps {
  message: string;
  variant?: ToastVariant;
  duration?: number;   // ms, default 5000, 0 = persistent
  action?: { label: string; handler: string };  // handler is a JS expression string
}

export function Toast(p: ToastProps): string {
  const variant = p.variant ?? "info";
  const iconMap: Record<ToastVariant, string> = {
    success: "check_circle",
    error: "error",
    warning: "warning",
    info: "info",
  };
  const icon = Icon(iconMap[variant], { size: 16 });
  return `<div class="ff-toast ff-toast--${variant}" role="alert" data-toast="true">
    <span class="ff-toast__icon">${icon}</span>
    <span class="ff-toast__message">${escHtml(p.message)}</span>
    ${p.action ? `<button class="ff-toast__action" data-toast-action="${escHtml(p.action.handler)}">${escHtml(p.action.label)}</button>` : ""}
    <button class="ff-toast__close" aria-label="Dismiss">${Icon("close", { size: 14 })}</button>
  </div>`;
}

// ---------------------------------------------------------------------------
// Toast container (mount point for toasts)
// ---------------------------------------------------------------------------

export function ToastContainer(): string {
  return `<div id="toast-container" class="ff-toast-container" aria-live="polite"></div>`;
}

/**
 * Show a toast. Call this from page handlers after DOM is mounted.
 * Appends to #toast-container, auto-removes after duration.
 */
export function showToast(
  container: HTMLElement,
  message: string,
  variant: ToastVariant = "info",
  duration = 5000
): void {
  const tc = container.ownerDocument.getElementById("toast-container") ?? container.appendChild(container.ownerDocument.createElement("div"));
  if (!tc.id) { tc.id = "toast-container"; tc.className = "ff-toast-container"; }
  const el = container.ownerDocument.createElement("div");
  el.innerHTML = Toast({ message, variant, duration });
  const toastEl = el.firstElementChild as HTMLElement;
  tc.appendChild(toastEl);

  toastEl.querySelector(".ff-toast__close")?.addEventListener("click", () => toastEl.remove());
  if (duration > 0) setTimeout(() => toastEl.remove(), duration);
}

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

export interface SpinnerProps {
  label?: string;
  size?: "sm" | "md" | "lg";
}

export function Spinner(p?: SpinnerProps): string {
  const size = p?.size ?? "md";
  const label = p?.label ?? "Loading...";
  return `<div class="ff-spinner ff-spinner--${size}" role="status" aria-label="${escHtml(label)}">
    <span class="ff-spinner__icon"></span>
    <span class="ff-spinner__label">${escHtml(label)}</span>
  </div>`;
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

export interface EmptyStateProps {
  icon?: string;        // material symbol name
  title: string;
  description?: string;
  actionHtml?: string;   // e.g. Btn({...}) output
}

export function EmptyState(p: EmptyStateProps): string {
  const icon = p.icon ?? "inbox";
  return `<div class="ff-empty-state">
    <div class="ff-empty-state__icon">${Icon(icon, { size: 40, class: "ff-empty-state__icon-symbol" })}</div>
    <h3 class="ff-empty-state__title">${escHtml(p.title)}</h3>
    ${p.description ? `<p class="ff-empty-state__description">${escHtml(p.description)}</p>` : ""}
    ${p.actionHtml ? `<div class="ff-empty-state__action">${p.actionHtml}</div>` : ""}
  </div>`;
}

// ---------------------------------------------------------------------------
// Divider / HR
// ---------------------------------------------------------------------------

export function Divider(label?: string): string {
  if (label) return `<div class="ff-divider"><span class="ff-divider__label">${escHtml(label)}</span></div>`;
  return `<hr class="ff-divider" />`;
}

// ---------------------------------------------------------------------------
// Tag / Skill chip
// ---------------------------------------------------------------------------

export interface TagProps {
  label: string;
  variant?: "default" | "success" | "warning" | "error" | "gold";
  removable?: boolean;
  onRemove?: string;   // JS expression
}

export function Tag(p: TagProps): string {
  const cls = ["ff-tag", p.variant ? `ff-tag--${p.variant}` : ""].filter(Boolean).join(" ");
  const removeBtn = p.removable
    ? `<button class="ff-tag__remove" data-tag-remove="${escHtml(p.onRemove ?? "")}" aria-label="Remove">${Icon("close", { size: 12 })}</button>`
    : "";
  return `<span class="${cls}">${escHtml(p.label)}${removeBtn}</span>`;
}

// ---------------------------------------------------------------------------
// Wallet gauge (deposited / locked / released)
// ---------------------------------------------------------------------------

export interface WalletGaugeProps {
  deposited: number;
  locked: number;
  released: number;
  currency?: string;
}

export function WalletGauge(p: WalletGaugeProps): string {
  const c = p.currency ?? "$";
  const total = p.deposited;
  const releasedPct = total > 0 ? (p.released / total) * 100 : 0;
  const lockedPct = total > 0 ? (p.locked / total) * 100 : 0;
  const depositedPct = total > 0 ? ((p.deposited - p.released - p.locked) / total) * 100 : 0;

  return `<div class="ff-wallet-gauge">
    <div class="ff-wallet-gauge__bar">
      <div class="ff-wallet-gauge__segment ff-wallet-gauge__segment--released" style="width:${releasedPct}%"></div>
      <div class="ff-wallet-gauge__segment ff-wallet-gauge__segment--locked" style="width:${lockedPct}%"></div>
      <div class="ff-wallet-gauge__segment ff-wallet-gauge__segment--deposited" style="width:${depositedPct}%"></div>
    </div>
    <div class="ff-wallet-gauge__legend">
      <span class="ff-wallet-gauge__legend-item ff-wallet-gauge__legend-item--released">${Icon("check_circle", { size: 12 })} Released ${c}${p.released.toFixed(2)}</span>
      <span class="ff-wallet-gauge__legend-item ff-wallet-gauge__legend-item--locked">${Icon("lock", { size: 12 })} Locked ${c}${p.locked.toFixed(2)}</span>
      <span class="ff-wallet-gauge__legend-item ff-wallet-gauge__legend-item--deposited">${Icon("account_balance", { size: 12 })} Deposited ${c}${(p.deposited - p.released - p.locked).toFixed(2)}</span>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Escape helper
// ---------------------------------------------------------------------------

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export { escHtml };