type NavItem = { href: string; label: string };

const NAV: NavItem[] = [
  { href: "/create",   label: "FORGE" },
  { href: "/tasks",    label: "ARMORY" },
  { href: "/reviews",  label: "INTEL" },
  { href: "/project",  label: "PROJECT" },
  { href: "/profile",  label: "PROFILE" },
  { href: "/settings", label: "SETTINGS" },
];

function isActive(href: string, path: string): boolean {
  if (href === "/project") return path.startsWith("/project");
  return path === href;
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
          <div class="ff-brand__badge">PRODUCTION_OS</div>
        </div>
        <div class="ff-brand__badge">SECTOR_01-A · UPTIME_99.9%</div>
      </header>

      <div class="ff-shell__body">
        <aside class="ff-sidenav">
          <div class="ff-sidenav__header">
            <div class="ff-sidenav__title">FORTRESS_OS</div>
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
    </div>
  `;
}

