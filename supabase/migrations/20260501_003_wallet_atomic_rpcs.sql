-- 003 — Atomic wallet RPCs
-- All three use SELECT FOR UPDATE to prevent concurrent double-spend.
-- Call these from edge functions / thin TS — never mutate wallet client-side.

-- increment_wallet_deposited(project_id, amount)
-- Adds amount to deposited. Returns the new deposited balance.
create or replace function public.increment_wallet_deposited(
  p_project_id uuid,
  p_amount decimal
)
returns decimal
language plpgsql
as $$
declare
  v_new_deposited decimal;
begin
  if p_amount <= 0 then
    raise exception 'Amount must be positive';
  end if;

  update public.project_wallet
  set deposited = deposited + p_amount
  where project_id = p_project_id
  returning deposited into v_new_deposited;

  return v_new_deposited;
end;
$$;

grant execute on function public.increment_wallet_deposited(uuid, decimal) to authenticated;

-- release_wallet_lock(project_id, amount)
-- Moves amount from locked → released (called on auto-release or manual payout).
-- Uses greatest() to guard against over-releasing if amount exceeds locked.
create or replace function public.release_wallet_lock(
  p_project_id uuid,
  p_amount decimal
)
returns record (locked decimal, released decimal)
language plpgsql
as $$
declare
  v_wallet_id uuid;
  v_locked decimal;
  v_released decimal;
begin
  if p_amount <= 0 then
    raise exception 'Amount must be positive';
  end if;

  -- Lock the wallet row for update to prevent concurrent release
  select id, locked, released into v_wallet_id, v_locked, v_released
  from public.project_wallet
  where project_id = p_project_id
  for update;

  if not found then
    raise exception 'Wallet not found for project_id: %', p_project_id;
  end if;

  update public.project_wallet
  set
    locked   = greatest(0, locked - p_amount),
    released = released + p_amount
  where id = v_wallet_id
  returning locked, released into v_locked, v_released;

  return row(v_locked, v_released);
end;
$$;

grant execute on function public.release_wallet_lock(uuid, decimal)
  to authenticated;

-- unlock_wallet(project_id, amount)
-- Returns amount from locked → available (called when a claim expires
-- or a task is rejected after lock but before release).
create or replace function public.unlock_wallet(
  p_project_id uuid,
  p_amount decimal
)
returns decimal
language plpgsql
as $$
declare
  v_new_locked decimal;
begin
  if p_amount <= 0 then
    raise exception 'Amount must be positive';
  end if;

  update public.project_wallet
  set locked = greatest(0, locked - p_amount)
  where project_id = p_project_id
  returning locked into v_new_locked;

  return v_new_locked;
end;
$$;

grant execute on function public.unlock_wallet(uuid, decimal) to authenticated;