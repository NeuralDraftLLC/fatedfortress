-- ============================================================================
-- Migration 023: REPLICA IDENTITY FULL for Supabase Realtime
--
-- Supabase Realtime's postgres_changes subscriptions rely on PostgreSQL
-- logical replication. By default, UPDATE and DELETE WAL records only
-- carry the primary key of the changed row (REPLICA IDENTITY DEFAULT).
-- The Realtime multiplexer therefore cannot forward the full NEW/OLD row
-- payload — which means client-side filters (e.g. filter: `project_id=eq.X`)
-- silently drop all events for non-PK columns.
--
-- Setting REPLICA IDENTITY FULL makes every column available in the WAL
-- for UPDATE and DELETE events.  This is required for every table that
-- has a Supabase Realtime postgres_changes subscription with a
-- column-level filter OR that needs the full NEW row in the client payload.
--
-- Tables subscribed to in this codebase
-- (see apps/web/src/pages/reviews.ts and apps/web/src/pages/project.ts):
--
--   • tasks          — reviews.ts  UPDATE filter: status
--                      project.ts  UPDATE filter: project_id
--   • project_wallet — project.ts  UPDATE filter: project_id
--   • audit_log      — project.ts  INSERT filter: project_id
--   • submissions    — reviews.ts  INSERT (no filter, but payload needed)
--
-- Performance note:
--   REPLICA IDENTITY FULL increases WAL volume proportionally to row size.
--   All four tables have narrow rows (< 20 columns), so the overhead is
--   acceptable for this workload.  Revisit if table row counts exceed 10M.
--
-- Idempotent: safe to run multiple times.
-- ============================================================================

-- ── REPLICA IDENTITY ────────────────────────────────────────────────────────

alter table public.tasks
  replica identity full;

alter table public.project_wallet
  replica identity full;

alter table public.audit_log
  replica identity full;

alter table public.submissions
  replica identity full;

-- ── Supabase Realtime publication ───────────────────────────────────────────
-- Supabase creates a publication called `supabase_realtime` during project
-- setup.  Tables must be members of this publication to receive CDC events.
-- The DO block is idempotent: it only adds tables that are not already
-- members, so re-running this migration is safe.

do $$
declare
  v_pub_exists boolean;
begin
  select exists(
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) into v_pub_exists;

  if not v_pub_exists then
    -- Local dev without Supabase initialised yet: create the publication.
    create publication supabase_realtime;
  end if;
end;
$$;

-- Add each table to the publication only if it is not already a member.
do $$
declare
  v_tables text[] := array[
    'public.tasks',
    'public.project_wallet',
    'public.audit_log',
    'public.submissions'
  ];
  v_tbl    text;
  v_schema text;
  v_table  text;
begin
  foreach v_tbl in array v_tables loop
    v_schema := split_part(v_tbl, '.', 1);
    v_table  := split_part(v_tbl, '.', 2);

    if not exists (
      select 1
        from pg_publication_tables
       where pubname    = 'supabase_realtime'
         and schemaname = v_schema
         and tablename  = v_table
    ) then
      execute format(
        'alter publication supabase_realtime add table %I.%I',
        v_schema, v_table
      );
    end if;
  end loop;
end;
$$;
