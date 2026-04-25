/**
 * apps/web/src/main.ts — MVP router: Task, Submission, Decision.
 *
 * Sacred objects: Task, Submission, Decision
 * System of record: Supabase
 *
 * Routes:
 *   /                  — Public landing page (no auth required)
 *   /login             — Supabase Auth (reads ?mode, ?role, ?next)
 *   /auth/callback     — Supabase OAuth/magic-link return (new)
 *   /tasks             — Contributor: browse (public) + claim (auth-gated)
 *   /create            — Host: project brief + SCOPE
 *   /submit/:taskId    — Contributor: upload + submit
 *   /reviews           — Host: review queue (MVP moat)
 *   /project/:id       — Project detail + activity feed
 *   /profile           — Profile + review_reliability
 *   /settings          — GitHub + Stripe Connect onboarding
 *
 * ?next= preservation:
 *   requireAuth() appends ?next=<encoded-path> when redirecting to /login.
 *   After sign-in, the router reads ?next= and navigates there instead of
 *   the default role-based redirect.
 */

import * as Sentry from "@sentry/browser";
import { scrubEvent } from "@fatedfortress/sentry-utils";
import { getSupabase } from "./auth/index.js";
import { getRedirectPath } from "./auth/middleware.js";
import { subscribeToNotifications, unsubscribeFromNotifications } from "./net/notifications.js";
import { setProfileDisplayName } from "./state/identity.js";
import { mountShellNotifications } from "./ui/shell.js";
import "./styles/design-system.css";
import "./styles/ff.css";
import "./styles/landing.css";

Sentry.init({
  dsn: typeof __SENTRY_DSN_WEB__ !== "undefined" ? __SENTRY_DSN_WEB__ : "",
  environment: import.meta.env.MODE,
  release: typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : undefined,
  tracesSampleRate: 0.1,
  sendDefaultPii: false,
  beforeSend: (event) => scrubEvent(event as any),
});

// ── Shell HTML (rendered once; nav active state updated per route) ─────────

const NAV_LINKS: Array<{ href: string; label: string; roles?: string[] }> = [
  { href: "/tasks",    label: "Tasks" },
  { href: "/submit",   label: "Submit",   roles: ["contributor"] },
  { href: "/create",   label: "Create",   roles: ["host"] },
  { href: "/reviews",  label: "Reviews",  roles: ["host"] },
  { href: "/profile",  label: "Profile" },
  { href: "/settings", label: "Settings" },
];

function buildShell(role: string | null): string {
  const links = NAV_LINKS.filter(l => !l.roles || (role && l.roles.includes(role)));
  return `
    <div class="ff-shell">
      <header class="ff-topbar">
        <div class="ff-brand">
          <a href="/" class="ff-brand__name" style="text-decoration:none;color:inherit">FatedFortress</a>
          <span class="ff-brand__badge">MVP</span>
        </div>
        <nav class="ff-topbar__user" style="display:flex;gap:16px;align-items:center">
          ${links.map(l =>
            `<a href="${l.href}" class="ff-nav-link" data-route="${l.href}"
               style="font-family:var(--ff-font-mono);font-size:10px;text-transform:uppercase;
                      letter-spacing:.08em;color:var(--ff-muted);text-decoration:none;
                      font-weight:700;padding:4px 0;border-bottom:2px solid transparent"
             >${l.label}</a>`
          ).join("")}
          <!-- Notification bell: wired by mountShellNotifications() after render -->
          <button id="ff-notif-bell"
                  aria-label="Notifications"
                  style="background:none;border:none;cursor:pointer;position:relative;
                         font-family:var(--ff-font-mono);font-size:15px;color:var(--ff-muted);
                         padding:0 2px;line-height:1;display:flex;align-items:center">
            &#128276;
            <span id="ff-notif-badge"
                  style="display:none;position:absolute;top:-5px;right:-7px;
                         background:var(--ff-error,#e53935);color:#fff;
                         font-size:9px;font-weight:900;font-family:var(--ff-font-mono);
                         border-radius:99px;padding:1px 4px;min-width:14px;
                         text-align:center;line-height:14px"
            >0</span>
          </button>
        </nav>
      </header>
      <div class="ff-shell__body">
        <aside class="ff-sidenav" id="ff-sidenav">
          <div class="ff-sidenav__header">
            <div class="ff-sidenav__title">FF</div>
            <div class="ff-sidenav__ver">v2</div>
          </div>
          <nav class="ff-nav" id="ff-nav">
            ${links.map(l =>
              `<a href="${l.href}" data-route="${l.href}">${l.label}</a>`
            ).join("")}
          </nav>
        </aside>
        <main class="ff-main" id="ff-main"></main>
      </div>
    </div>
  `;
}

