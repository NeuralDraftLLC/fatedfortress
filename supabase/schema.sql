-- FatedFortress Schema — Post-Refactor v1
-- Sacred objects: Task, Submission, Decision
-- System of record: Supabase
-- apply: supabase/migrations/20250421_post_refactor_v1.sql first

-- ============================================================================
-- PROFILES (extends auth.users)
-- ============================================================================
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  role text not null check (role in ('host', 'contributor')) default 'contributor',
  github_username text,
  avatar_url text,

  -- review_reliability signals
  review_reliability decimal default 0,
  approval_rate      decimal default 0,
  avg_revision_count decimal default 0,
  avg_response_time_minutes integer default 0,
  total_approved  integer default 0,
  total_submitted integer default 0,
  total_rejected  integer default 0,

  created_at timestamptz default now() not null
);

alter table public.profiles enable row level security;

create policy "Profiles are viewable by everyone"
  on public.profiles for select using (true);

create policy "Users can update own profile"
  on public.profiles for update using (auth.uid() = id);

create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)));
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ============================================================================
-- PROJECT_TEMPLATES (stub — FK from projects.template_id)
-- ============================================================================
create table if not exists public.project_templates (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  created_at timestamptz default now() not null
);

alter table public.project_templates enable row level security;

create policy "Project templates viewable by all"
  on public.project_templates for select using (true);

create policy "Hosts can manage templates"
  on public.project_templates for all
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'host'));

-- ============================================================================
-- PROJECTS (host creates a brief)
-- ============================================================================
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references public.profiles(id) on delete cascade,
  title text not null default '',
  description text,
  references_urls text[] default '{}',
  template_id uuid references public.project_templates(id),
  -- blueprint artifacts (from SCOPE)
  readme_draft text,
  folder_structure text[],
  status text not null default 'draft'
    check (status in ('draft', 'active', 'completed')) default 'draft',

  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

alter table public.projects enable row level security;

create policy "Projects are viewable by host and invitees"
  on public.projects for select
  using (auth.uid() = host_id);

create policy "Hosts can create projects"
  on public.projects for insert
  with check (auth.uid() = host_id);

create policy "Hosts can update own projects"
  on public.projects for update
  using (auth.uid() = host_id);

-- ============================================================================
-- PROJECT_WALLET (replaces budget_reserved; available = deposited - locked - released)
-- ============================================================================
create table if not exists public.project_wallet (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  deposited decimal not null default 0,
  locked decimal not null default 0,
  released decimal not null default 0,
  created_at timestamptz not null default now()
);

alter table public.project_wallet enable row level security;

create unique index if not exists idx_project_wallet_project_id
  on public.project_wallet(project_id);

create policy "Wallet viewable by host and active contributors"
  on public.project_wallet for select
  using (
    auth.uid() = (select host_id from public.projects where id = project_id)
    or exists (select 1 from public.tasks t where t.project_id = project_id and t.claimed_by = auth.uid())
  );

create policy "Hosts can manage wallet"
  on public.project_wallet for all
  using (auth.uid() = (select host_id from public.projects where id = project_id));

-- ============================================================================
-- TASKS (AI-generated from project brief via SCOPE_PROJECT)
-- ============================================================================
create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,

  title text not null default '',
  description text,
  payout_min decimal not null default 0,
  payout_max decimal not null default 0,
  approved_payout decimal,                       -- denorm cache; source of truth is decisions.approved_payout
  ambiguity_score decimal,
  estimated_minutes integer,

  task_access text not null default 'invite'
    check (task_access in ('invite', 'public')) default 'invite',

  -- Task state machine:
  -- draft → open → claimed → submitted → under_review
  -- → revision_requested → approved/rejected → paid/expired
  status text not null default 'draft'
    check (status in (
      'draft', 'open', 'claimed', 'submitted', 'under_review',
      'revision_requested', 'approved', 'rejected', 'paid', 'expired'
    )) default 'draft',

  claimed_by uuid references public.profiles(id),
  claimed_at timestamptz,
  soft_lock_expires_at timestamptz,             -- 24h ownership window
  submitted_at timestamptz,
  reviewed_at timestamptz,

  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

