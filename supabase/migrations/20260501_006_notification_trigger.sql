-- 006 — Notification trigger migration (from Supabase cron / pg_cron to Resend webhooks)
--
-- This migration adds an optional notification_trigger column to profiles
-- so hosts can specify a webhook URL to receive notification events instead of
-- polling the notifications table.
--
-- The auto-release and expire-claims edge functions will POST to this URL
-- when new notifications are inserted, enabling real-time webhook delivery.
--
-- Supported trigger types:
--   - auto_release_warning: 24h review deadline approaching
--   - auto_released: task auto-released after 48h
--   - claim_expired: contributor soft-lock expired
--   - submission_received: new submission ready for review

alter table public.profiles
  add column if not exists notification_trigger_url text;

alter table public.profiles
  add column if not exists notification_trigger_enabled boolean default false;

comment on column public.profiles.notification_trigger_url is
  'Optional webhook URL for real-time notification delivery (Resend webhook or custom endpoint)';

comment on column public.profiles.notification_trigger_enabled is
  'When true, edge functions will POST notification payloads to notification_trigger_url';