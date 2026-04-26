# Fated Fortress

**AI-orchestrated task marketplace for scoped digital work — 3D assets, audio, code, design.**

Hosts post a project brief. An AI engine decomposes it into precise tasks with machine-readable specs and payouts. Contributors claim knowing exactly what to deliver. A deep-spec gate validates submissions automatically before human review. Payment is pre-authorized at claim time and captured only on approval.

---

## How it works

```
Host posts a project brief
  └─ AI (GPT-4o) decomposes into tasks
       Each task: payout range · deliverable type · spec_constraints
         └─ Contributor browses → claims a task
              Stripe PaymentIntent created at claim time (manual capture)
                └─ Contributor submits the asset
                     verify-submission parses binary headers
                          ├─ Spec mismatch → auto-rejected, contributor notified
                          └─ Passes → enters host review queue
                               └─ Host approves → Stripe captures → payout released
                                  Host ignores 48h → auto-approved, contributor paid
```

---

## Architecture

```
Browser (apps/web)
  Single-page app — Vite · TypeScript · Supabase client
  Y.js CRDT over WebRTC (y-webrtc) + CodeMirror 6 for collaborative review
          │ Supabase Realtime / REST
          ▼
Supabase
  PostgreSQL + RLS · Edge Functions (Deno) · Storage
  Cron jobs (pg_cron) · Realtime postgres_changes
          │ Webhook / RPC
          ▼
Stripe Connect Express
  PaymentIntent (manual capture) at claim · 10% platform fee
  Auto-capture on approval
          │
          ├─────────────────────────────────────────────────────────────┐
          │                                                              │
          ▼                                                              ▼
apps/relay                                          Railway (railway/)
Cloudflare Workers + Durable Objects                GLB turntable renderer · PNG/WAV re-encoder
Y.js WebRTC signaling · TURN credentials            Offloads heavy encoding from Deno isolates
RelayDO alarm heartbeat (5-min sliding window)
```

---

## Repository layout

```
fatedfortress/
├── apps/
│   ├── web/                     # SPA — Vite + TypeScript
│   │   └── src/
│   │       ├── auth/           # Supabase client, route guards
│   │       ├── handlers/       # Scope, review, payout logic
│   │       ├── net/            # Storage, GitHub, notifications
│   │       ├── pages/          # Route entrypoints
│   │       ├── state/          # Y.js CRDT, identity, yroom-manager
│   │       └── ui/             # Shell, shared components
│   └── relay/                  # Cloudflare Workers + Durable Objects
│                                #   Y.js signaling, TURN credentials
├── packages/
│   ├── protocol/               # Shared TypeScript types
│   └── sentry-utils/          # PII scrubber
├── railway/
│   └── glb-turntable/         # Railway worker: GLB → MP4 turntable
├── supabase/
│   ├── functions/             # 18 Edge Functions
│   ├── migrations/            # Apply in order
│   └── schema.sql            # Reference schema + RLS policies
├── e2e/                       # Playwright end-to-end tests
├── diagrams/                  # Architecture Mermaid diagrams
├── scripts/                   # Dev utilities
└── env-vars.md               # Full environment variable reference
```

---

## Pages

| Route | Audience | Description |
|-------|---------|-------------|
| `/login` | Public | Magic link + Google OAuth |
| `/create` | Host | Brief → AI scope → edit tasks → fund + publish |
| `/tasks` | Contributor | Browse open tasks, claim with pre-authorized payment |
| `/submit/:taskId` | Contributor | Upload asset → verify-submission gate → submit |
| `/reviews` | Host | Live collaborative review queue (Y.js + CodeMirror) |
| `/project/:id` | Host | Wallet, activity feed, task list |
| `/profile` | Any | Reliability score, skills, Stripe Connect status |
| `/settings` | Any | Stripe Connect onboarding, GitHub connect |

---

## Edge Functions

