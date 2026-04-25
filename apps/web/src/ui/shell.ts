/**
 * apps/web/src/ui/shell.ts — App chrome: topbar, sidenav, footer.
 *
 * Changes:
 *   - isActive(): unified hash-first SPA routing check
 *   - Notification badge: live unread count wired to ff:notification events
 */

import { getUnreadCount } from "../net/notifications.js";

type NavItem = { href: string; label: string };

const NAV: NavItem[] = [
  { href: "/create",   label: "CREATE" },
  { href: "/tasks",    label: "TASKS" },
  { href: "/reviews",  label: "REVIEWS" },
  { href: "/project",  label: "PROJECT" },
  { href: "/profile",  label: "PROFILE" },
  { href: "/settings", label: "SETTINGS" },
];

/** Hash-first active check for SPA routing. */
function isActive(href: string): boolean {
  const hash = window.location.hash.replace(/^#/, "") || window.location.pathname;
  const route = hash.startsWith("/") ? hash : "/" + hash;
  if (href === "/project") return route.startsWith("/project");
  return route === href;
}

export function renderShell(opts: {
  title: string;
  subtitle?: string;
  activePath?: string;
  contentHtml: string;
}): string {
  const navHtml = NAV.map((n) => {
    const current = isActive(n.href) ? ' aria-current="page"' : "";
    return `<a href="${n.href}"${current}>${n.label}</a>`;
  }).join("");

  return `
    <div class="ff-shell">
      <header class="ff-topbar">
        <div class="ff-brand">
          <div class="ff-brand__name">FATED_FORTRESS</div>
          <div class="ff-brand__badge">OP_PLATFORM</div>
        </div>
        <div style="display:flex;align-items:center;gap:16px">
          <button id="ff-notif-bell"
                  aria-label="Notifications"
                  style="background:none;border:none;cursor:pointer;position:relative;
                         font-family:var(--ff-font-mono);font-size:16px;color:var(--ff-ink);
                         padding:0;line-height:1">
            &#128276;
            <span id="ff-notif-badge"
                  style="display:none;position:absolute;top:-4px;right:-6px;
                         background:var(--ff-error);color:#fff;
                         font-size:9px;font-weight:900;font-family:var(--ff-font-mono);
                         border-radius:99px;padding:1px 4px;min-width:14px;
                         text-align:center;line-height:14px">0</span>
          </button>
          <div class="ff-brand__badge">&#9679;&nbsp;CONNECTED&nbsp;&nbsp;V.2.04_STABLE</div>
        </div>
      </header>

      <div class="ff-shell__body">
        <aside class="ff-sidenav">
          <div class="ff-sidenav__header">
            <div class="ff-sidenav__title">FATED_FORTRESS</div>
            <div class="ff-sidenav__ver">V.2.04_STABLE</div>
          </div>
          <nav class="ff-nav">
            ${navHtml}
          </nav>
        </aside>

        <main class="ff-main">
          <h1 class="ff-h1">${opts.title}</h1>
          ${opts.subtitle ? `<p class="ff-subtitle">${opts.subtitle}</p>` : ""}
          ${opts.contentHtml}
        </main>
      </div>

      <footer class="ff-footer">
        <span>FATED_FORTRESS &copy; ${new Date().getFullYear()}</span>
        <div class="ff-footer__meta">
          <span class="ff-footer__status">&#9679;&nbsp;CONNECTED</span>
          <span>V.2.04_STABLE</span>
        </div>
      </footer>
    </div>
  `;
}

/**
 * Wire up the notification bell badge after the shell HTML is in the DOM.
 * Call this once per page load after renderShell() and auth bootstrap.
 *
 * @param userId  The authenticated user's UUID.
 * @returns       Teardown function — call on SPA unmount.
 */
export function mountShellNotifications(userId: string): () => void {
  const bell  = document.getElementById("ff-notif-bell");
  const badge = document.getElementById("ff-notif-badge");
  if (!bell || !badge) return () => {};

  let count = 0;

  function updateBadge(n: number): void {
    count = Math.max(0, n);
    badge!.textContent = count > 99 ? "99+" : String(count);
    badge!.style.display = count > 0 ? "inline-block" : "none";
  }

  // Fetch initial unread count
  getUnreadCount(userId).then(updateBadge).catch(() => {});

  // Increment on new notifications
  const onNew = () => updateBadge(count + 1);
  document.addEventListener("ff:notification", onNew);

  // Decrement (or refetch) on read events
  const onRead = () => updateBadge(count - 1);
  document.addEventListener("ff:notification:read", onRead);

  // Bell click — navigate to a notifications page (or clear badge)
  const onBellClick = () => {
    window.location.hash = "#/notifications";
  };
  bell.addEventListener("click", onBellClick);

  return () => {
    document.removeEventListener("ff:notification", onNew);
    document.removeEventListener("ff:notification:read", onRead);
    bell.removeEventListener("click", onBellClick);
  };
}
