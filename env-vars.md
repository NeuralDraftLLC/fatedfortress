# FatedFortress — Environment Variables Reference

## Supabase Edge Function Secrets

Set via: `supabase secrets set KEY=value`

| Secret | Used By | Notes |
|--------|---------|-------|
| `STRIPE_SECRET_KEY` | stripe-payment, stripe-connect-onboard, stripe-connect-link | `sk_live_...` or `sk_test_...` |
| `OPENAI_API_KEY` | scope-tasks | `sk-...` — GPT-4o for task generation |
| `CLOUDFLARE_R2_ACCOUNT_ID` | r2-upload-url | Found in Cloudflare dashboard → R2 |
| `R2_BUCKET_NAME` | r2-upload-url | e.g. `fortress-deliverables` |
| `R2_ACCESS_KEY_ID` | r2-upload-url | R2 API token Access Key ID |
| `R2_SECRET_ACCESS_KEY` | r2-upload-url | R2 API token Secret Access Key |
| `R2_PUBLIC_BASE_URL` | r2-upload-url | e.g. `https://pub-xxxxxxxx.r2.dev` (enable public access on bucket) |
| `GITHUB_TOKEN` | verify-submission | GitHub PAT for PR existence checks (`read:repo` scope) |
| `GITHUB_CLIENT_ID` | github-oauth | From GitHub OAuth App settings |
| `GITHUB_CLIENT_SECRET` | github-oauth | From GitHub OAuth App settings |
| `CRON_SECRET` | auto-release, expire-claims, stripe-payment | Shared secret for internal cron invocations |

## apps/web/.env.local

Set before `vite build` or `vite dev`

| Variable | Used By | Notes |
|----------|---------|-------|
| `VITE_SUPABASE_URL` | supabase client | Your project URL |
| `VITE_SUPABASE_ANON_KEY` | supabase client | Public anon key |
| `VITE_GITHUB_CLIENT_ID` | net/github.ts OAuth flow | From GitHub OAuth App settings |
| `VITE_R2_PUBLIC_URL` | net/storage.ts | Same as `R2_PUBLIC_BASE_URL` above |

---

## R2 Setup Checklist

1. Go to **Cloudflare Dashboard → R2**
2. Create bucket: `fortress-deliverables`
3. Under bucket settings → enable **"Public access"** (for serving assets via public URL)
4. Go to R2 → **Manage R2 API Tokens → Create Token**
   - Permissions: Object Read & Write
   - Specify bucket: `fortress-deliverables`
5. Copy Access Key ID → `R2_ACCESS_KEY_ID`
6. Copy Secret Access Key → `R2_SECRET_ACCESS_KEY`
7. Copy Account ID from dashboard URL → `CLOUDFLARE_R2_ACCOUNT_ID`
8. Copy public bucket URL → `R2_PUBLIC_BASE_URL`

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
supabase secrets set CLOUDFLARE_R2_ACCOUNT_ID=...
supabase secrets set R2_BUCKET_NAME=fortress-deliverables
supabase secrets set R2_ACCESS_KEY_ID=...
supabase secrets set R2_SECRET_ACCESS_KEY=...
supabase secrets set R2_PUBLIC_BASE_URL=https://pub-xxx.r2.dev
supabase secrets set GITHUB_TOKEN=ghp_...
supabase secrets set GITHUB_CLIENT_ID=...
supabase secrets set GITHUB_CLIENT_SECRET=...
supabase secrets set CRON_SECRET=your-random-secret-here

# ── 2. Deploy in dependency order ────────────────────────────────────
# scope-tasks first (no deps), then r2-upload-url, then everything else
supabase functions deploy scope-tasks
supabase functions deploy r2-upload-url
supabase functions deploy github-oauth
supabase functions deploy verify-submission
supabase functions deploy auto-release
supabase functions deploy expire-claims
supabase functions deploy stripe-payment
supabase functions deploy stripe-connect-onboard
supabase functions deploy stripe-connect-link
```

**Test order:** SCOPE end-to-end before file upload. A broken scope means no tasks, and no tasks means nothing to upload to.
