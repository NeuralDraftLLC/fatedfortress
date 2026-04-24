-- ============================================================================
-- Migration 009: Rename readme_draft → project_brief
--               Add architecture_diagram column
--               Add 'open' to projects.status enum
--               Add DB trigger: set status='open' when first task is inserted
-- ============================================================================

-- --------------------------------------------------------------------------
-- 1. Rename readme_draft → project_brief
-- --------------------------------------------------------------------------
alter table public.projects
  rename column readme_draft to project_brief;

-- --------------------------------------------------------------------------
-- 2. Add architecture_diagram (Mermaid source, separate from prose brief)
-- --------------------------------------------------------------------------
alter table public.projects
  add column if not exists architecture_diagram text;

-- --------------------------------------------------------------------------
-- 3. Add 'open' to projects.status enum
--    Current: ('draft', 'active', 'completed')
--    New:     ('draft', 'open', 'active', 'completed')
--    'open'   = scoped & published, accepting contributors
--    'active' = at least one task claimed / in-flight
-- --------------------------------------------------------------------------
alter table public.projects
  drop constraint if exists projects_status_check;

alter table public.projects
  add constraint projects_status_check
  check (status in ('draft', 'open', 'active', 'completed'));

-- --------------------------------------------------------------------------
-- 4. Trigger: after a task is inserted for a project, if project is still
--    'draft', promote it to 'open'. This fires after persist_scoped_project
--    bulk-inserts tasks, giving us the gate for free at the DB level.
-- --------------------------------------------------------------------------
create or replace function public.set_project_open_on_tasks()
returns trigger
language plpgsql
security definer
as $$
begin
  update public.projects
  set status = 'open', updated_at = now()
  where id = NEW.project_id
    and status = 'draft';
  return NEW;
end;
$$;

drop trigger if exists trg_set_project_open on public.tasks;

create trigger trg_set_project_open
  after insert on public.tasks
  for each row
  execute function public.set_project_open_on_tasks();

-- --------------------------------------------------------------------------
-- 5. Update persist_scoped_project RPC to accept architecture_diagram
--    (additive — existing callers that omit it are unaffected)
-- --------------------------------------------------------------------------
create or replace function public.persist_scoped_project(
  p_project_id   uuid,
  p_project_brief text,
  p_architecture_diagram text default null,
  p_folder_structure text[] default '{}',
  p_tasks jsonb default '[]'
)
returns void
language plpgsql
security definer
as $$
declare
  v_task jsonb;
begin
  -- Update project metadata
  update public.projects
  set
    project_brief         = p_project_brief,
    architecture_diagram  = p_architecture_diagram,
    folder_structure      = p_folder_structure,
    updated_at            = now()
  where id = p_project_id
    and host_id = auth.uid();

  if not found then
    raise exception 'project not found or not owned by caller';
  end if;

  -- Insert tasks (trigger fires after each insert to promote project → open)
  for v_task in select * from jsonb_array_elements(p_tasks)
  loop
    insert into public.tasks (
      project_id,
      title,
      description,
      payout_min,
      payout_max,
      ambiguity_score,
      estimated_minutes,
      deliverable_type,
      spec_constraints,
      status
    ) values (
      p_project_id,
      v_task->>'title',
      v_task->>'description',
      (v_task->>'payout_min')::decimal,
      (v_task->>'payout_max')::decimal,
      (v_task->>'ambiguity_score')::decimal,
      (v_task->>'estimated_minutes')::integer,
      v_task->>'deliverable_type',
      coalesce(v_task->'spec_constraints', '{}'),
      'open'
    )
    on conflict do nothing;
  end loop;
end;
$$;
