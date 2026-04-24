-- ============================================================================
-- Migration 010: claim_task_atomic RPC
-- Atomically claims a task with SELECT FOR UPDATE SKIP LOCKED.
-- Called by the claim-task edge function AFTER a Stripe PI has been created.
--
-- Returns:
--   'ok'              – claim succeeded
--   'not_open'        – task status is not 'open'
--   'already_claimed' – another session won the race
--   'invite_only'     – task is invite-only and caller has no accepted invite
--   'wallet_error'    – project wallet has insufficient available funds
--   'not_found'       – task does not exist
-- ============================================================================

create or replace function public.claim_task_atomic(
  p_task_id              uuid,
  p_contributor_id       uuid,
  p_payment_intent_id    text,
  p_claim_duration_hours integer default 48
)
returns text           -- result code (see above)
language plpgsql
security definer
as $$
declare
  v_task            record;
  v_project         record;
  v_available       decimal;
  v_lock_amount     decimal;
  v_expires_at      timestamptz;
begin
  -- ── 1. Lock the task row (SKIP LOCKED = non-blocking; concurrent call gets nothing) ──
  select t.id, t.status, t.task_access, t.payout_max, t.project_id
    into v_task
    from public.tasks t
   where t.id = p_task_id
     for update skip locked;

  if not found then
    -- Row is locked by a concurrent session OR does not exist
    -- Distinguish by checking without the lock
    if exists (select 1 from public.tasks where id = p_task_id) then
      return 'already_claimed';
    else
      return 'not_found';
    end if;
  end if;

  -- ── 2. Status gate ────────────────────────────────────────────────────────
  if v_task.status <> 'open' then
    return 'not_open';
  end if;

  -- ── 3. Invitation gate (invite-only tasks) ─────────────────────────────
  if v_task.task_access = 'invite' then
    if not exists (
      select 1 from public.invitations
       where task_id    = p_task_id
         and invited_user_id = p_contributor_id
         and accepted_at is not null
         and expires_at > now()
    ) then
      return 'invite_only';
    end if;
  end if;

  -- ── 4. Wallet gate: enough available funds to cover the payout lock ───────
  v_lock_amount := coalesce(v_task.payout_max, 0);

  if v_lock_amount > 0 then
    select (deposited - locked - released) into v_available
      from public.project_wallet
     where project_id = v_task.project_id;

    if v_available is null or v_available < v_lock_amount then
      return 'wallet_error';
    end if;

    -- Lock funds
    update public.project_wallet
       set locked = locked + v_lock_amount
     where project_id = v_task.project_id;
  end if;

  -- ── 5. Claim the task ─────────────────────────────────────────────────────
  v_expires_at := now() + (p_claim_duration_hours || ' hours')::interval;

  update public.tasks
     set status                = 'claimed',
         claimed_by            = p_contributor_id,
         claimed_at            = now(),
         soft_lock_expires_at  = v_expires_at,
         payment_intent_id     = p_payment_intent_id,
         updated_at            = now()
   where id = p_task_id;

  -- ── 6. Audit log ──────────────────────────────────────────────────────────
  insert into public.audit_log (actor_id, task_id, action, payload)
  values (
    p_contributor_id,
    p_task_id,
    'claimed',
    jsonb_build_object(
      'expires_at',          v_expires_at,
      'payment_intent_id',   p_payment_intent_id,
      'lock_amount_cents',   v_lock_amount
    )
  );

  -- ── 7. Notify the host ──────────────────────────────────────────────────────
  select h.host_id into v_project
    from public.projects h
   where h.id = v_task.project_id;

  insert into public.notifications (user_id, type, task_id)
  values (
    (select host_id from public.projects where id = v_task.project_id),
    'task_claimed',
    p_task_id
  );

  return 'ok';
end;
$$;

-- payment_intent_id needs to live on tasks (not submissions) for the atomic RPC
alter table public.tasks
  add column if not exists payment_intent_id text;
