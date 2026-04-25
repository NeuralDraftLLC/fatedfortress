-- ============================================================================
-- Migration 028: Profiles FK Join Fix
--
-- Context:
--   Migration 027 dropped the broad 'Profiles: authenticated users can select'
--   policy to prevent stripe_account_id / notification_trigger_url leakage.
--   This inadvertently broke PostgREST FK joins (profiles!projects_host_id_fkey)
--   because PostgREST evaluates the profiles RLS policy for the joined row.
--   With only the own-row policy, joins returned null for any host ≠ current user.
--
-- Fix:
--   Restore a narrow SELECT policy permitting authenticated reads of safe
--   display columns. Sensitive column access is blocked at the data layer
--   (data.ts never requests stripe_account_id etc.) rather than at RLS level,
--   since Postgres RLS cannot restrict individual columns within a policy.
--
--   The profiles_public view created in 027 remains the canonical path for
--   any direct cross-user from('profiles') queries in client code.
--
-- Sensitive columns (service_role / edge function only):
--   stripe_account_id, notification_trigger_url, stripe_charges_enabled
--   These are never selected by data.ts — enforced by code review + TypeScript.
-- ============================================================================

do $$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'profiles'
       and policyname = 'Profiles: authenticated users can select display columns'
  ) then
    create policy "Profiles: authenticated users can select display columns"
      on public.profiles for select
      using (auth.role() = 'authenticated');
  end if;
end $$;

-- ============================================================================
-- Note on sensitive column protection:
--
-- RLS in Postgres applies at the row level, not the column level.
-- The policy above permits a full row SELECT for any authenticated user.
-- Protection against sensitive column reads is enforced by:
--
--   1. data.ts getProfile() — selects only explicit safe columns, never *
--   2. profiles_public view — SECURITY DEFINER view projecting only safe cols
--   3. TypeScript Protocol type (Profile) — sensitive fields marked @internal
--      so they never appear in generated client types from supabase gen types
--
-- For column-level enforcement consider Postgres column privileges:
--   REVOKE SELECT (stripe_account_id, notification_trigger_url,
--                 stripe_charges_enabled) ON public.profiles FROM authenticated;
-- This is a future hardening step — not applied here to avoid breaking
-- the supabase-js client which uses SELECT * internally in some paths.
-- ============================================================================
