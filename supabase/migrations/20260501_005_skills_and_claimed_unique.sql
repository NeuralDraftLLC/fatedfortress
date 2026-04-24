-- 005 — Skills array on profiles + unique index on tasks(claimed_by) for claimed status
-- skills: array of skill/role labels for contributor matching and marketplace discovery
-- unique index: enforces exactly one claimed task per contributor at the DB level

-- Skills on profiles
alter table public.profiles
  add column if not exists skills text[] default '{}';

-- GIN index for skill-based profile lookups
create index if not exists idx_profiles_skills on public.profiles using gin(skills);

-- One claimed task per contributor at a time (partial unique index)
-- claimed_by is NULL for unclaimed tasks, so the where clause filters correctly.
-- PostgreSQL treats NULL != NULL in unique index predicates, so all unclaimed rows
-- are excluded automatically.
create unique index if not exists idx_tasks_one_claimed_per_contributor
  on public.tasks(claimed_by)
  where status = 'claimed';