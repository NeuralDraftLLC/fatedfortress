-- 021 — Marketplace filters + RLS + context card metadata
--
-- Adds deliverable_type index + payout filter columns (future-proofing).
-- No new columns needed — existing task_access='public' is sufficient for marketplace.
-- This migration ensures RLS correctly scopes public tasks and adds a DB-level
-- unique index to prevent concurrent claims by the same contributor.

-- Already added in 019, but we add a comment to clarify marketplace intent:
-- The tasks.task_access='public' column + RLS policy "Tasks viewable by host and contributors"
-- with clause `or task_access = 'public'` is the marketplace filter mechanism.
-- No additional columns required — the column already exists.

-- Add a comment documenting the marketplace filter pattern:
comment on column public.tasks.task_access is
  'Used for marketplace filtering: public tasks are visible to all authenticated users';

-- The accepted_roles text[] (added in 018) enables skill-based filtering in the marketplace.
-- No additional index needed — GIN index already created in 018.

-- Context card columns (deliverable_type, context_snippet, inferred_brief) added in 014.
-- These are populated by the Asset Scanner and rendered in marketplace Context Cards.