function setActiveNav(path: string) {
  document.querySelectorAll("[data-route]").forEach((el) => {
    const route = el.getAttribute("data-route") ?? "";
    const isActive = path === route || (route !== "/" && path.startsWith(route));
    if (el.tagName === "A") {
      (el as HTMLAnchorElement).setAttribute("aria-current", isActive ? "page" : "");
      if (el.classList.contains("ff-nav-link")) {
        (el as HTMLElement).style.borderBottomColor = isActive ? "var(--ff-ink)" : "transparent";
        (el as HTMLElement).style.color = isActive ? "var(--ff-ink)" : "var(--ff-muted)";
      }
    }
  });
}

function getMain(): HTMLElement {
  return document.getElementById("ff-main") as HTMLElement;
}

// ── ?next= helpers ─────────────────────────────────────────────────────────

/** Pop the ?next= param if we just landed from a requireAuth() redirect. */
function consumeNextParam(): string | null {
  const params = new URLSearchParams(window.location.search);
  const next   = params.get("next");
  if (!next) return null;
  params.delete("next");
  const clean = window.location.pathname + (params.toString() ? "?" + params.toString() : "");
  window.history.replaceState({}, "", clean);
  return decodeURIComponent(next);
}

// ── Route registry ──────────────────────────────────────────────────────────

type PageLoader       = (container: HTMLElement) => Promise<() => void>;
type RouteInitializer = () => Promise<() => PageLoader>;

const routes: Record<string, RouteInitializer> = {
  "/login":           () => import("./pages/login.js").then(m => () => m.mountLogin),
  "/auth/callback":   () => import("./pages/callback.js").then(m => () => m.mountCallback),
  "/create":          () => import("./pages/create.js").then(m => () => m.mountCreate),
  "/tasks":           () => import("./pages/tasks.js").then(m => () => m.mountTasks),
  "/reviews":         () => import("./pages/reviews.js").then(m => () => m.mountReviews),
  "/profile":         () => import("./pages/profile.js").then(m => () => m.mountProfile),
  "/settings":        () => import("./pages/settings.js").then(m => () => m.mountSettings),
  "/github/callback": () => import("./pages/settings.js").then(m => () => m.mountGitHubCallback),
  "/terms":           () => Promise.resolve(() => (c: HTMLElement) => { c.innerHTML = `<div class="ff-panel" style="max-width:640px;margin:40px auto;padding:32px"><h1 class="ff-h1">Terms of Service</h1><p class="ff-subtitle" style="margin-top:16px">Coming soon.</p></div>`; return Promise.resolve(() => {}); }),
  "/privacy":         () => Promise.resolve(() => (c: HTMLElement) => { c.innerHTML = `<div class="ff-panel" style="max-width:640px;margin:40px auto;padding:32px"><h1 class="ff-h1">Privacy Policy</h1><p class="ff-subtitle" style="margin-top:16px">Coming soon.</p></div>`; return Promise.resolve(() => {}); }),
};

type PageCleanup = (() => void) | void | Promise<() => void>;

