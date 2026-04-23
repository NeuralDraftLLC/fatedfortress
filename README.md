# FatedFortress

**A task marketplace for AI generation workflows — contributors deliver against a brief; hosts pay only when they approve.**

Supabase and Stripe Connect handle data and money. Optional paths use a **browser-isolated keystore** (separate origin + Web Worker) so AI provider credentials never pass through an app server you control.

---

## What is this?

FatedFortress connects **hosts** who post AI-scoped work with **contributors** who complete tasks. Scoping, submission, review, and payment stay on-platform and map to a clear state machine: **Task → Submission → Decision** (the payout source of truth).

**Core loop:**

```
Host creates project
    └→ AI scopes tasks + payouts (SCOPE)
    └→ Contributors browse and claim
    └→ Contributor submits deliverable
    └→ Host reviews: Approve / Reject / Request revision
    └→ Payment captured via Stripe Connect — only on approval
```

**No capture on claim. No capture on submit. Funds move when the host approves** (or after the auto-release window if configured).

---

## Architecture

Three deployable apps, **separate `package.json` / lockfiles** (no monorepo tooling required):

| App | Role | Tech |
|-----|------|------|
| `apps/web` | User-facing SPA | TypeScript, Vite |
| `apps/worker` | Browser AI keystore + provider adapters | Vite IIFE, Web Workers |
| `apps/relay` | Y.js signaling + WebRTC (TURN metadata) | Cloudflare Workers, Durable Objects |

**Keystore (optional for pure browse/claim/review flows):** API keys run in a sandboxed worker at an **isolated origin**. The main app’s thread does not read those secrets; the browser’s same-origin policy is the enforcement boundary.

---

## Tech stack

| Layer | Technology |
|-------|------------|
| Database + auth | Supabase (Postgres, RLS, Edge Functions) |
| Payments | Stripe Connect (Express, **manual** capture, 10% platform fee) |
| Real-time / CRDT | Y.js over WebRTC; relay on Cloudflare |
| AI scoping | OpenAI (edge: `scope-tasks`) |
| Object storage | Cloudflare R2 (presigned uploads via `r2-upload-url`) |
| Hosting | e.g. Cloudflare Pages (web) + Workers (relay) |
| Errors | Sentry (web + worker; PII scrubbed via `packages/sentry-utils`) |
| Package manager | npm (per app) |

---

## Pages and routes

| Route | Who | What |
|-------|-----|------|
| `/login` | Public | Magic link + Google OAuth (Supabase) |
| `/create` | Host | Brief → SCOPE → edit tasks → publish |
| `/tasks` | Contributor | Open tasks, claim, 24h soft-lock |
| `/submit/:taskId` | Contributor | Upload (R2), verify, submit for review |
| `/reviews` | Host | Review queue, decisions |
| `/project/:id` | Host | Project detail, wallet, activity |
| `/profile` | Signed-in | Profile, reliability, portfolio |
| `/settings` | Signed-in | GitHub connect, **Stripe Connect (hosts)**, sign out |
| `/github/callback` | Signed-in | GitHub OAuth return URL |

The SPA router in `apps/web/src/main.ts` does not register `/`; use `/login` or a feature route as the entry you bookmark for local dev.

---

## Data model

Three core aggregates and an immutable decision trail:

```
Project
  └→ Task              (payout range in cents, status, claim, etc.)
        └→ Submission  (deliverable, revision)
              └→ Decision  (host verdict — authoritative for payout)
```

**`project_wallet`** (per project): `deposited`, `locked`, `released`.  
**Available (conceptually)** ≈ deposited − locked − released. The host pre-funds; capture happens on approval, not on claim.

---

## Developer setup

```bash
git clone https://github.com/NeuralDraftLLC/fatedfortress.git
cd fatedfortress

# Web app (minimum to run the UI against your Supabase project)
cd apps/web
npm install
cp .env.example .env.local
# Edit .env.local: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY (required)
# Optional: VITE_GITHUB_CLIENT_ID, VITE_R2_PUBLIC_URL — see /env-vars.md

npm run dev
# → http://localhost:5173
```

**Full env reference:** [`env-vars.md`](env-vars.md) (Supabase secrets for Edge Functions, R2, Stripe, GitHub, cron).

