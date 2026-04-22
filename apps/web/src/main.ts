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

const APP_ROOT = "#app";

function getContainer(): HTMLElement {
  let app = document.querySelector<HTMLElement>(APP_ROOT);
  if (!app) {
    app = document.createElement("div");
    app.id = "app";
    document.body.appendChild(app);
  }
  app.innerHTML = "";
  return app;
}

// ── Route registry ────────────────────────────────────────────────────────────

type PageCleanup = (() => void) | void | Promise<() => void>;
type PageLoader = (container: HTMLElement, ...params: string[]) => Promise<() => void>;

const routes: Record<string, PageLoader> = {
  "/login":           () => import("./pages/login.js").then(m => m.mountLogin),
  "/create":          () => import("./pages/create.js").then(m => m.mountCreate),
  "/tasks":           () => import("./pages/tasks.js").then(m => m.mountTasks),
  "/reviews":         () => import("./pages/reviews.js").then(m => m.mountReviews),
  "/project":         () => import("./pages/project.js").then(m => m.mountProject),
  "/profile":         () => import("./pages/profile.js").then(m => m.mountProfile),
  "/settings":        () => import("./pages/settings.js").then(m => m.mountSettings),
  "/github/callback": () => import("./pages/settings.js").then(m => m.mountGitHubCallback),
  // submit is handled specially with a taskId param
};

let currentCleanup: PageCleanup = null;
let notifChannel: ReturnType<typeof subscribeToNotifications> | null = null;

async function route(path: string) {
  // Teardown previous page
  if (currentCleanup) {
    const cleanup = await currentCleanup;
    cleanup?.();
    currentCleanup = null;
  }

  // Global notification teardown
  if (notifChannel) {
    unsubscribeFromNotifications();
    notifChannel = null;
  }

  const container = getContainer();

  // Static routes — check before the submit param route
  const routePath = "/" + path.split("/")[1];
  const loader = routes[routePath];
  if (loader) {
    const page = await loader();
    currentCleanup = page(container);
    return;
  }

  // Handle /submit/:taskId specially (after static route check)
  const submitMatch = path.match(/^\/submit\/(.+)/);
  if (submitMatch) {
    const taskId = submitMatch[1];
    const mod = await import("./pages/submit.js");
    currentCleanup = mod.mountSubmit(container, taskId);
    return;
  }

  // 404 — no route matched
  container.innerHTML = `<div class="not-found"><h1>404</h1><p>Page not found</p><a href="/">Home</a></div>`;
}

// ── Auth guard ────────────────────────────────────────────────────────────────

async function init() {
  const supabase = getSupabase();
  const { data: { session } } = await supabase.auth.getSession();
  const isLoggedIn = !!session?.user;
  const redirectTo = getRedirectPath(isLoggedIn, window.location.pathname);

  if (redirectTo) {
    window.location.href = redirectTo;
    return;
  }

  // Subscribe to notifications if logged in
  if (isLoggedIn && session.user) {
    notifChannel = subscribeToNotifications(session.user.id);
  }

  // Initial route
  await route(window.location.pathname);

  // Navigation
  window.addEventListener("popstate", () => route(window.location.pathname));

  // Intercept internal link clicks for SPA navigation
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

// ── Service worker ────────────────────────────────────────────────────────────

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(console.error);
}

init();
