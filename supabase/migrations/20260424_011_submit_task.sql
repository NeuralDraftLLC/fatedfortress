-- ============================================================================
-- Migration 011: Submission enrichment + submit_task_atomic RPC
-- Adds PR-specific columns to submissions and an atomic submission RPC.
-- ============================================================================

-- --------------------------------------------------------------------------
-- 1. Enrich submissions table
-- --------------------------------------------------------------------------
alter table public.submissions
  add column if not exists pr_url        text,          -- GitHub PR link (code/patch tasks)
  add column if not exists pr_diff_url   text,          -- GitHub diff URL for host diff preview
  add column if not exists pr_files      jsonb,         -- [{filename, status, additions, deletions}]
  add column if not exists notes         text,          -- contributor notes to host
  add column if not exists verification_result jsonb,   -- full VerificationResult from verify-submission
  add column if not exists verified_at   timestamptz;   -- when verify-submission ran

-- NOT NULL constraint: every submission needs at least one of asset_url or pr_url
-- We relax the existing NOT NULL on asset_url to allow PR-only submissions
alter table public.submissions
  alter column asset_url drop not null;

-- Add check: at least one of asset_url or pr_url must be present
alter table public.submissions
  drop constraint if exists submissions_requires_evidence;

alter table public.submissions
  add constraint submissions_requires_evidence
  check (asset_url is not null or pr_url is not null);

-- --------------------------------------------------------------------------
-- 2. submit_task_atomic RPC
-- Atomically transitions task claimed → submitted → under_review
-- Returns result code + new submission id.
-- --------------------------------------------------------------------------
create or replace function public.submit_task_atomic(
  p_task_id        uuid,
  p_contributor_id uuid,
  p_asset_url      text    default null,
  p_pr_url         text    default null,
  p_pr_diff_url    text    default null,
  p_pr_files       jsonb   default null,
  p_notes          text    default null
)
returns jsonb   -- { result: text, submission_id: uuid }
language plpgsql
security definer
as $$
declare
  v_task       record;
  v_revision   integer;
  v_sub_id     uuid;
begin
  -- Guard: at least one evidence field required
  if p_asset_url is null and p_pr_url is null then
    return jsonb_build_object('result', 'no_evidence');
  end if;

  -- Lock row (non-blocking — if another session is mutating, we get 'race')
  select id, status, claimed_by, project_id
    into v_task
    from public.tasks
   where id = p_task_id
     for update skip locked;

  if not found then
    if exists (select 1 from public.tasks where id = p_task_id) then
      return jsonb_build_object('result', 'race');
    end if;
    return jsonb_build_object('result', 'not_found');
  end if;

  -- Ownership gate
  if v_task.claimed_by <> p_contributor_id then
    return jsonb_build_object('result', 'not_assignee');
  end if;

  -- Status gate: allow claimed or revision_requested
  if v_task.status not in ('claimed', 'revision_requested') then
    return jsonb_build_object('result', 'invalid_status', 'current_status', v_task.status);
  end if;

  -- Compute next revision number
  select coalesce(max(revision_number), 0) + 1
    into v_revision
    from public.submissions
   where task_id = p_task_id;

  -- Insert submission record
  insert into public.submissions (
    task_id, contributor_id, asset_url, pr_url,
    pr_diff_url, pr_files, notes, revision_number
  ) values (
    p_task_id, p_contributor_id, p_asset_url, p_pr_url,
    p_pr_diff_url, p_pr_files, p_notes, v_revision
  )
  returning id into v_sub_id;

  -- Advance task status
  update public.tasks
     set status       = 'under_review',
         submitted_at = now(),
         updated_at   = now()
   where id = p_task_id;

  -- Audit log
  insert into public.audit_log (actor_id, task_id, action, payload)
  values (
    p_contributor_id, p_task_id, 'submitted',
    jsonb_build_object(
      'submission_id', v_sub_id,
      'revision',      v_revision,
      'has_asset',     p_asset_url is not null,
      'has_pr',        p_pr_url is not null
    )
  );

  -- Notify host
  insert into public.notifications (user_id, type, task_id)
  select host_id, 'submission_received', p_task_id
    from public.projects
   where id = v_task.project_id;

  return jsonb_build_object('result', 'ok', 'submission_id', v_sub_id);
end;
$$;
