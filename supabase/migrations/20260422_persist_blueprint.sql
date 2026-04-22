-- Persist SCOPE blueprint artifacts atomically (projects + tasks).
-- Adds blueprint fields to projects and an RPC for single-transaction writes.

alter table public.projects
  add column if not exists readme_draft text,
  add column if not exists folder_structure text[];

-- Atomic persistence RPC: insert project + tasks + blueprint in one tx.
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
    p_project_id, p_host_id, coalesce(p_title, ''), p_description, coalesce(p_references_urls, '{}'), 'draft',
    p_readme_draft, p_folder_structure
  );

  if jsonb_typeof(p_tasks) = 'array' then
    for t in select * from jsonb_array_elements(p_tasks)
    loop
      insert into public.tasks (
        project_id,
        title,
        description,
        deliverable_type,
        payout_min,
        payout_max,
        ambiguity_score,
        estimated_minutes,
        status,
        task_access,
        created_at,
        updated_at
      ) values (
        p_project_id,
        coalesce(t->>'title',''),
        t->>'description',
        t->>'deliverable_type',
        coalesce((t->>'payout_min')::numeric, 0),
        coalesce((t->>'payout_max')::numeric, 0),
        nullif(t->>'ambiguity_score','')::numeric,
        nullif(t->>'estimated_minutes','')::int,
        'draft',
        'invite',
        now(),
        now()
      );
    end loop;
  end if;

  insert into public.audit_log (actor_id, task_id, action, payload)
  values (p_host_id, null, 'project_scoped', jsonb_build_object('projectId', p_project_id));

  return p_project_id;
end;
$$;

grant execute on function public.persist_scoped_project(
  uuid, uuid, text, text, text[], text, text[], jsonb
) to authenticated;

