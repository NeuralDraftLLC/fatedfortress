-- 008 — spec_constraints: shared language between Asset Scanner and Verification Gate
--
-- spec_constraints is a jsonb field on tasks that stores the technical specification
-- a contributor's submission must satisfy before the host reviews it.
--
-- Shape examples by deliverable_type:
--   3d_model:    { "max_polygons": 50000, "requires_rig": true, "lod_levels": 2 }
--   audio:       { "sample_rate": 44100, "channels": 2, "max_duration_s": 180 }
--   design_asset:{ "max_width": 4096, "max_height": 4096, "min_width": 512 }
--   video:       { "max_width": 3840, "max_height": 2160, "max_duration_s": 300 }
--   code_patch:  { "max_files_changed": 10, "requires_tests": true }
--   figma_link:  { "requires_components": true }
--   text:        { "min_words": 200, "max_words": 5000 }

alter table public.tasks
  add column if not exists spec_constraints jsonb not null default '{}';

-- GIN index: fast containment queries (e.g. tasks with spec requiring rigging)
create index if not exists idx_tasks_spec_constraints_gin
  on public.tasks using gin(spec_constraints);

-- Update persist_scoped_project RPC to accept spec_constraints per task.
-- Safe: adds spec_constraints extraction from task jsonb; no behaviour change for
-- callers that omit it (defaults to '{}').
create or replace function public.persist_scoped_project(
  p_project_id uuid,
  p_host_id uuid,
  p_title text,
  p_description text,
  p_references_urls text[],
  p_readme_draft text,
  p_folder_structure text[],
  p_tasks jsonb
)
returns uuid
language plpgsql
as $$
declare
  t jsonb;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if p_host_id <> auth.uid() then
    raise exception 'Host mismatch';
  end if;

  insert into public.projects (
    id, host_id, title, description, references_urls, status, readme_draft, folder_structure
  ) values (
    p_project_id, p_host_id,
    coalesce(p_title, ''),
    p_description,
    coalesce(p_references_urls, '{}'),
    'draft',
    p_readme_draft,
    p_folder_structure
  )
  on conflict (id) do update set
    title           = excluded.title,
    description     = excluded.description,
    readme_draft    = excluded.readme_draft,
    folder_structure= excluded.folder_structure,
    updated_at      = now();

  if jsonb_typeof(p_tasks) = 'array' then
    for t in select * from jsonb_array_elements(p_tasks)
    loop
      insert into public.tasks (
        project_id,
        title,
        description,
        deliverable_type,
        context_snippet,
        inferred_brief,
        expected_path,
        payout_min,
        payout_max,
        ambiguity_score,
        spec_constraints,
        estimated_minutes,
        status,
        task_access,
        created_at,
        updated_at
      ) values (
        p_project_id,
        coalesce(t->>'title', ''),
        t->>'description',
        t->>'deliverable_type',
        t->>'context_snippet',
        t->>'inferred_brief',
        t->>'expected_path',
        coalesce((t->>'payout_min')::numeric, 0),
        coalesce((t->>'payout_max')::numeric, 0),
        nullif(t->>'ambiguity_score', '')::numeric,
        coalesce(t->'spec_constraints', '{}'),
        nullif(t->>'estimated_minutes', '')::int,
        'draft',
        'invite',
        now(),
        now()
      );
    end loop;
  end if;

  insert into public.audit_log (actor_id, task_id, action, payload)
  values (
    p_host_id, null, 'project_scoped',
    jsonb_build_object('projectId', p_project_id)
  );

  return p_project_id;
end;
$$;

grant execute on function public.persist_scoped_project(
  uuid, uuid, text, text, text[], text, text[], jsonb
) to authenticated;

-- Lightweight helper for asset-scanner bulk inserts (service-role only).
-- Accepts a jsonb array of task rows and inserts them as 'draft'.
create or replace function public.asset_scanner_write(
  p_project_id uuid,
  p_tasks jsonb
)
returns int
language plpgsql
security definer
as $$
declare
  t jsonb;
  inserted int := 0;
begin
  if jsonb_typeof(p_tasks) <> 'array' then
    raise exception 'p_tasks must be a JSON array';
  end if;

  for t in select * from jsonb_array_elements(p_tasks)
  loop
    insert into public.tasks (
      project_id,
      title,
      description,
      deliverable_type,
      context_snippet,
      inferred_brief,
      expected_path,
      payout_min,
      payout_max,
      ambiguity_score,
      spec_constraints,
      status,
      task_access,
      created_at,
      updated_at
    ) values (
      p_project_id,
      coalesce(t->>'title', t->>'path', 'Untitled gap'),
      t->>'inferred_brief',
      t->>'deliverable_type',
      t->>'context_snippet',
      t->>'inferred_brief',
      t->>'expected_path',
      coalesce((t->>'payout_min')::int, 10),
      coalesce((t->>'payout_max')::int, 60),
      coalesce((t->>'ambiguity_score')::numeric, 0.50),
      coalesce(t->'spec_constraints', '{}'),
      'draft',
      'invite',
      now(),
      now()
    );
    inserted := inserted + 1;
  end loop;

  return inserted;
end;
$$;

-- Only service-role may call asset_scanner_write (called from Edge Function)
revoke all on function public.asset_scanner_write(uuid, jsonb) from public, authenticated;
grant execute on function public.asset_scanner_write(uuid, jsonb) to service_role;
