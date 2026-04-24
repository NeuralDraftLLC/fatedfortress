# Fated Fortress — Smoke Test Suite

End-to-end smoke tests for the critical payment, wallet, and claim flows.
Runs against your live Supabase project using the service role key.
**Never run against production with real Stripe keys.** Use Stripe test mode.

## Setup

```bash
cp tests/smoke/.env.example tests/smoke/.env
# fill in the values
```

## Run

```bash
# Deno
deno run --allow-net --allow-env --allow-read tests/smoke/run.ts

# Node (tsx)
npx tsx tests/smoke/run.ts
```

## Tests

| # | Name | What it proves |
|---|------|----------------|
| 1 | `wallet_deposit_atomic` | Two concurrent `upsert_wallet_deposited` calls both land — no lost deposit |
| 2 | `claim_task_race` | Two concurrent claim requests — only one wins, loser gets `already_claimed` |
| 3 | `claim_to_capture` | Full money loop: claim → approve → capture → task `paid` |
| 4 | `auto_release_trigger` | Manual trigger of `auto-release` with backdated `submitted_at` → task releases |
| 5 | `expire_claims_trigger` | Manual trigger of `expire-claims` with expired lock → task returns to `open` |

## Teardown

Each test seeds its own data and cleans up on pass **and** fail.
A `__smoke_test__` tag is added to all seeded rows so a failed run
can be cleaned manually:

```sql
DELETE FROM tasks WHERE title LIKE '[SMOKE]%';
DELETE FROM projects WHERE title LIKE '[SMOKE]%';
```