let currentCleanup: PageCleanup = null;
let notifChannel: ReturnType<typeof subscribeToNotifications> | null = null;

// Teardown for the shell-level notification bell badge.
// Stored separately from page-level currentCleanup so it survives SPA nav
// but is cleaned up when the shell itself is torn down (re-init / sign-out).
let shellNotifTeardown: (() => void) | null = null;

function teardownShellNotif(): void {
  if (shellNotifTeardown) {
    shellNotifTeardown();
    shellNotifTeardown = null;
  }
}

async function route(path: string, isLoggedIn: boolean) {
  // Teardown previous page
  if (currentCleanup) {
    const cleanup = await currentCleanup;
    cleanup?.();
    currentCleanup = null;
  }

  if (notifChannel) {
    unsubscribeFromNotifications();
    notifChannel = null;
  }

  setActiveNav(path);

  const container = getMain();
  if (!container) return;
  container.innerHTML = "";

  // Public landing page — no shell, no auth
  if (path === "/") {
    const mod = await import("./pages/landing.js");
    currentCleanup = await mod.mountLanding(container);
    return;
  }

  // /auth/callback — token exchange; handleAuthCallback() redirects away
  if (path === "/auth/callback" || path.startsWith("/auth/callback")) {
    const mod = await import("./pages/callback.js");
    currentCleanup = await mod.mountCallback(container);
    return;
  }

  // /tasks — public browse for guests, full authed view for members
  if (path === "/tasks" || path.startsWith("/tasks")) {
    const mod = await import("./pages/tasks.js");
    if (isLoggedIn) {
      currentCleanup = await mod.mountTasks(container);
    } else {
      currentCleanup = await mod.mountTasksGuest(container);
    }
    return;
  }

  // Static routes
  const routePath  = "/" + path.split("/")[1];
  const routeInit  = routes[routePath];
  if (routeInit) {
    const getPage  = await routeInit();
    currentCleanup = await getPage()(container);
    return;
  }

  // /submit/:taskId
  const submitMatch = path.match(/^\/submit\/(.+)/);
  if (submitMatch) {
    const taskId = submitMatch[1];
    const mod    = await import("./pages/submit.js");
    currentCleanup = await mod.mountSubmit(container, taskId);
    return;
  }

  // /project/:projectId
  const projectMatch = path.match(/^\/project\/(.+)/);
  if (projectMatch) {
    const projectId = projectMatch[1];
    const mod       = await import("./pages/project.js");
    currentCleanup  = await mod.mountProject(container, projectId);
    return;
  }

  // 404
  container.innerHTML = `
    <div class="ff-empty-state">
      <h1 class="ff-empty-state__title">404</h1>
      <p class="ff-empty-state__description">Page not found.</p>
      <a href="/tasks" class="ff-btn ff-btn--ghost ff-btn--sm" style="margin-top:16px">Back to Tasks</a>
    </div>`;
}

// ── Auth guard + init ───────────────────────────────────────────────────────

// Routes that never require authentication
const PUBLIC_ROUTES = new Set(["/", "/login", "/tasks", "/auth/callback", "/terms", "/privacy"]);