alter table public.tasks enable row level security;

-- Task visibility: host, contributor, or public
-- Invitation check is enforced at query/app level for invite-only tasks
create policy "Tasks viewable by host and contributors"
  on public.tasks for select
  using (
    auth.uid() = (select host_id from public.projects where id = project_id)
    or claimed_by = auth.uid()
    or task_access = 'public'
  );

create policy "Hosts can create tasks"
  on public.tasks for insert
  with check (
    auth.uid() = (select host_id from public.projects where id = project_id)
  );

create policy "Hosts can update tasks"
  on public.tasks for update
  using (
    auth.uid() = (select host_id from public.projects where id = project_id)
  );

-- ============================================================================
-- INVITATIONS
-- ============================================================================
create table if not exists public.invitations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  task_id uuid references public.tasks(id) on delete cascade,
  invited_email text,
  invited_user_id uuid references public.profiles(id) on delete set null,
  token text not null unique,
  accepted_at timestamptz,
  expires_at timestamptz not null default now() + interval '7 days',
  created_at timestamptz not null default now()
);

alter table public.invitations enable row level security;

create policy "Invitations viewable by host and invitee"
  on public.invitations for select
  using (
    auth.uid() = invited_user_id
    or auth.uid() = (select host_id from public.projects where id = project_id)
  );

create policy "Hosts can create invitations"
  on public.invitations for insert
  with check (
    auth.uid() = (select host_id from public.projects where id = project_id)
    or (
      task_id is not null
      and auth.uid() = (select host_id from public.projects where id = (select project_id from public.tasks where id = task_id))
    )
  );

create policy "Invitees can accept invitations"
  on public.invitations for update
  using (auth.uid() = invited_user_id);

create index if not exists idx_invitations_task_id on public.invitations(task_id);
create index if not exists idx_invitations_token on public.invitations(token);
create index if not exists idx_invitations_invited_user_id on public.invitations(invited_user_id) where accepted_at is null;

