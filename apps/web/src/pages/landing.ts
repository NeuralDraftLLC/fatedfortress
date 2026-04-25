/**
 * apps/web/src/pages/landing.ts — Public landing page.
 *
 * CHANGES:
 *  - Stat strip now calls get-public-stats edge fn on mount.
 *    Animated counters: open tasks, total paid out, contributor count.
 *    Static stats retained for the two invariant marketing claims (10%, 48h).
 */

export async function mountLanding(container: HTMLElement): Promise<() => void> {
  container.innerHTML = `
    <div class="ff-landing">

      <!-- ── Nav ────────────────────────────────────────────────────── -->
      <header class="ff-landing__nav">
        <div class="ff-landing__nav-inner">
          <a href="/" class="ff-landing__logo" style="text-decoration:none;color:inherit">
            <span class="ff-landing__logo-mark">FF</span>
            <span class="ff-landing__logo-name">FatedFortress</span>
          </a>
          <nav class="ff-landing__nav-links">
            <a href="/tasks" class="ff-landing__nav-link">Browse Tasks</a>
            <a href="/login" class="ff-landing__nav-cta ff-btn ff-btn--ghost ff-btn--sm">Sign In</a>
            <a href="/login?mode=signup" class="ff-btn ff-btn--primary ff-btn--sm">Get Started</a>
          </nav>
        </div>
      </header>

      <!-- ── Hero ───────────────────────────────────────────────────── -->
      <section class="ff-landing__hero">
        <div class="ff-landing__hero-inner">
          <div class="ff-landing__eyebrow">AI SCOPING · STRIPE ESCROW · ZERO AMBIGUITY</div>
          <h1 class="ff-landing__headline">
            Replace vague briefs<br/>with math and guaranteed payouts.
          </h1>
          <p class="ff-landing__subhead">
            FatedFortress turns messy project ideas into machine-enforced contracts:
            funds are pre-authorized, scope is written as code, and files are
            auto-verified before money moves.
          </p>

          <!-- Role-split CTAs -->
          <div class="ff-landing__cta-row">
            <div class="ff-landing__cta-block">
              <a href="/login?mode=signup&role=host" class="ff-btn ff-btn--primary">Post a Project</a>
              <span class="ff-landing__cta-sub">Describe what you need — AI scopes and locks the budget.</span>
            </div>
            <div class="ff-landing__cta-block">
              <a href="/tasks" class="ff-btn ff-btn--ghost">Browse &amp; Claim Tasks</a>
              <span class="ff-landing__cta-sub">See funded work that's ready to start right now.</span>
            </div>
          </div>

          <!-- Social proof strip -->
          <div class="ff-landing__social-proof">
            <div class="ff-landing__avatars ff-landing__avatars--placeholder" aria-hidden="true">
              <span class="ff-landing__avatar-dot"></span>
              <span class="ff-landing__avatar-dot"></span>
              <span class="ff-landing__avatar-dot"></span>
              <span class="ff-landing__avatar-dot"></span>
              <span class="ff-landing__avatar-dot"></span>
            </div>
            <span class="ff-landing__social-text">
              Designed for builders who are done waiting 60 days to get paid or arguing about what \"done\" means.
            </span>
          </div>
        </div>

        <!-- Hero visual -->
        <div class="ff-landing__hero-art" aria-hidden="true">
          <div class="ff-pipeline">
            <div class="ff-pipeline__node ff-pipeline__node--active">
              <span class="ff-pipeline__icon">📋</span>
              <span class="ff-pipeline__label">SCOPE</span>
            </div>
            <span class="ff-pipeline__arrow">→</span>
            <div class="ff-pipeline__node ff-pipeline__node--active">
              <span class="ff-pipeline__icon">⚡</span>
              <span class="ff-pipeline__label">CLAIM</span>
            </div>
            <span class="ff-pipeline__arrow">→</span>
            <div class="ff-pipeline__node">
              <span class="ff-pipeline__icon">🔬</span>
              <span class="ff-pipeline__label">VERIFY</span>
            </div>
            <span class="ff-pipeline__arrow">→</span>
            <div class="ff-pipeline__node">
              <span class="ff-pipeline__icon">💸</span>
              <span class="ff-pipeline__label">PAY</span>
            </div>
          </div>
        </div>
      </section>

      <!-- ── Stats strip ────────────────────────────────────────────── -->
      <div class="ff-landing__stats-strip">
        <div class="ff-landing__stat">
          <span class="ff-landing__stat-num">10%</span>
          <span class="ff-landing__stat-label">Platform fee — lowest in class</span>
        </div>
        <div class="ff-landing__stat-divider" aria-hidden="true"></div>
        <div class="ff-landing__stat">
          <span class="ff-landing__stat-num">48h</span>
          <span class="ff-landing__stat-label">Auto-release if host doesn't review</span>
        </div>
        <div class="ff-landing__stat-divider" aria-hidden="true"></div>
        <div class="ff-landing__stat">
          <span id="stat-open-tasks" class="ff-landing__stat-num" aria-live="polite">—</span>
          <span class="ff-landing__stat-label">Open tasks right now</span>
        </div>
        <div class="ff-landing__stat-divider" aria-hidden="true"></div>
        <div class="ff-landing__stat">
          <span id="stat-paid-out" class="ff-landing__stat-num" aria-live="polite">—</span>
          <span class="ff-landing__stat-label">Paid out to contributors</span>
        </div>
      </div>

      <!-- ── How it works ───────────────────────────────────────────── -->
      <section class="ff-landing__how">
        <div class="ff-landing__section-inner">
          <div class="ff-landing__section-inner--center">
            <div class="ff-landing__eyebrow">HOW IT WORKS</div>
            <h2 class="ff-landing__section-title">From brief to paid in four steps.</h2>
            <p class="ff-landing__section-sub">No back-and-forth. No scope creep. No chasing invoices.</p>
          </div>

          <ol class="ff-landing__steps">
            <li class="ff-landing__step">
              <div class="ff-step__num">01</div>
              <h3 class="ff-step__title">Scope it in code</h3>
              <p class="ff-step__desc">
                You describe the work in plain language. The AI turns it into a rigid
                spec: JSON fields, file formats, polygon counts, sample rates — the exact
                rules for \"done\". Then you fund the project with a hotel-style hold.
              </p>
            </li>
            <li class="ff-landing__step">
              <div class="ff-step__num">02</div>
              <h3 class="ff-step__title">Lock the funds up front</h3>
              <p class="ff-step__desc">
                When a contributor claims a task, Stripe reserves the payout instantly.
                Contributors know the money is there before they start. Hosts know no
                one works for phantom promises.
              </p>
            </li>
            <li class="ff-landing__step">
              <div class="ff-step__num">03</div>
              <h3 class="ff-step__title">Deep-spec gate verifies delivery</h3>
              <p class="ff-step__desc">
                Submissions run through an AI verifier that checks file headers, resolution,
                duration, and content against the task spec before a human ever reviews it.
                Garbage in, bounced out automatically.
              </p>
            </li>
            <li class="ff-landing__step">
              <div class="ff-step__num">04</div>
              <h3 class="ff-step__title">Host approves → funds release</h3>
              <p class="ff-step__desc">
                Host has 48 hours to review. If they don't act, funds auto-release to the
                contributor. Every decision is immutably logged. No arguing about \"done\".
              </p>
            </li>
          </ol>
        </div>
      </section>

      <!-- ── Categories ─────────────────────────────────────────────── -->
      <section class="ff-landing__categories">
        <div class="ff-landing__section-inner">
          <div class="ff-landing__eyebrow" style="margin-bottom:16px">WHAT GETS BUILT</div>
          <h2 class="ff-landing__section-title" style="margin-bottom:32px">Every creative and technical deliverable.</h2>
          <div class="ff-landing__cat-grid">
            ${[
              { icon: "🎨", title: "Design Assets",     desc: "UI screens, brand kits, icon sets, illustrations" },
              { icon: "🎵", title: "Audio",             desc: "SFX, loops, voice-over, music stems" },
              { icon: "🎬", title: "Video",             desc: "Cutscenes, trailers, social clips, motion graphics" },
              { icon: "💻", title: "Code",              desc: "Features, bug fixes, scripts, integrations" },
              { icon: "✍️", title: "Copy & Docs",       desc: "UX copy, technical docs, changelogs" },
              { icon: "🗺️", title: "World-building",   desc: "Lore, maps, narrative systems, quest design" },
              { icon: "🧪", title: "QA & Testing",      desc: "Test plans, bug reports, regression suites" },
              { icon: "📊", title: "Data & Research",   desc: "Market research, data labeling, analytics" },
            ].map(c => `
              <div class="ff-cat-card">
                <div style="font-size:24px;margin-bottom:8px">${c.icon}</div>
                <div class="ff-cat-card__title">${c.title}</div>
                <div class="ff-cat-card__desc">${c.desc}</div>
              </div>
            `).join("")}
          </div>
        </div>
      </section>

      <!-- ── Bottom CTA ──────────────────────────────────────────────── -->
      <section class="ff-landing__bottom-cta">
        <div class="ff-landing__section-inner ff-landing__section-inner--center">
          <div class="ff-landing__eyebrow">READY TO START</div>
          <h2 class="ff-landing__cta-headline">Your next task is waiting.</h2>
          <p class="ff-landing__cta-sub">Browse open tasks without an account. Sign up only when you're ready to claim or post.</p>
          <div class="ff-landing__cta-row" style="justify-content:center">
            <a href="/login?mode=signup&role=host" class="ff-btn ff-btn--primary">Post a Project</a>
            <a href="/tasks" class="ff-btn ff-btn--ghost">Browse Open Tasks</a>
          </div>
        </div>
      </section>

      <!-- ── Footer ─────────────────────────────────────────────────── -->
      <footer class="ff-landing__footer">
        <span class="ff-landing__footer-brand">FatedFortress</span>
        <span class="ff-landing__footer-copy">© 2026 NeuralDraft LLC · Built for structured work.</span>
        <nav class="ff-landing__footer-nav">
          <a href="/tasks" class="ff-landing__footer-link">Tasks</a>
          <a href="/login" class="ff-landing__footer-link">Sign In</a>
        </nav>
      </footer>

    </div>
  `;

  // Scoped styles
  const style = document.createElement("style");
  style.textContent = `
    .ff-landing__cta-block {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 6px;
    }
    .ff-landing__cta-sub {
      font-family: var(--ff-font-mono);
      font-size: 11px;
      color: var(--ff-muted);
      max-width: 220px;
      line-height: 1.5;
    }
    .ff-landing__stat-num--loading {
      opacity: 0.4;
    }
  `;
  container.appendChild(style);

  // ── Live stat strip ──────────────────────────────────────────────────────
  // Animates a number from 0 → target over ~600ms
  function animateCount(
    el: HTMLElement,
    target: number,
    format: (n: number) => string,
  ): void {
    const duration = 600;
    const start    = performance.now();
    el.classList.remove("ff-landing__stat-num--loading");
    function tick(now: number) {
      const t = Math.min((now - start) / duration, 1);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = format(Math.round(eased * target));
      if (t < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function formatPaidOut(cents: number): string {
    const dollars = cents / 100;
    if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1)}M`;
    if (dollars >= 1_000)     return `$${Math.round(dollars / 1_000)}K`;
    return `$${Math.round(dollars)}`;
  }

  const $openTasks = container.querySelector<HTMLElement>("#stat-open-tasks");
  const $paidOut   = container.querySelector<HTMLElement>("#stat-paid-out");

  if ($openTasks) $openTasks.classList.add("ff-landing__stat-num--loading");
  if ($paidOut)   $paidOut.classList.add("ff-landing__stat-num--loading");

  // Fetch from get-public-stats edge fn (no auth required)
  const supabaseUrl = (window as unknown as Record<string,string>).__FF_SUPABASE_URL__
    ?? import.meta?.env?.VITE_SUPABASE_URL
    ?? "";

  if (supabaseUrl) {
    fetch(`${supabaseUrl}/functions/v1/get-public-stats`, {
      headers: { "Content-Type": "application/json" },
    })
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then((data: { open_task_count: number; total_paid_out_cents: number; contributor_count: number }) => {
        if ($openTasks) animateCount($openTasks, data.open_task_count, n => String(n));
        if ($paidOut)   animateCount($paidOut,   data.total_paid_out_cents, formatPaidOut);
      })
      .catch(() => {
        // Graceful fallback — show static values instead of —
        if ($openTasks) { $openTasks.classList.remove("ff-landing__stat-num--loading"); $openTasks.textContent = "0"; }
        if ($paidOut)   { $paidOut.classList.remove("ff-landing__stat-num--loading");   $paidOut.textContent   = "$0"; }
      });
  } else {
    if ($openTasks) { $openTasks.classList.remove("ff-landing__stat-num--loading"); $openTasks.textContent = "0"; }
    if ($paidOut)   { $paidOut.classList.remove("ff-landing__stat-num--loading");   $paidOut.textContent   = "$0"; }
  }

  return () => {};
}
