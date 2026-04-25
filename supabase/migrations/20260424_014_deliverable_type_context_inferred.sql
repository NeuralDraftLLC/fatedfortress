-- 014 — AI orchestrator context columns on tasks
-- deliverable_type: canonical type label from Asset Scanner / AI output
-- context_snippet: short contextual background for human reviewers
-- inferred_brief: AI-inferred summary of what the task is about

alter table public.tasks
  add column if not exists deliverable_type text,
  add column if not exists context_snippet text,
  add column if not exists inferred_brief text;
