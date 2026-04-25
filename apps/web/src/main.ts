/**
 * apps/web/src/main.ts — MVP router: Task, Submission, Decision.
 *
 * Sacred objects: Task, Submission, Decision
 * System of record: Supabase
 *
 * Routes:
 *   /login           — Supabase Auth
 *   /create          — Host: project brief + SCOPE
 *   /tasks           — Contributor: browse + claim
 *   /submit/:taskId  — Contributor: upload + submit
 *   /reviews         — Host: review queue (MVP moat)
 *   /project/:id     — Project detail + activity feed
 *   /profile         — Profile + review_reliability
 *   /settings        — GitHub + Stripe Connect onboarding
 */

import * as Sentry from "@sentry/browser";
import { scrubEvent } from "@fatedfortress/sentry-utils";
import { getSupabase } from "./auth/index.js";
import { getRedirectPath } from "./auth/middleware.js";
import { subscribeToNotifications, unsubscribeFromNotifications } from "./net/notifications.js";
import "./styles/design-system.css";
import "./styles/ff.css";

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
  { href: "/tasks",   label: "Tasks" },
  { href: "/submit",  label: "Submit",  roles: ["contributor"] },
  { href: "/create",  label: "Create",  roles: ["host"] },
  { href: "/reviews", label: "Reviews", roles: ["host"] },
  { href: "/profile", label: "Profile" },
  { href: "/settings",label: "Settings" },
];

function buildShell(role: string | null): string {
  const links = NAV_LINKS.filter(l => !l.roles || (role && l.roles.includes(role)));
  return `
    <div class="ff-shell">
      <header class="ff-topbar">
        <div class="ff-brand">
          <span class="ff-brand__name">FatedFortress</span>
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
      // topbar inline links
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

// ── Route registry ────────────────────────────────────────────────────────────

type PageLoader = (container: HTMLElement) => Promise<() => void>;
type RouteInitializer = () => Promise<() => PageLoader>;

const routes: Record<string, RouteInitializer> = {
  "/login":           () => import("./pages/login.js").then(m => () => m.mountLogin),
  "/create":          () => import("./pages/create.js").then(m => () => m.mountCreate),
  "/tasks":           () => import("./pages/tasks.js").then(m => () => m.mountTasks),
  "/reviews":         () => import("./pages/reviews.js").then(m => () => m.mountReviews),
  "/profile":         () => import("./pages/profile.ts").then(m => () => m.mountProfile),
  "/settings":        () => import("./pages/settings.ts").then(m => () => m.mountSettings),
  "/github/callback": () => import("./pages/settings.ts").then(m => () => m.mountGitHubCallback),
};

type PageCleanup = (() => void) | void | Promise<() => void>;

let currentCleanup: PageCleanup = null;
let notifChannel: ReturnType<typeof subscribeToNotifications> | null = null;

async function route(path: string) {
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

  // Static routes
  const routePath = "/" + path.split("/")[1];
  const routeInit = routes[routePath];
  if (routeInit) {
    const getPage = await routeInit();
    currentCleanup = await getPage()(container);
    return;
  }

  // /submit/:taskId
  const submitMatch = path.match(/^\/submit\/(.+)/);
  if (submitMatch) {
    const taskId = submitMatch[1];
    const mod = await import("./pages/submit.js");
    currentCleanup = await mod.mountSubmit(container, taskId);
    return;
  }

  // /project/:projectId
  const projectMatch = path.match(/^\/project\/(.+)/);
  if (projectMatch) {
    const projectId = projectMatch[1];
    const mod = await import("./pages/project.js");
    currentCleanup = await mod.mountProject(container, projectId);
    return;
  }

  // 404
  container.innerHTML = `<div class="ff-empty-state"><h1 class="ff-empty-state__title">404</h1><p class="ff-empty-state__description">Page not found.</p><a href="/tasks" class="ff-btn ff-btn--ghost ff-btn--sm" style="margin-top:16px">Back to Tasks</a></div>`;
}

// ── Auth guard + init ─────────────────────────────────────────────────────────

async function init() {
  const supabase = getSupabase();
  const { data: { session } } = await supabase.auth.getSession();
  const isLoggedIn = !!session?.user;
  const redirectTo = getRedirectPath(isLoggedIn, window.location.pathname);

  if (redirectTo) {
    window.location.href = redirectTo;
    return;
  }

  // Fetch role for nav filtering
  let role: string | null = null;
  if (isLoggedIn && session.user) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", session.user.id)
      .single();
    role = profile?.role ?? null;
  }

  // Render shell (skip on /login — no nav needed)
  const isAuthPage = window.location.pathname === "/login";
  if (!isAuthPage) {
    document.body.innerHTML = buildShell(role);
  } else {
    // Auth page: plain container
    let app = document.createElement("div");
    app.id = "ff-main";
    document.body.appendChild(app);
  }

  if (isLoggedIn && session.user) {
    notifChannel = subscribeToNotifications(session.user.id);
  }

  await route(window.location.pathname);

  window.addEventListener("popstate", () => route(window.location.pathname));

  document.addEventListener("click", (e) => {
    const target = (e.target as Element)?.closest("a");
    if (!target) return;
    const href = target.getAttribute("href");
    if (!href || href.startsWith("http") || href.startsWith("mailto:")) return;
    if (href.startsWith("/")) {
      e.preventDefault();
      window.history.pushState({}, "", href);
      route(href);
    }
  });
}

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(console.error);
}

init();
