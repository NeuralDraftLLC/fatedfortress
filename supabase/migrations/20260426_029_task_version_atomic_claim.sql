-- ============================================================================
-- Migration 029: Task Optimistic Concurrency — version column
--
-- Context:
--   The existing claim_task_atomic RPC (migration 010) uses FOR UPDATE SKIP LOCKED
--   to prevent double-claims at the DB level. This migration adds an application-layer
--   optimistic version check so the edge function can reject stale claims BEFORE
--   hitting Stripe — preventing User B's card hold when User A won the race.
--
-- Changes:
--   1. Add `version integer NOT NULL DEFAULT 1` to tasks
--   2. Add CHECK (version >= 1) guard
--   3. Add index for fast lock-free version reads
--   4. Update claim_task_atomic: add p_expected_version param (default NULL = skip check)
--      - When p_expected_version is provided, version must match or 'version_mismatch' is returned
--      - Existing callers (no version param) continue to work unchanged
--      - On success, version is incremented atomically inside the existing transaction
-- ============================================================================

-- 1. Add version column
ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

-- 2. Prevent negative versions
ALTER TABLE public.tasks ADD CONSTRAINT IF NOT EXISTS tasks_version_positive CHECK (version >= 1);

-- 3. Fast index for lock-free version reads (used by edge function before RPC call)
CREATE INDEX IF NOT EXISTS idx_tasks_id_version ON public.tasks(id, version);

-- 4. Update claim_task_atomic: add p_expected_version parameter
--    Using CREATE OR REPLACE to update both the signature AND the body atomically.
--    p_expected_version defaults to NULL — existing callers (no version arg) are unaffected.
CREATE OR REPLACE FUNCTION public.claim_task_atomic(
  p_task_id              uuid,
  p_contributor_id       uuid,
  p_payment_intent_id    text,
  p_claim_duration_hours integer DEFAULT 48,
  p_expected_version     integer DEFAULT NULL  -- NEW: optimistic concurrency gate
)
RETURNS text  -- 'ok' | 'version_mismatch' | 'not_open' | 'already_claimed' | 'invite_only' | 'wallet_error' | 'not_found'
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
declare
  v_task            record;
  v_project         record;
  v_available       decimal;
  v_lock_amount     decimal;
  v_expires_at      timestamptz;
  v_current_version  integer;
begin
  -- ── 1. Lock the task row (SKIP LOCKED = non-blocking; concurrent call gets nothing) ──
  select t.id, t.status, t.task_access, t.payout_max, t.project_id, t.version
    into v_task
    from public.tasks t
   where t.id = p_task_id
     for update skip locked;

  if not found then
    if exists (select 1 from public.tasks where id = p_task_id) then
      return 'already_claimed';
    else
      return 'not_found';
    end if;
  end if;

  v_current_version := v_task.version;

  -- ── 1b. Optimistic version gate (NEW — only enforced when client sends expected version) ──
  if p_expected_version is not null and p_expected_version != v_current_version then
    return 'version_mismatch';
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

    update public.project_wallet
       set locked = locked + v_lock_amount
     where project_id = v_task.project_id;
  end if;

  -- ── 5. Claim the task — version is incremented atomically on success ──────
  v_expires_at := now() + (p_claim_duration_hours || ' hours')::interval;

  update public.tasks
     set status                = 'claimed',
         claimed_by            = p_contributor_id,
         claimed_at            = now(),
         soft_lock_expires_at  = v_expires_at,
         payment_intent_id     = p_payment_intent_id,
         updated_at            = now(),
         version               = version + 1  -- NEW: optimistic lock step
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
      'lock_amount_cents',  v_lock_amount,
      'version',            v_current_version + 1
    )
  );

  -- ── 7. Notify the host ──────────────────────────────────────────────────────
  insert into public.notifications (user_id, type, task_id)
  values (
    (select host_id from public.projects where id = v_task.project_id),
    'task_claimed',
    p_task_id
  );

  return 'ok';
end;
$$;

-- ============================================================================
-- Idempotency notes:
--   ADD COLUMN IF NOT EXISTS        → no-op if column already exists
--   ADD CONSTRAINT IF NOT EXISTS    → no-op if constraint already exists
--   CREATE INDEX IF NOT EXISTS      → no-op if index already exists
--   CREATE OR REPLACE FUNCTION      → updates body + adds new param; existing
--                                     callers without p_expected_version get DEFAULT NULL
-- ============================================================================
