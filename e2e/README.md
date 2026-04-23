# End-to-end (Playwright)

## What runs

`e2e/fullstack-happy-path.spec.ts` drives the real app (production build + `vite preview`):

1. **Host** — `/create` → FORGE (OpenAI `scope-tasks` Edge Function) → publish.
2. **Service role** — set tasks to `task_access = public` (default from SCOPE is `invite`, so contributors would not see the task).
3. **Contributor** — claim on `/tasks`, upload a file on `/submit/:id` (R2 presigned URL).
4. **Assertions** — `HEAD` the public `asset_url` (object exists in R2).
5. **Service role** — call `stripe-payment` `action: create` to attach a **manual-capture** PaymentIntent to the submission (the browser submit path does not do this today).
6. **Host** — `/reviews` → **Approve & Pay** (captures via `stripe-payment`).
7. **Stripe API** — `paymentIntents.retrieve` — expect `status === succeeded` (test mode).

## Prereqs

- **Supabase:** Email auth with **password** enabled; `E2E_HOST_*` and `E2E_CONTRIBUTOR_*` in `e2e/.env`.
- **Edge Functions deployed** (or local) for `scope-tasks`, `r2-upload-url`, `verify-submission` (optional; app may fail open), `stripe-payment`.
- **Secrets** in Supabase: `OPENAI_API_KEY`, R2 keys, `STRIPE_SECRET_KEY`, etc. (see root `env-vars.md`).
- **Browser:** `npx playwright install chromium`
- **Host Connect account:** set `E2E_HOST_STRIPE_CONNECT_ACCOUNT=acct_...` (test mode) for the full Connect + capture path. Optional for a minimal PI without `transfer_data`.

## Local run

```bash
cp e2e/.env.example e2e/.env
# fill e2e/.env

# from repo root
npm install
npx playwright install chromium
npm run test:e2e
```

`playwright.config.ts` loads `e2e/.env` and sets `VITE_E2E_PASSWORD_LOGIN=true` for the web build so `/login` shows the password form.

## Manual Stripe Dashboard

After a run, open [Stripe test mode PaymentIntents](https://dashboard.stripe.com/test/payments) and find the PI id printed in logs or on the `submissions` row.