| Function | Trigger | Description |
|----------|---------|-------------|
| `create-and-scope-project` | POST | GPT-4o task decomposition + project creation |
| `scope-tasks` | — | **Deprecated** (410 Gone). Use `create-and-scope-project` instead. |
| `claim-task` | POST | Validates claim, creates Stripe PaymentIntent, calls `claim_task_atomic` RPC |
| `submit-task` | POST | Persists submission, triggers `verify-submission` |
| `verify-submission` | Called by `submit-task` | Binary header parsing against `spec_constraints`; auto-rejects mismatches |
| `review-submission` | POST | Host verdict (approve / reject / revision) + Stripe capture or cancel |
| `stripe-webhook` | Stripe events | Handles `payment_intent.succeeded`, `transfer.created`, `account.updated` |
| `stripe-payment` | POST | Capture / cancel / refund / transfer |
| `stripe-connect-onboard` | POST | Stripe Connect Express onboarding |
| `stripe-connect-link` | POST | Dashboard link + reauth URL |
| `github-oauth` | GET | Server-side GitHub token exchange |
| `get-stripe-status` | GET | Read `charges_enabled` / `payouts_enabled` for a Stripe account |
| `get-public-stats` | GET | Public project and task counts for the landing page |
| `supabase-storage-upload` | POST | Generates presigned PUT URLs for Supabase Storage |
| `asset-scanner` | POST | 9-sub-pass layered analysis: magic-byte, heuristic inference, gap bounty |
| `asset-sanitizer` | POST | VirusTotal malware scan + Railway re-encode (PNG, WAV, GLB turntable) |
| `auto-release` | Cron (30 min) | 24h warning → 48h auto-approve + Stripe capture |
| `expire-claims` | Cron (5 min) | Reclaims expired soft-locks via `unlock_wallet` RPC |

---

## Database schema

```
projects
  └─ tasks
       payout_range · deliverable_type · status · version
       spec_constraints (JSONB) · payment_intent_id · accepted_roles[]
         └─ submissions
              deliverable_url · revision_count · proxy_video_url
                └─ decisions
                     verdict (approve / reject / revision_requested)
```

**Project Wallet** — `deposited / locked / released`. Every mutation goes through atomic Postgres RPCs with `SELECT FOR UPDATE SKIP LOCKED`. No client-side arithmetic, no race conditions.

### spec_constraints examples

| Deliverable | Example shape |
|-------------|--------------|
| `3d_model` | `{ max_polygons: 100000, requires_rig: true, lod_levels: 2 }` |
| `audio` | `{ sample_rate: 44100, channels: 2, bit_depth: 16 }` |
| `design_asset` | `{ max_width: 2048, max_height: 2048, min_width: 256 }` |

---

## Migrations

Apply in order with `supabase db push` or `supabase migrations apply`. The 8 empty `20260501_*` files are stubs superseded by earlier migrations and can be safely deleted.

```
20250421_post_refactor_v1.sql     projects, tasks, submissions, profiles, audit_log
20260422_persist_blueprint.sql    readme_draft, folder_structure; persist_scoped_project RPC
20260424_009–028                  Schema additions and hardening
20260425_028_profiles_fk_join_fix.sql  Fixes profiles FK join
```

---

## Getting started

### Prerequisites

- Node.js 18+
- A Supabase project (apply migrations in order)
- Stripe account with Connect enabled
- Cloudflare account (for relay deployment)
- Railway account (for GLB turntable worker; optional in development)

### Local development

```bash
git clone https://github.com/NeuralDraftLLC/fatedfortress.git
cd fatedfortress

# Supabase
supabase init
supabase link --project-ref YOUR_PROJECT_REF
supabase db push

# Web app
cd apps/web && npm install && cp .env.example .env.local
# Fill VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.local
npm run dev

# Relay (Cloudflare Workers)
cd apps/relay && npm install && npx wrangler dev

# Railway GLB turntable (optional)
cd railway/glb-turntable && npm install
# Deploy with: railway up --product=worker
```

See [`env-vars.md`](env-vars.md) for the full list of required environment variables and secrets.

### Running tests

```bash
npm install
npx playwright install chromium
cp e2e/.env.example e2e/.env
# Fill e2e/.env with your dev credentials
npm run test:e2e
```

---

## Contributing

**Adding a route** — Register it in `apps/web/src/main.ts` and create the page module under `apps/web/src/pages/`.

**Adding shared types** — Edit `packages/protocol/src/index.ts`.

**New Edge Functions** — Add under `supabase/functions/`. Use `_shared/auth.ts` for auth. Set secrets via `supabase secrets set KEY=value`.

**New migrations** — Prefix with a date (`YYYYMMDD_`). Test with `supabase db push` before committing.

**New deliverable types** — Add the spec shape to `asset-scanner/index.ts` and the binary checker to `verify-submission/index.ts`.

---

## License

MIT — see [LICENSE](LICENSE).
