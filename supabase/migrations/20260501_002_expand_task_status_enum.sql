-- 002 — Expand TaskStatus CHECK constraint to include approved/rejected
-- These are terminal task outcomes handled via the decisions table.
-- Keeping them on the tasks status CHECK ensures DB-level enforcement.

alter table public.tasks drop constraint if exists tasks_status_check;

alter table public.tasks
  add constraint tasks_status_check
  check (status in (
    'draft', 'open', 'claimed', 'submitted', 'under_review',
    'revision_requested', 'paid', 'expired',
    'approved', 'rejected'
  ));