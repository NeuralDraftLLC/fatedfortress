# FatedFortress — Environment Variables Reference

## Supabase Edge Function Secrets

Set via: `supabase secrets set KEY=value`

| Secret | Used By | Notes |
|--------|---------|-------|
| `STRIPE_SECRET_KEY` | stripe-payment, stripe-connect-onboard, stripe-connect-link | `sk_live_...` or `sk_test_...` |
| `OPENAI_API_KEY` | scope-tasks | `sk-...` — GPT-4o for task generation |
| `GITHUB_TOKEN` | verify-submission | GitHub PAT for PR existence checks (`read:repo` scope) |
| `GITHUB_CLIENT_ID` | github-oauth | From GitHub OAuth App settings |
| `GITHUB_CLIENT_SECRET` | github-oauth | From GitHub OAuth App settings |
| `CRON_SECRET` | auto-release, expire-claims, stripe-payment | Shared secret for internal cron invocations |
| `VIRUSTOTAL_API_KEY` | asset-sanitizer | Free tier: 10-15 req/min. Sign up at virustotal.com. Used for malware + stego scan. |
| `SENTRY_DSN` | _shared/scope.ts, asset-sanitizer | Sentry ingest DSN for token-usage + error logging from edge functions. Optional in dev. |
| `RAILWAY_GLBTURNTABLE_URL` | asset-sanitizer | Railway worker URL for GLB→MP4 turntable rendering. Format: `https://glb-turntable.up.railway.app` |
| `RAILWAY_REENCODE_URL` | asset-sanitizer | Railway worker URL for PNG/WAV re-encoding. Format: `https://reencode.up.railway.app` |

## apps/web/.env.local

Copy `apps/web/.env.example` to `apps/web/.env.local` and fill in values.

Set before `vite build` or `vite dev`

| Variable | Used By | Notes |
|----------|---------|-------|
| `VITE_SUPABASE_URL` | supabase client | Your project URL |
| `VITE_SUPABASE_ANON_KEY` | supabase client | Public anon key |
| `VITE_GITHUB_CLIENT_ID` | net/github.ts OAuth flow | From GitHub OAuth App settings |
| `VITE_SUPABASE_STORAGE_URL` | net/storage.ts | Supabase Storage URL (e.g. `https://xxx.supabase.co/storage/v1`) |

---

## Supabase Storage Setup

1. Go to **Supabase Dashboard → Storage**
2. Create a new bucket named `fortress`
3. Set bucket to **Public**
4. Add RLS policies for authenticated upload and public read

---

## GitHub OAuth App Setup

1. GitHub → Settings → Developer settings → OAuth Apps → **New OAuth App**
2. Homepage URL: `https://fatedfortress.com`
3. Callback URL: `https://fatedfortress.com/github/callback`
4. Copy Client ID → `VITE_GITHUB_CLIENT_ID` (in `.env.local`) **and** `GITHUB_CLIENT_ID` (in Supabase secrets)
5. Generate Client Secret → `GITHUB_CLIENT_SECRET` (in Supabase secrets only — never in VITE_ vars)

---

## Deploy All Functions

Run in order — secrets first, then deploy each function:

```bash
# ── 1. Set all secrets ───────────────────────────────────────────────
supabase secrets set STRIPE_SECRET_KEY=sk_live_...
supabase secrets set OPENAI_API_KEY=sk-...
supabase secrets set GITHUB_TOKEN=ghp_...
supabase secrets set GITHUB_CLIENT_ID=...
supabase secrets set GITHUB_CLIENT_SECRET=...
supabase secrets set CRON_SECRET=your-random-secret-here
supabase secrets set VIRUSTOTAL_API_KEY=...
supabase secrets set SENTRY_DSN=https://...@o447370.ingest.sentry.io/...
supabase secrets set RAILWAY_GLBTURNTABLE_URL=https://glb-turntable.up.railway.app
supabase secrets set RAILWAY_REENCODE_URL=https://reencode.up.railway.app

# ── 2. Deploy Supabase Edge Functions ─────────────────────────────────
supabase functions deploy create-and-scope-project
supabase functions deploy asset-sanitizer
supabase functions deploy scope-tasks          # tombstone (410 Gone) — kept so old deploys don't error
supabase functions deploy supabase-storage-upload
supabase functions deploy github-oauth
supabase functions deploy verify-submission
supabase functions deploy auto-release
supabase functions deploy expire-claims
supabase functions deploy stripe-payment
supabase functions deploy stripe-connect-onboard
supabase functions deploy stripe-connect-link

# ── 3. Deploy Railway workers ─────────────────────────────────────────
cd railway/glb-turntable && railway up --product=worker
cd railway/reencode && railway up --product=worker
```

**Test order:** SCOPE end-to-end before file upload. A broken scope means no tasks, and no tasks means nothing to upload.