-- ============================================================================
-- SUBMISSIONS (artifact submitted per revision cycle)
-- Submission = the uploaded deliverable + metadata; owned by a task
-- decision_reason / review_notes moved to decisions table
-- ============================================================================
create table if not exists public.submissions (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  contributor_id uuid not null references public.profiles(id),

  asset_url text not null,
  deliverable_type text
    check (deliverable_type in (
      'file', 'pr', 'code_patch', 'design_asset', 'text',
      'audio', 'video', '3d_model', 'figma_link'
    )),
  ai_summary text,
  revision_number integer not null default 1,

  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

alter table public.submissions enable row level security;

-- One active (non-paid/non-rejected) submission per task
create unique index if not exists idx_submissions_one_active_per_task
  on public.submissions(task_id)
  where status not in ('paid', 'rejected');

create policy "Submissions viewable by task participants"
  on public.submissions for select
  using (
    auth.uid() = contributor_id
    or auth.uid() = (select claimed_by from public.tasks where id = task_id)
    or auth.uid() = (select host_id from public.projects where id = (select project_id from public.tasks where id = task_id))
  );

create policy "Contributors can create submissions"
  on public.submissions for insert
  with check (auth.uid() = contributor_id);

create policy "Hosts can update submissions"
  on public.submissions for update
  using (
    auth.uid() = (select host_id from public.projects where id = (select project_id from public.tasks where id = task_id))
  );

-- ============================================================================
-- DECISIONS (authoritative record for every host review action)
-- Stripe source of truth: decisions.approved_payout
-- ============================================================================
create table if not exists public.decisions (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.submissions(id) on delete cascade,
  host_id uuid not null references public.profiles(id),
  decision_reason text not null
    check (decision_reason in (
      'requirements_not_met', 'quality_issue', 'scope_mismatch',
      'missing_files', 'great_work', 'approved_fast_track'
    )),
  review_notes text,
  structured_feedback jsonb,
  approved_payout decimal,
  revision_deadline timestamptz,
  created_at timestamptz not null default now()
);

alter table public.decisions enable row level security;

create policy "Decisions viewable by task participants"
  on public.decisions for select
  using (
    auth.uid() = host_id
    or auth.uid() = (select contributor_id from public.submissions where id = submission_id)
    or auth.uid() = (select claimed_by from public.tasks where id = (select task_id from public.submissions where id = submission_id))
  );

create policy "Hosts can insert decisions"
  on public.decisions for insert
  with check (auth.uid() = host_id);

create index if not exists idx_decisions_submission_id on public.decisions(submission_id);
create index if not exists idx_decisions_host_id on public.decisions(host_id);

-- ============================================================================
-- REVIEW_SESSIONS (Y.js collab scoped to active review)
-- ============================================================================
create table if not exists public.review_sessions (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  submission_id uuid not null references public.submissions(id) on delete cascade,
  host_id uuid not null references public.profiles(id),
  contributor_id uuid references public.profiles(id),
  ydoc_id text,
  status text not null default 'active'
    check (status in ('active', 'resolved', 'archived')) default 'active',

  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

alter table public.review_sessions enable row level security;

create policy "Review session participants can view"
  on public.review_sessions for select
  using (
    auth.uid() = host_id
    or auth.uid() = contributor_id
  );

create policy "Hosts can create review sessions"
  on public.review_sessions for insert
  with check (auth.uid() = host_id);

create policy "Hosts can update review sessions"
  on public.review_sessions for update
  using (auth.uid() = host_id);

-- ============================================================================
-- NOTIFICATIONS
-- ============================================================================
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  type text not null
    check (type in (
      'task_claimed',
      'submission_received',
      'revision_requested',
      'payment_released',
      'submission_rejected',
      'claim_expired',
      'verification_failed',
      'auto_release_warning',
      'auto_released'
    )),
  task_id uuid references public.tasks(id) on delete set null,
  read boolean not null default false,

  created_at timestamptz default now() not null
);

alter table public.notifications enable row level security;

create policy "Users can view own notifications"
  on public.notifications for select
  using (auth.uid() = user_id);

create policy "Users can update own notifications"
  on public.notifications for update
  using (auth.uid() = user_id);

-- ============================================================================
-- AUDIT_LOG
-- ============================================================================
create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id) on delete set null,
  task_id uuid references public.tasks(id) on delete set null,
  action text not null
    check (action in (
      'claimed',
      'submitted',
      'approved',
      'rejected',
      'payment_released',
      'revision_requested',
      'task_created',
      'task_published',
      'verification_failed',
      'auto_released',
      'claim_expired'
    )),
  payload jsonb default '{}',

  created_at timestamptz default now() not null
);

alter table public.audit_log enable row level security;

create policy "Audit log is viewable by task participants"
  on public.audit_log for select
  using (
    actor_id = auth.uid()
    or auth.uid() = (select host_id from public.projects where id = (select project_id from public.tasks where id = task_id))
    or auth.uid() = (select claimed_by from public.tasks where id = task_id)
  );

create policy "System can insert audit log entries"
  on public.audit_log for insert
  with check (true);

-- ============================================================================
-- INDEXES
-- ============================================================================
create index if not exists idx_tasks_project_id   on public.tasks(project_id);
create index if not exists idx_tasks_status        on public.tasks(status);
create index if not exists idx_tasks_claimed_by   on public.tasks(claimed_by);
create index if not exists idx_tasks_host_id       on public.tasks((select host_id from public.projects where id = project_id));
create index if not exists idx_submissions_task_id on public.submissions(task_id);
create index if not exists idx_submissions_contributor_id on public.submissions(contributor_id);
create index if not exists idx_notifications_user_id on public.notifications(user_id);
create index if not exists idx_notifications_read on public.notifications(user_id, read) where read = false;
create index if not exists idx_audit_log_task_id on public.audit_log(task_id);
create index if not exists idx_review_sessions_task_id on public.review_sessions(task_id);