async function init() {
  // Tear down any existing shell-level notification badge listeners before
  // re-rendering the shell (sign-out, session refresh, etc.)
  teardownShellNotif();

  const supabase = getSupabase();
  const { data: { session } } = await supabase.auth.getSession();
  const isLoggedIn  = !!session?.user;
  const currentPath = window.location.pathname;
  const isPublic    = PUBLIC_ROUTES.has(currentPath) ||
    currentPath.startsWith("/tasks") ||
    currentPath.startsWith("/auth/");

  // ── ?next= redirect ──────────────────────────────────────────────────────
  if (isLoggedIn && !isPublic) {
    const next = consumeNextParam();
    if (next && next !== currentPath) {
      window.history.replaceState({}, "", next);
      return init();
    }
  }

  // Auth redirect — skip for public routes
  if (!isPublic) {
    const redirectTo = getRedirectPath(isLoggedIn, currentPath);
    if (redirectTo) {
      window.location.href = redirectTo;
      return;
    }
  }

  // ── Fetch profile: role + display_name ────────────────────────────────────
  let role: string | null = null;

  if (isLoggedIn && session.user) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("role, display_name")
      .eq("id", session.user.id)
      .single();

    role = profile?.role ?? null;

    // Wire display name into identity state so all CRDT / peer-presence
    // surfaces show the correct human label instead of 'Anonymous'.
    // Pass null (not empty string) when missing so getMyDisplayName()
    // falls back to its 'Anonymous' default rather than showing a blank.
    setProfileDisplayName(profile?.display_name ?? null);
  } else {
    // Signed out — reset to anonymous
    setProfileDisplayName(null);
  }

  // ── Render shell ───────────────────────────────────────────────────────────
  if (currentPath === "/") {
    const main = document.createElement("main");
    main.id = "ff-main";
    document.body.innerHTML = "";
    document.body.appendChild(main);

  } else if (currentPath === "/login" || currentPath.startsWith("/auth/")) {
    const app = document.createElement("div");
    app.id    = "ff-main";
    document.body.innerHTML = "";
    document.body.appendChild(app);

  } else if (isPublic && !isLoggedIn) {
    // Guest browsing a public route — minimal wrapper, no authenticated shell
    document.body.innerHTML = `
      <header class="ff-topbar ff-topbar--guest">
        <div class="ff-brand">
          <a href="/" class="ff-brand__name" style="text-decoration:none;color:inherit">FatedFortress</a>
          <span class="ff-brand__badge">MVP</span>
        </div>
        <nav style="display:flex;gap:12px;align-items:center">
          <a href="/tasks" class="ff-nav-link"
             style="font-family:var(--ff-font-mono);font-size:10px;text-transform:uppercase;
                    letter-spacing:.08em;color:var(--ff-muted);text-decoration:none;font-weight:700"
          >Tasks</a>
          <a href="/login" class="ff-btn ff-btn--primary ff-btn--sm">Sign In</a>
        </nav>
      </header>
      <main class="ff-main ff-main--guest" id="ff-main"></main>
    `;
  } else {
    // Authenticated shell with role-filtered nav + notification bell
    document.body.innerHTML = buildShell(role);

    // Wire notification badge NOW — bell elements exist in DOM
    // Store teardown so we can clean up on re-init (sign-out, session refresh)
    shellNotifTeardown = mountShellNotifications(session!.user.id);
  }

  // ── Realtime notifications channel ─────────────────────────────────────
  if (isLoggedIn && session!.user) {
    notifChannel = subscribeToNotifications(session!.user.id);
  }

  await route(currentPath, isLoggedIn);

  window.addEventListener("popstate", () => route(window.location.pathname, isLoggedIn));

  document.addEventListener("click", (e) => {
    const target = (e.target as Element)?.closest("a");
    if (!target) return;
    const href = target.getAttribute("href");
    if (!href || href.startsWith("http") || href.startsWith("mailto:")) return;
    if (href.startsWith("/")) {
      e.preventDefault();
      const nextPath    = href.split("?")[0];
      const nextIsPublic = PUBLIC_ROUTES.has(nextPath) ||
        nextPath.startsWith("/tasks") ||
        nextPath.startsWith("/auth/");
      window.history.pushState({}, "", href);
      if (nextIsPublic !== isPublic) {
        init();
      } else {
        route(nextPath, isLoggedIn);
      }
    }
  });
}

// ── Auth state change ──────────────────────────────────────────────────────
// Re-run init on sign-in / sign-out so display name, nav role filter,
// and notification badge all update without requiring a hard reload.
getSupabase().auth.onAuthStateChange((event) => {
  if (event === "SIGNED_IN" || event === "SIGNED_OUT") {
    init();
  }
});

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(console.error);
}

init();
