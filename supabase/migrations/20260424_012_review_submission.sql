-- ============================================================================
-- Migration 012: review_submission_atomic RPC + decisions enrichment
--
-- Replaces all three client-side payout.ts decision paths with a single
-- server-side RPC callable only from the review-submission edge function
-- (security definer, no direct client access).
-- ============================================================================

-- --------------------------------------------------------------------------
-- 1. Enrich decisions table
-- --------------------------------------------------------------------------

-- Add verdict column (approve | reject | revision_requested)
alter table public.decisions
  add column if not exists verdict text
    check (verdict in ('approved', 'rejected', 'revision_requested'));

-- Host may override the task payout downward (partial approval)
alter table public.decisions
  add column if not exists payout_override decimal
    check (payout_override is null or payout_override > 0);

-- Stripe artefact IDs stored for audit trail
alter table public.decisions
  add column if not exists stripe_payment_intent_id text,
  add column if not exists stripe_capture_status    text;

-- --------------------------------------------------------------------------
-- 2. Add tasks.reviewed_at if not present (set by RPC on every decision)
-- --------------------------------------------------------------------------
alter table public.tasks
  add column if not exists reviewed_at timestamptz;

-- --------------------------------------------------------------------------
-- 3. review_submission_atomic RPC
--
-- Called exclusively by review-submission edge function (service role).
-- Returns a result code + decision_id so the function can then call
-- stripe-payment and write the Stripe artefacts back.
-- --------------------------------------------------------------------------
create or replace function public.review_submission_atomic(
  p_submission_id   uuid,
  p_host_id         uuid,
  p_verdict         text,          -- 'approved' | 'rejected' | 'revision_requested'
  p_decision_reason text,
  p_review_notes    text    default null,
  p_structured_feedback jsonb default null,
  p_approved_payout decimal default null,
  p_payout_override decimal default null,
  p_revision_deadline timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_submission  record;
  v_task        record;
  v_project     record;
  v_decision_id uuid;
  v_final_payout decimal;
begin
  -- ── Validate verdict ────────────────────────────────────────────────────
  if p_verdict not in ('approved', 'rejected', 'revision_requested') then
    return jsonb_build_object('result', 'invalid_verdict');
  end if;

  -- ── Load submission ──────────────────────────────────────────────────────
  select * into v_submission
    from public.submissions
   where id = p_submission_id;

  if not found then
    return jsonb_build_object('result', 'submission_not_found');
  end if;

  -- ── Lock task row (skip if already locked by another session) ───────────
  select * into v_task
    from public.tasks
   where id = v_submission.task_id
     for update skip locked;

  if not found then
    if exists (select 1 from public.tasks where id = v_submission.task_id) then
      return jsonb_build_object('result', 'race');
    end if;
    return jsonb_build_object('result', 'task_not_found');
  end if;

  -- ── Task must be under_review ────────────────────────────────────────────
  if v_task.status <> 'under_review' then
    return jsonb_build_object(
      'result', 'invalid_task_status',
      'current_status', v_task.status
    );
  end if;

  -- ── Load project + verify host ownership ────────────────────────────────
  select * into v_project
    from public.projects
   where id = v_task.project_id;

  if not found then
    return jsonb_build_object('result', 'project_not_found');
  end if;

  if v_project.host_id <> p_host_id then
    return jsonb_build_object('result', 'not_host');
  end if;

  -- ── Compute final payout (override caps at payout_max) ──────────────────
  v_final_payout := coalesce(
    p_payout_override,
    p_approved_payout,
    v_task.payout_max
  );
  -- Never exceed what was originally promised
  if v_final_payout > v_task.payout_max then
    v_final_payout := v_task.payout_max;
  end if;

  -- ── Insert decision ──────────────────────────────────────────────────────
  insert into public.decisions (
    submission_id,
    host_id,
    verdict,
    decision_reason,
    review_notes,
    structured_feedback,
    approved_payout,
    payout_override,
    revision_deadline
  ) values (
    p_submission_id,
    p_host_id,
    p_verdict,
    p_decision_reason,
    p_review_notes,
    p_structured_feedback,
    case when p_verdict = 'approved' then v_final_payout else null end,
    p_payout_override,
    coalesce(p_revision_deadline,
      case when p_verdict = 'revision_requested'
           then now() + interval '48 hours' end)
  )
  returning id into v_decision_id;

  -- ── Advance task state ───────────────────────────────────────────────────
  case p_verdict
    when 'approved' then
      update public.tasks
         set status         = 'approved',
             approved_payout = v_final_payout,
             reviewed_at    = now(),
             updated_at     = now()
       where id = v_task.id;

    when 'rejected' then
      -- Return task to open pool: clear claim so others can pick it up
      update public.tasks
         set status               = 'open',
             claimed_by           = null,
             claimed_at           = null,
             soft_lock_expires_at = null,
             reviewed_at          = now(),
             updated_at           = now()
       where id = v_task.id;

    when 'revision_requested' then
      update public.tasks
         set status      = 'revision_requested',
             reviewed_at = now(),
             updated_at  = now()
       where id = v_task.id;
  end case;

  -- ── Resolve active review sessions ──────────────────────────────────────
  update public.review_sessions
     set status = 'resolved'
   where task_id = v_task.id
     and status  = 'active';

  -- ── Audit log ────────────────────────────────────────────────────────────
  insert into public.audit_log (actor_id, task_id, action, payload)
  values (
    p_host_id,
    v_task.id,
    case p_verdict
      when 'approved'            then 'approved'
      when 'rejected'            then 'rejected'
      when 'revision_requested'  then 'revision_requested'
    end,
    jsonb_build_object(
      'submission_id',  p_submission_id,
      'decision_id',    v_decision_id,
      'verdict',        p_verdict,
      'decision_reason',p_decision_reason,
      'approved_payout',case when p_verdict = 'approved' then v_final_payout end
    )
  );

  -- ── Notify contributor ───────────────────────────────────────────────────
  insert into public.notifications (user_id, type, task_id)
  values (
    v_submission.contributor_id,
    case p_verdict
      when 'approved'           then 'payment_released'
      when 'rejected'           then 'submission_rejected'
      when 'revision_requested' then 'revision_requested'
    end,
    v_task.id
  );

  return jsonb_build_object(
    'result',          'ok',
    'decision_id',     v_decision_id,
    'contributor_id',  v_submission.contributor_id,
    'task_id',         v_task.id,
    'project_id',      v_project.id,
    'payment_intent_id', v_submission.payment_intent_id,
    'final_payout',    case when p_verdict = 'approved' then v_final_payout else null end
  );
end;
$$;

-- --------------------------------------------------------------------------
-- 4. update_contributor_reputation RPC
-- Updates contributor profile stats after each decision.
-- --------------------------------------------------------------------------
create or replace function public.update_contributor_reputation(
  p_contributor_id uuid,
  p_verdict        text   -- 'approved' | 'rejected' | 'revision_requested'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile record;
  v_alpha   constant float := 0.2;
begin
  select total_submitted, total_approved, total_rejected,
         avg_revision_count, review_reliability, approval_rate
    into v_profile
    from public.profiles
   where id = p_contributor_id
     for update skip locked;

  if not found then return; end if;

  declare
    v_total    integer := coalesce(v_profile.total_submitted, 0) + 1;
    v_approved integer := coalesce(v_profile.total_approved,  0)
                          + case when p_verdict = 'approved' then 1 else 0 end;
    v_rejected integer := coalesce(v_profile.total_rejected,  0)
                          + case when p_verdict = 'rejected'  then 1 else 0 end;
    v_apr      float   := v_approved::float / v_total;
    v_revs     float   := coalesce(v_profile.avg_revision_count, 0);
    v_new_revs float   := case
                            when p_verdict = 'revision_requested'
                            then v_revs * (1 - v_alpha) + (v_revs + 1) * v_alpha
                            else v_revs * (1 - v_alpha)
                          end;
    v_rel      float   := v_apr * (1 - (v_rejected::float / v_total) * 0.5);
  begin
    update public.profiles
       set total_submitted    = v_total,
           total_approved     = v_approved,
           total_rejected     = v_rejected,
           approval_rate      = round(v_apr::numeric,   3),
           avg_revision_count = round(v_new_revs::numeric, 2),
           review_reliability = round(v_rel::numeric,   3),
           updated_at         = now()
     where id = p_contributor_id;
  end;
exception when others then
  -- Non-fatal: reputation update failure must not roll back the decision
  raise warning 'update_contributor_reputation failed for %: %', p_contributor_id, sqlerrm;
end;
$$;
