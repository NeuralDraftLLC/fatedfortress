/**
 * apps/web/src/pages/landing.ts
 * Public landing page — no auth required.
 * Renders before the shell; wired to / in main.ts.
 */

export async function mountLanding(container: HTMLElement): Promise<() => void> {
  container.innerHTML = `
    <div class="ff-landing">

      <!-- ── Hero ─────────────────────────────────────────────── -->
      <section class="ff-landing__hero">
        <div class="ff-landing__hero-inner">
          <div class="ff-landing__eyebrow">Task Marketplace</div>
          <h1 class="ff-landing__headline">
            Post any job.<br>
            AI scopes it.<br>
            Specialists deliver.
          </h1>
          <p class="ff-landing__subhead">
            Describe what you need in plain language — design, code, copy, video, anything.
            FatedFortress breaks it into precise, verifiable tasks. Real specialists claim them,
            submit verified work, and get paid automatically. No back-and-forth, no ambiguity.
          </p>
          <div class="ff-landing__cta-row">
            <a href="/login?intent=post" class="ff-btn ff-btn--primary ff-btn--lg">
              Post a Job
            </a>
            <a href="/login?intent=work" class="ff-btn ff-btn--ghost ff-btn--lg">
              Find Work
            </a>
          </div>
        </div>
        <div class="ff-landing__hero-art" aria-hidden="true">
          <div class="ff-pipeline">
            <div class="ff-pipeline__node ff-pipeline__node--active">
              <span class="ff-pipeline__icon">✦</span>
              <span class="ff-pipeline__label">Brief</span>
            </div>
            <div class="ff-pipeline__arrow">→</div>
            <div class="ff-pipeline__node ff-pipeline__node--active">
              <span class="ff-pipeline__icon">⬡</span>
              <span class="ff-pipeline__label">AI Scope</span>
            </div>
            <div class="ff-pipeline__arrow">→</div>
            <div class="ff-pipeline__node">
              <span class="ff-pipeline__icon">◈</span>
              <span class="ff-pipeline__label">Claim</span>
            </div>
            <div class="ff-pipeline__arrow">→</div>
            <div class="ff-pipeline__node">
              <span class="ff-pipeline__icon">◉</span>
              <span class="ff-pipeline__label">Verify</span>
            </div>
            <div class="ff-pipeline__arrow">→</div>
            <div class="ff-pipeline__node">
              <span class="ff-pipeline__icon">✓</span>
              <span class="ff-pipeline__label">Payout</span>
            </div>
          </div>
        </div>
      </section>

      <!-- ── How it works ──────────────────────────────────────── -->
      <section class="ff-landing__how">
        <div class="ff-landing__section-inner">
          <h2 class="ff-landing__section-title">How it works</h2>
          <p class="ff-landing__section-sub">Four steps. No ambiguity. No chasing people down.</p>
          <ol class="ff-landing__steps">
            <li class="ff-landing__step">
              <div class="ff-step__num">01</div>
              <div class="ff-step__body">
                <h3 class="ff-step__title">Post your job</h3>
                <p class="ff-step__desc">
                  Describe what you need in plain language. The AI breaks it into discrete,
                  scoped tasks — each with clear deliverable specs and acceptance criteria.
                </p>
              </div>
            </li>
            <li class="ff-landing__step">
              <div class="ff-step__num">02</div>
              <div class="ff-step__body">
                <h3 class="ff-step__title">Specialists claim tasks</h3>
                <p class="ff-step__desc">
                  Verified contributors browse the marketplace and claim tasks that match
                  their skills. Stripe locks the payout at claim time — no payment surprises.
                </p>
              </div>
            </li>
            <li class="ff-landing__step">
              <div class="ff-step__num">03</div>
              <div class="ff-step__body">
                <h3 class="ff-step__title">Deliver and verify</h3>
                <p class="ff-step__desc">
                  Contributors submit work. Automated checks run on every deliverable before
                  it reaches your review queue.
                </p>
              </div>
            </li>
            <li class="ff-landing__step">
              <div class="ff-step__num">04</div>
              <div class="ff-step__body">
                <h3 class="ff-step__title">Approve and close</h3>
                <p class="ff-step__desc">
                  Review, approve, and payout releases instantly. Reject with feedback and
                  the task reopens for revision or reclaim.
                </p>
              </div>
            </li>
          </ol>
        </div>
      </section>

      <!-- ── What ships here ───────────────────────────────────── -->
      <section class="ff-landing__categories">
        <div class="ff-landing__section-inner">
          <h2 class="ff-landing__section-title">Anything you need built</h2>
          <div class="ff-landing__cat-grid">
            ${[
              ["UI & UX Design", "Screens, flows, component libraries"],
              ["Branding", "Logos, identity systems, style guides"],
              ["Frontend Code", "React, Vue, Svelte, vanilla"],
              ["Backend & APIs", "Node, Python, Go, edge functions"],
              ["Marketing Assets", "Ad creative, landing pages, email templates"],
              ["Video & Motion", "Explainers, animations, reels"],
              ["3D & VFX", "Models, renders, product visualizations"],
              ["Writing & Copy", "Product copy, docs, technical writing"],
            ].map(([title, desc]) => `
              <div class="ff-cat-card">
                <div class="ff-cat-card__title">${title}</div>
                <div class="ff-cat-card__desc">${desc}</div>
              </div>
            `).join("")}
          </div>
        </div>
      </section>

      <!-- ── Builder CTA ────────────────────────────────────────── -->
      <section class="ff-landing__bottom-cta">
        <div class="ff-landing__section-inner ff-landing__section-inner--center">
          <h2 class="ff-landing__cta-headline">
            Ship your next thing faster.
          </h2>
          <p class="ff-landing__cta-sub">
            The entire loop — scoping, claiming, verification, review, payout — is live.
            Post your first job in under two minutes.
          </p>
          <a href="/login?intent=post" class="ff-btn ff-btn--primary ff-btn--lg">
            Get started
          </a>
        </div>
      </section>

      <!-- ── Footer ─────────────────────────────────────────────── -->
      <footer class="ff-landing__footer">
        <span class="ff-landing__footer-brand">FatedFortress</span>
        <span class="ff-landing__footer-copy">Built for people who ship.</span>
      </footer>

    </div>
  `;

  // Intercept CTA clicks to pass intent param through to login
  const handleClick = (e: Event) => {
    const target = (e.target as Element)?.closest("a");
    if (!target) return;
    const href = target.getAttribute("href");
    if (href?.startsWith("/login")) {
      e.preventDefault();
      window.history.pushState({}, "", href);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  };
  container.addEventListener("click", handleClick);

  return () => {
    container.removeEventListener("click", handleClick);
  };
}
