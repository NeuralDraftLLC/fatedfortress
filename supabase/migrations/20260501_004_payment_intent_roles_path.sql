-- 004 — Payment intent tracking + accepted roles + expected path on tasks
-- payment_intent_id: Stripe PaymentIntent ID (set at claim-time via create-payment-intent)
-- accepted_roles: text[] of skill/role labels required to work on this task
-- expected_path: filesystem path hint for Asset Scanner output落地 location

alter table public.tasks
  add column if not exists payment_intent_id text,
  add column if not exists accepted_roles text[] default '{}',
  add column if not exists expected_path text;

-- Index on payment_intent_id for fast lookups during Stripe webhook processing
create index if not exists idx_tasks_payment_intent_id on public.tasks(payment_intent_id)
  where payment_intent_id is not null;

-- GIN index on accepted_roles for skill-based task filtering
create index if not exists idx_tasks_accepted_roles on public.tasks using gin(accepted_roles);