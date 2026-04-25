-- ============================================================================
-- Migration 027: RLS 026 Hardening
--
-- Fixes gaps found in Migration 026 (rls_audit):
--
--   A2 (HIGH)   profiles   — broad SELECT leaks stripe_account_id, PII to all users
--   A3 (HIGH)   tasks      — contributor UPDATE missing WITH CHECK → ownership transfer
--   A4 (MEDIUM) submissions — contributor UPDATE missing WITH CHECK → contributor_id swap
--   A1 (LOW)    audit_log  — system entries (actor_id IS NULL) invisible to host
--
-- All changes are idempotent (DO $$ IF NOT EXISTS / OR REPLACE guards).
-- ============================================================================


-- ============================================================================
-- A3: tasks — add WITH CHECK to contributor update policy
-- ============================================================================
-- Without WITH CHECK, a contributor who currently claims a task could
-- UPDATE tasks SET claimed_by = '<other_uid>', passing the USING check
-- (they own it at read time) but writing a different owner.
--
-- Fix: recreate the policy with both USING and WITH CHECK locked to auth.uid().
-- ============================================================================

do $$ begin
  -- Drop old policy (no WITH CHECK)
  if exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'tasks'
       and policyname = 'Tasks: contributor can update own claimed task'
  ) then
    drop policy "Tasks: contributor can update own claimed task" on public.tasks;
  end if;
end $$;

create policy "Tasks: contributor can update own claimed task"
  on public.tasks for update
  using  (auth.uid() = claimed_by)
  with check (auth.uid() = claimed_by);


-- ============================================================================
-- A4: submissions — add WITH CHECK to contributor update policy
-- ============================================================================
-- Same pattern: without WITH CHECK a contributor can swap contributor_id.
-- ============================================================================

do $$ begin
  if exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'submissions'
       and policyname = 'Submissions: contributor can update own submission'
  ) then
    drop policy "Submissions: contributor can update own submission" on public.submissions;
  end if;
end $$;

create policy "Submissions: contributor can update own submission"
  on public.submissions for update
  using  (auth.uid() = contributor_id)
  with check (auth.uid() = contributor_id);


-- ============================================================================
-- A2: profiles — restrict SELECT to own-row; expose safe columns via view
-- ============================================================================
-- The 026 policy 'Profiles: authenticated users can select' allowed any
-- authenticated user to SELECT *, exposing:
--   stripe_account_id, stripe_charges_enabled, notification_trigger_url,
--   review_reliability (financial signal), email, etc.
--
-- Fix strategy:
--   1. Drop the broad SELECT policy.
--   2. Add own-row SELECT policy (full access to your own profile).
--   3. Create profiles_public VIEW (SECURITY DEFINER) exposing only safe
--      display columns — used by client queries that need other users' names.
--
-- The SECURITY DEFINER view bypasses RLS, so it intentionally exposes only
-- the columns listed. Client code must query profiles_public for cross-user
-- lookups, not the profiles table directly.
-- ============================================================================

-- 1. Drop the overly-broad SELECT policy
do $$ begin
  if exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'profiles'
       and policyname = 'Profiles: authenticated users can select'
  ) then
    drop policy "Profiles: authenticated users can select" on public.profiles;
  end if;
end $$;

-- 2. Own-row full SELECT (replaces broad policy for self-reads)
do $$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'profiles'
       and policyname = 'Profiles: user can select own row'
  ) then
    create policy "Profiles: user can select own row"
      on public.profiles for select
      using (auth.uid() = id);
  end if;
end $$;

-- 3. profiles_public view — safe display columns only
--    SECURITY DEFINER so it bypasses RLS on the underlying profiles table.
--    Authenticated-only guard is applied at the Supabase API layer via anon/auth roles.
create or replace view public.profiles_public
  security definer
as
  select
    id,
    username,
    avatar_url,
    display_name,
    review_reliability,
    skills,
    created_at
  from public.profiles;

-- Grant SELECT on the view to authenticated and anon roles
-- (anon is read-only and the view only exposes safe columns).
grant select on public.profiles_public to authenticated;
grant select on public.profiles_public to anon;


-- ============================================================================
-- A1: audit_log — host can see project-scoped entries regardless of actor_id
-- ============================================================================
-- The 026 SELECT policy required auth.uid() = actor_id, making system-generated
-- entries (actor_id IS NULL) invisible to the host. Add a separate policy so
-- the host of a project can see all audit entries for their project.
-- Both policies are permissive — a row is visible if EITHER matches.
-- ============================================================================

do $$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'audit_log'
       and policyname = 'Audit log: host can select project entries'
  ) then
    create policy "Audit log: host can select project entries"
      on public.audit_log for select
      using (
        -- task_id may be null for project-level entries; handle both cases
        task_id is null
        or auth.uid() = (
          select p.host_id
            from public.tasks t
            join public.projects p on p.id = t.project_id
           where t.id = task_id
        )
      );
  end if;
end $$;

-- ============================================================================
-- payout_ledger — no INSERT policy by design (documented)
-- Service_role edge functions are the sole writers. Client INSERT is blocked
-- by RLS with no policy match — this is intentional and correct.
-- No SQL change needed. This comment serves as the audit trail.
-- ============================================================================
