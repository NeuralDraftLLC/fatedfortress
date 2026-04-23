# FatedFortress

**A task marketplace for AI generation workflows — where contributors earn for precise delivery and hosts pay only when approved.**

Built with Supabase, Stripe Connect, and a browser-isolated keystore that ensures AI provider credentials never touch a FatedFortress server.

---

## What is this?

FatedFortress connects **hosts** who have AI generation tasks with **contributors** who deliver against a brief. Think of it as a professional services marketplace, but scoped to structured AI workflows: scoping, submission, review, and payment all happen on-platform.

**The core loop:**

```
Host creates project
    └→ AI scopes tasks + payouts (SCOPE)
    └→ Contributors browse and claim
    └→ Contributor submits deliverable
    └→ Host reviews: Approve / Reject / Request Revision
    └→ Payment captured via Stripe Connect — only on approval
```

**No payment held on claim. No payment captured on submit. Payment moves only when the host says "done."**

---

## Architecture

The system is split into three independent apps, three lockfiles, zero monorepo overhead:

| App | Role | Tech |
|-----|------|------|
| `apps/web` | User-facing SPA | Vanilla TypeScript, Vite |
| `apps/worker` | Browser-isolated AI keystore | Vite IIFE, Web Workers |
| `apps/relay` | Y.js signaling + WebRTC | Cloudflare Workers + Durable Objects |

**The keystore is the key architectural bet.** Your AI provider credentials run inside a sandboxed Web Worker at an isolated origin. The main thread never has access to them — not to the code, not to the keys. This is enforced by the browser's same-origin policy, not by a promise.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Database + Auth | Supabase (PostgreSQL + RLS + Edge Functions) |
| Payments | Stripe Connect (Express accounts, manual capture, 10% platform fee) |
| Real-time sync | Y.js CRDTs over WebRTC (Cloudflare Durable Objects relay) |
| AI credentials | Browser-isolated Web Worker, AES-256-GCM encrypted |
| Hosting | Cloudflare Pages (web) + Cloudflare Workers (relay) |
| Error tracking | Sentry (web + worker, PII-scrubbed) |
| Package manager | npm (per-app lockfiles) |

---

## Pages & Routes

| Route | Who | What |
|-------|-----|-------|
| `/login` | Everyone | Supabase Auth (magic link + Google OAuth) |
| `/create` | Host | Brief → SCOPE AI → review tasks → publish |
| `/tasks` | Contributor | Browse open tasks, claim with 24h soft-lock |
| `/submit/:taskId` | Contributor | Upload deliverable, submit for review |
| `/reviews` | Host | Review queue with real-time updates, decision modal |
| `/project/:id` | Host | Project detail, wallet balance, audit log |
| `/profile` | Everyone | Profile, reliability score, portfolio |
| `/settings` | Host | Stripe Connect onboarding, sign out |

---

## Data Model

Three sacred objects, one immutable decision trail:

```
Project
  └→ Task              (atomic unit of work, payout range in cents)
        └→ Submission  (contributor's deliverable, revision-tracked)
              └→ Decision (host's verdict — THE source of truth for payout)
```

**Escrow is tracked in `project_wallet`:**
- `deposited` — total the host has added
- `locked` — held against currently-claimed tasks
- `released` — paid out to contributors

Available = deposited − locked − released. **The platform never holds funds longer than the review window.**

---

## Developer Setup

```bash
# 1. Clone and install
git clone https://github.com/NeuralDraftLLC/fatedfortress
cd fatedfortress

# 2. Web app (minimum for local dev)
cd apps/web && npm install

# 3. Add apps/web/.env.local:
#    VITE_SUPABASE_URL=https://your-project.supabase.co
#    VITE_SUPABASE_ANON_KEY=your_anon_key
#    VITE_RELAY_ORIGIN=wss://your-relay.workers.dev
#    VITE_WORKER_ORIGIN=https://your-worker.pages.dev

npm run dev
# → http://localhost:5173

# 4. Optional: keystore worker (for AI generation flows)
cd apps/worker && npm install && npx vite --port 5174

# 5. Optional: relay (for Y.js / real-time collab)
cd apps/relay && npm install && npx wrangler dev
```

**First route:** [`/login`](http://localhost:5173/login) — the root `/` is not registered in the SPA router.

---

## Repo Structure

```
apps/
  web/               # Main SPA — pages, handlers, state
    public/           # Static assets (fonts, icons)
    src/
      auth/          # Supabase auth + route guards
      handlers/      # Business logic (scope, payout)
      net/           # Networking (signaling, storage, github)
      pages/         # Route mounts (login, create, tasks, reviews, ...)
      state/         # Client-side state
      styles/        # CSS (design system + fatedfortress)
      ui/            # Shell, shared UI primitives
      workers/       # Verification worker
  worker/            # Browser keystore + AI provider adapters
  relay/             # Cloudflare Worker + Durable Objects for Y.js signaling

packages/
  protocol/           # Shared TypeScript types, crypto helpers
  sentry-utils/       # PII scrubber for Sentry

supabase/
  functions/          # Edge Functions (Stripe, cron)
    auto-release/     # 24h warning / 48h auto-approve
    expire-claims/     # Reclaim soft-locked tasks
    stripe-payment/   # PaymentIntent create/capture/cancel
    stripe-connect-*/ # Stripe Connect onboarding
  migrations/         # PostgreSQL migrations
  schema.sql          # Full schema with RLS policies
```

---

## Key Design Decisions

### No funds held on claim
When a contributor claims a task, nothing moves. The host pre-funds their project wallet. Money is only captured when the host explicitly approves.

### Platform fee as Stripe `application_fee_amount`
On approval, the 10% platform fee is set as `application_fee_amount` during PaymentIntent capture. Stripe routes the net to the host's Connect account and the fee to the platform automatically. No separate transfer API call.

### Decision is the audit trail
Every host action (approve, reject, request-revision) inserts a `decisions` row. `tasks.approved_payout` is a denormalized cache. `decisions.approved_payout` is the Stripe source of truth. The full history is queryable independently of Stripe events.

### 48h auto-release
If a host doesn't review within 48 hours, the system auto-approves with `decision_reason: 'approved_fast_track'`, captures the payment, and notifies both parties. A 24h warning fires first.

---

## Status

**MVP phase — core payout loop is built and wired.**

| Feature | Status |
|---------|--------|
| Supabase schema + RLS | ✅ |
| Stripe Connect onboarding | ✅ |
| Claim + 24h soft-lock | ✅ |
| Submit + revision tracking | ✅ |
| Review queue + decisions | ✅ |
| Payment capture + transfer | ✅ |
| Auto-release at 48h | ✅ |
| Cron jobs (expire-claims, auto-release) | ✅ |
| AI task scoping (SCOPE) | 🔴 Edge function needed |
| File upload to R2/CDN | 🔴 Edge function needed |
| Automated submission verification | 🟡 Fails open (submissions work) |
| Y.js collaborative review UI | 🟡 UI scaffolded, stub |
| GitHub OAuth integration | 🟡 Stub |
| here.now permanent publishing | 🟡 Stub |

---

## Contributing

1. Read `ARCHITECTURE.md` for the component and design token reference.
2. Read `packages/protocol/src/index.ts` — all shared types live there.
3. `apps/web/src/main.ts` documents the route registry; `ARCHITECTURE.md` section 1 has the full repo map.
4. New types for MVP features go in `packages/protocol/src/index.ts` — do not mix with legacy room types.
5. CSP entries are required for any new network endpoints — see `apps/web/index.html`.

---

## License

MIT
