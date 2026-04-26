-- Migration 032: add profiles.herenow_url + reliability_score generated alias
-- herenow-publish.ts queries both columns; neither existed in the schema.
--
-- reliability_score: stored generated column (= review_reliability) so the
-- canonical DB column stays as review_reliability but the page/API can use
-- either name without a breaking rename.
--
-- herenow_url: persisted by linkHereNowUrl() in apps/web/src/net/herenow.ts.

alter table public.profiles
  add column if not exists herenow_url text,
  add column if not exists reliability_score numeric
    generated always as (review_reliability) stored;

-- RLS: owners can see and update their own herenow_url.
-- reliability_score is read-only (generated) so no UPDATE policy needed for it.
create policy "profiles: owner can update herenow_url"
  on public.profiles
  for update
  using  (auth.uid() = id)
  with check (auth.uid() = id);

-- Allow any authenticated user to read herenow_url (it's a public portfolio link)
-- The existing SELECT policy on profiles already covers this if one exists;
-- this is a no-op guard in case it doesn't.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'profiles'
      and policyname = 'profiles: authenticated read'
  ) then
    execute $q$
      create policy "profiles: authenticated read"
        on public.profiles
        for select
        using (auth.role() = 'authenticated')
    $q$;
  end if;
end;
$$;