**Optional local services**

```bash
# Keystore + AI adapters (isolated origin in production; local port for dev)
cd apps/worker && npm install && npx vite --port 5174

# Y.js relay
cd apps/relay && npm install && npx wrangler dev
```

Vite injects relay/worker/Sentry **defaults** in `vite.config.ts` via `VITE_RELAY_*`, `VITE_WORKER_ORIGIN`, `VITE_FF_ORIGIN`, etc. Override when your deploy URLs differ from the defaults in the config.

---

## Repository layout

```
apps/
  web/                 # Main SPA
    public/            # Static assets
    src/
      auth/            # Supabase client, route guards
      handlers/        # scope, payout, etc.
      net/             # storage (R2), GitHub, signaling, notifications
      pages/           # Route entrypoints
      state/           # Yjs / session state
      styles/          # Design system + app CSS
      ui/              # Shell, shared UI
  worker/              # Keystore bundle (iframe target)
  relay/                 # WebRTC / signaling worker

packages/
  protocol/              # Shared types and protocol
  sentry-utils/          # Sentry scrubber

supabase/
  functions/
    _shared/             # Shared Edge helpers (e.g. auth)
    auto-release/        # Cron: warnings + 48h auto-approve path
    expire-claims/       # Cron: release expired task locks
    scope-tasks/         # OpenAI: scope brief → tasks JSON
    r2-upload-url/       # Presigned PUT to R2
    verify-submission/   # Deliverable checks (incl. GitHub PR when applicable)
    github-oauth/        # Server-side GitHub token exchange
    stripe-payment/      # PaymentIntents: create, capture, cancel, refund, transfer
    stripe-connect-*/    # Connect account + account links
  migrations/
  schema.sql             # Reference schema + RLS (see migrations for history)
```

**Edge Functions and auth:** User-facing invokes send the **Supabase session JWT** in `Authorization`. Shared code resolves that JWT (or a **service role** bearer for server-to-server calls like cron-driven flows). See `supabase/functions/_shared/auth.ts` and each function’s handler.

---

## Design notes

### No capture on claim

Claiming reserves workflow, not a card charge. The host’s project wallet must be funded; **capture** runs on host approval (or the automated release path).

### Platform fee (10%)

Handled as Stripe **`application_fee_amount`** on capture where the Connect model applies, so the fee and net payout are explicit in Stripe.

### `decisions` as audit trail

Approve / reject / request revision all write a **`decisions`** row. Task-level payout caches can mirror that; the decision record plus Stripe IDs are the cross-checks.

### Auto-release

If a submission sits in review, a **24h** warning can fire, then a **48h** path may auto-approve (`approved_fast_track`), capture, and notify. See `auto-release` and cron/`CRON_SECRET` in `env-vars.md`.

---

## Status (high level)

| Area | Notes |
|------|--------|
| Supabase schema + RLS | In place; review `migrations/` for your project |
| Stripe Connect + PaymentIntents | Wired via Edge Functions + web handlers |
| Claim, submit, review, pay | Core loop implemented in `apps/web` + functions |
| SCOPE (`scope-tasks`) | **Edge function**; requires `OPENAI_API_KEY` secret |
| R2 uploads (`r2-upload-url`) | **Edge function**; R2 + `VITE_R2_PUBLIC_URL` for clients |
| Submission verification | `verify-submission` (configurable; some paths “fail open” by design) |
| Y.js live review UI | Partial / scaffold; relay exists for real-time |
| GitHub / here.now | Varies by route; see code and `env-vars.md` |

For a visual of services and migrations, see [`diagrams/mermaid.md`](diagrams/mermaid.md) (replace placeholders with your own project refs if you copy diagrams).

---

## Contributing

1. **Architecture and UI** — `ARCHITECTURE.md` and `apps/web/src/main.ts` (route table).
2. **Shared types** — `packages/protocol/src/index.ts`.
3. **CSP / new endpoints** — `apps/web/index.html` connect-src and related directives when adding APIs or origins.
4. **Supabase** — keep RLS in mind for any new tables; document new secrets in `env-vars.md`.

---

## License

MIT
