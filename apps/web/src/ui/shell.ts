type NavItem = { href: string; label: string };

const NAV: NavItem[] = [
  { href: "/create",   label: "CREATE" },
  { href: "/tasks",    label: "TASKS" },
  { href: "/reviews",  label: "REVIEWS" },
  { href: "/project",  label: "PROJECT" },
  { href: "/profile",  label: "PROFILE" },
  { href: "/settings", label: "SETTINGS" },
];

function isActive(href: string, path: string): boolean {
  // Support both direct path argument and hash-based SPA routing
  const hashRoute = window.location.hash.replace(/^#/, "") || "/";
  const effectivePath = path !== window.location.pathname ? path : hashRoute;
  if (href === "/project") return effectivePath.startsWith("/project");
  return effectivePath === href || path === href;
}

export function renderShell(opts: {
  title: string;
  subtitle?: string;
  activePath?: string;
  contentHtml: string;
}): string {
  const path = opts.activePath ?? window.location.pathname;
  const navHtml = NAV.map((n) => {
    const current = isActive(n.href, path) ? ' aria-current="page"' : "";
    return `<a href="${n.href}"${current}>${n.label}</a>`;
  }).join("");

  return `
    <div class="ff-shell">
      <header class="ff-topbar">
        <div class="ff-brand">
          <div class="ff-brand__name">FATED_FORTRESS</div>
          <div class="ff-brand__badge">OP_PLATFORM</div>
        </div>
        <div class="ff-brand__badge">&#9679;&nbsp;CONNECTED&nbsp;&nbsp;V.2.04_STABLE</div>
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
