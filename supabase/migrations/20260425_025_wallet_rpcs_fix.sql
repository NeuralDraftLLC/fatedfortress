-- ============================================================================
-- Migration 025: Fix wallet RPCs — invalid syntax + missing row locks
--
-- Problems found in migration 016:
--
--   1. release_wallet_lock used `returns record (locked decimal, released decimal)`
--      which is NOT valid PostgreSQL syntax. The function cannot be created and
--      any call from auto-release would throw:
--        ERROR: syntax error at or near "("
--      Fix: return jsonb instead (caller already destructures the object).
--
--   2. unlock_wallet and increment_wallet_deposited lacked SELECT FOR UPDATE,
--      allowing two concurrent expire-claims runs to race on the same wallet row
--      and produce a negative locked balance.
--
--   3. All three functions were missing SECURITY DEFINER and set search_path,
--      leaving them vulnerable to search_path injection.
--
--   4. Only `authenticated` was granted EXECUTE. Edge functions run under the
--      service_role key, so `service_role` needs the grant too.
--
-- All three functions are replaced atomically here. The signatures are
-- backward-compatible with callers in expire-claims and auto-release.
-- ============================================================================

-- ── 1. increment_wallet_deposited ────────────────────────────────────────────
-- Adds p_amount to deposited. Returns new deposited balance.
-- Fixed: added FOR UPDATE to prevent concurrent deposit races.

create or replace function public.increment_wallet_deposited(
  p_project_id uuid,
  p_amount     decimal
)
returns decimal
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new_deposited decimal;
begin
  if p_amount <= 0 then
    raise exception 'increment_wallet_deposited: amount must be positive, got %', p_amount;
  end if;

  -- Lock the row first to prevent concurrent modification.
  perform id
    from public.project_wallet
   where project_id = p_project_id
     for update;

  if not found then
    raise exception 'increment_wallet_deposited: wallet not found for project %', p_project_id;
  end if;

  update public.project_wallet
     set deposited  = deposited + p_amount,
         updated_at = now()
   where project_id = p_project_id
  returning deposited into v_new_deposited;

  return v_new_deposited;
end;
$$;

-- ── 2. unlock_wallet ───────────────────────────────────────────────────────────
-- Returns p_amount from locked → available (balance unchanged).
-- Called when a claim expires (expire-claims) or a submission is rejected
-- before payout (review-submission).
-- Fixed: added FOR UPDATE to prevent concurrent unlock races.

create or replace function public.unlock_wallet(
  p_project_id uuid,
  p_amount     decimal
)
returns decimal
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new_locked decimal;
begin
  if p_amount <= 0 then
    raise exception 'unlock_wallet: amount must be positive, got %', p_amount;
  end if;

  -- Lock the row to prevent concurrent unlock on the same wallet.
  perform id
    from public.project_wallet
   where project_id = p_project_id
     for update;

  if not found then
    raise exception 'unlock_wallet: wallet not found for project %', p_project_id;
  end if;

  update public.project_wallet
     set locked     = greatest(0, locked - p_amount),
         updated_at = now()
   where project_id = p_project_id
  returning locked into v_new_locked;

  return v_new_locked;
end;
$$;

-- ── 3. release_wallet_lock ───────────────────────────────────────────────────────
-- Moves p_amount from locked → released (auto-release, manual payout).
-- Fixed: invalid `returns record (...)` syntax replaced with jsonb.
-- Callers receive { locked, released } and can destructure normally.

create or replace function public.release_wallet_lock(
  p_project_id uuid,
  p_amount     decimal
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wallet_id uuid;
  v_locked    decimal;
  v_released  decimal;
begin
  if p_amount <= 0 then
    raise exception 'release_wallet_lock: amount must be positive, got %', p_amount;
  end if;

  -- Lock the row before reading to prevent concurrent release races.
  select id, locked, released
    into v_wallet_id, v_locked, v_released
    from public.project_wallet
   where project_id = p_project_id
     for update;

  if not found then
    raise exception 'release_wallet_lock: wallet not found for project %', p_project_id;
  end if;

  update public.project_wallet
     set locked     = greatest(0, locked   - p_amount),
         released   = released + p_amount,
         updated_at = now()
   where id = v_wallet_id
  returning locked, released into v_locked, v_released;

  return jsonb_build_object(
    'locked',   v_locked,
    'released', v_released
  );
end;
$$;

-- ── Grants ─────────────────────────────────────────────────────────────────────
-- service_role added: edge functions invoke RPCs via service role key.
-- authenticated retained: future direct-client calls (admin dashboard, etc.)

grant execute on function public.increment_wallet_deposited(uuid, decimal)
  to authenticated, service_role;

grant execute on function public.unlock_wallet(uuid, decimal)
  to authenticated, service_role;

grant execute on function public.release_wallet_lock(uuid, decimal)
  to authenticated, service_role;
