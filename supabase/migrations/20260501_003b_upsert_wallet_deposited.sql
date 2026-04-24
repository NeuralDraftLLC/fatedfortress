-- upsert_wallet_deposited(project_id, amount)
-- Atomically inserts or increments project_wallet.deposited.
-- Replaces the racy read-then-update pattern in fundProjectWallet (payout.ts).
create or replace function public.upsert_wallet_deposited(
  p_project_id uuid,
  p_amount decimal
)
returns decimal
language plpgsql
as $$
declare
  v_deposited decimal;
begin
  if p_amount <= 0 then
    raise exception 'Amount must be positive';
  end if;

  insert into public.project_wallet (project_id, deposited)
  values (p_project_id, p_amount)
  on conflict (project_id) do update
    set deposited = project_wallet.deposited + p_amount
  returning deposited into v_deposited;

  return v_deposited;
end;
$$;

grant execute on function public.upsert_wallet_deposited(uuid, decimal) to authenticated;