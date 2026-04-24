-- 013 — Immutable payout ledger
-- Every money movement (capture, cancel, refund) writes one row here.
-- Rows are insert-only: no UPDATE or DELETE is permitted via RLS.
-- This is the authoritative audit trail for financial disputes.

create type public.payout_event as enum ('captured', 'cancelled', 'refunded');

create table public.payout_ledger (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),

  -- Context
  task_id             uuid not null references public.tasks(id)       on delete restrict,
  submission_id       uuid          references public.submissions(id)  on delete set null,
  project_id          uuid not null references public.projects(id)     on delete restrict,
  contributor_id      uuid          references auth.users(id)          on delete set null,
  host_id             uuid not null references auth.users(id)          on delete restrict,
  decision_id         uuid          references public.decisions(id)    on delete set null,

  -- Stripe
  payment_intent_id   text not null,
  event               public.payout_event not null,
  stripe_status       text not null,

  -- Money (all values in cents)
  gross_amount_cents  integer not null check (gross_amount_cents >= 0),
  platform_fee_cents  integer not null check (platform_fee_cents >= 0),
  net_amount_cents    integer not null check (net_amount_cents >= 0),

  -- Immutability guard
  constraint net_check check (net_amount_cents = gross_amount_cents - platform_fee_cents)
);

-- Indexes for common query patterns
create index payout_ledger_task_id_idx        on public.payout_ledger(task_id);
create index payout_ledger_contributor_id_idx on public.payout_ledger(contributor_id);
create index payout_ledger_project_id_idx     on public.payout_ledger(project_id);
create index payout_ledger_payment_intent_idx on public.payout_ledger(payment_intent_id);
create index payout_ledger_created_at_idx     on public.payout_ledger(created_at desc);

-- RLS: read your own rows (host or contributor), service role can insert
alter table public.payout_ledger enable row level security;

-- Hosts can read ledger rows for their projects
create policy "host can read own project ledger"
  on public.payout_ledger for select
  using (
    host_id = auth.uid()
    or project_id in (
      select id from public.projects where host_id = auth.uid()
    )
  );

-- Contributors can read their own payout rows
create policy "contributor can read own ledger"
  on public.payout_ledger for select
  using (contributor_id = auth.uid());

-- No client-side inserts or mutations — service role only
create policy "no direct insert"
  on public.payout_ledger for insert
  with check (false);

create policy "no direct update"
  on public.payout_ledger for update
  using (false);

create policy "no direct delete"
  on public.payout_ledger for delete
  using (false);

-- profiles: add Stripe capability columns used by account.updated webhook
alter table public.profiles
  add column if not exists stripe_charges_enabled boolean not null default false,
  add column if not exists stripe_payouts_enabled boolean not null default false;

comment on column public.profiles.stripe_charges_enabled is
  'Reflects Stripe account.charges_enabled — updated by stripe-webhook on account.updated events.';
comment on column public.profiles.stripe_payouts_enabled is
  'Reflects Stripe account.payouts_enabled — updated by stripe-webhook on account.updated events.';
