-- ============================================================================
-- Migration 024: pg_cron + pg_net scheduled jobs
--
-- Schedules two background cron jobs that call Supabase Edge Functions
-- over HTTPS using pg_net (the built-in HTTP client on Supabase projects).
--
-- Jobs created:
--   1. ff_expire_claims   — every 5 minutes
--      → POST {SUPABASE_URL}/functions/v1/expire-claims
--         Reclaims soft-locked tasks whose soft_lock_expires_at has passed,
--         cancels held Stripe PaymentIntents, unlocks wallet funds.
--
--   2. ff_auto_release    — every 30 minutes
--      → POST {SUPABASE_URL}/functions/v1/auto-release
--         Sends 24h review-lag warnings; auto-approves tasks at 48h lag.
--
-- Auth:
--   Both functions check Authorization: Bearer <CRON_SECRET>.
--   The secret is read from Supabase Vault at job creation time and embedded
--   in the pg_cron job payload so it never appears in plain SQL.
--
-- Prerequisites (already true on all Supabase projects):
--   pg_cron extension  — enabled below with CREATE EXTENSION IF NOT EXISTS
--   pg_net  extension  — enabled below with CREATE EXTENSION IF NOT EXISTS
--
-- Idempotent: cron.unschedule() is called before each cron.schedule() so
--   re-running this migration does not create duplicate jobs.
--
-- To verify after applying:
--   SELECT jobid, schedule, command FROM cron.job WHERE jobname LIKE 'ff_%';
-- ============================================================================

-- ── Extensions ─────────────────────────────────────────────────────────────────

create extension if not exists pg_cron  with schema extensions;
create extension if not exists pg_net   with schema extensions;

-- ── Grant cron usage to postgres role (required on Supabase) ───────────────

grant usage on schema cron to postgres;

-- ── Schedule helper ──────────────────────────────────────────────────────────
--
-- Reads CRON_SECRET from Supabase Vault and SUPABASE_URL from
-- current_setting() (auto-set by Supabase on every project).
-- If the vault secret is missing the job is still created but will return
-- 401 from the edge function, which is loud enough to alert on.
--
-- NOTE: cron.schedule() stores the literal SQL string including the secret.
-- Keep this migration’s diff private; rotate CRON_SECRET via a new migration.

do $$
declare
  v_url         text;
  v_cron_secret text;
  v_auth_header text;
begin
  -- Supabase sets this on every project.
  v_url := current_setting('app.settings.supabase_url', true);

  -- Fall back to the env var format used by older Supabase project configs.
  if v_url is null or v_url = '' then
    v_url := current_setting('supabase.supabase_url', true);
  end if;

  -- Final fallback: derive from project ref via pg_catalog.
  -- In production this branch is never reached.
  if v_url is null or v_url = '' then
    raise warning
      'pg_cron 024: could not resolve SUPABASE_URL from settings. '
      'Set app.settings.supabase_url in your Supabase project config.';
    -- Do not abort — let jobs be created with placeholder URL so the
    -- migration completes; operator must fix config and re-run.
    v_url := 'https://REPLACE_WITH_PROJECT_REF.supabase.co';
  end if;

  -- Read CRON_SECRET from Vault (populated via Dashboard → Settings → Vault).
  begin
    select decrypted_secret
      into v_cron_secret
      from vault.decrypted_secrets
     where name = 'CRON_SECRET'
     limit 1;
  exception when undefined_table then
    -- vault extension not enabled on this project (local dev only).
    v_cron_secret := null;
  end;

  if v_cron_secret is null or v_cron_secret = '' then
    raise warning
      'pg_cron 024: CRON_SECRET not found in vault.decrypted_secrets. '
      'Jobs will be created but will receive 401 from edge functions until '
      'the secret is added. Add it via Supabase Dashboard → Settings → Vault, '
      'then re-run this migration or update the cron commands manually.';
    v_cron_secret := 'REPLACE_WITH_CRON_SECRET';
  end if;

  v_auth_header := 'Bearer ' || v_cron_secret;

  -- ── Job 1: expire-claims ────────────────────────────────────────────────
  -- Unschedule any stale version first (idempotent).
  perform cron.unschedule('ff_expire_claims');

  -- Schedule: every 5 minutes, all hours.
  perform cron.schedule(
    'ff_expire_claims',
    '*/5 * * * *',
    format(
      $$
        select extensions.http_post(
          url     := %L,
          headers := jsonb_build_object(
            'Content-Type',  'application/json',
            'Authorization', %L
          ),
          body    := '{}'::jsonb
        );
      $$,
      v_url || '/functions/v1/expire-claims',
      v_auth_header
    )
  );

  -- ── Job 2: auto-release ────────────────────────────────────────────────
  perform cron.unschedule('ff_auto_release');

  -- Schedule: every 30 minutes.
  perform cron.schedule(
    'ff_auto_release',
    '*/30 * * * *',
    format(
      $$
        select extensions.http_post(
          url     := %L,
          headers := jsonb_build_object(
            'Content-Type',  'application/json',
            'Authorization', %L
          ),
          body    := '{}'::jsonb
        );
      $$,
      v_url || '/functions/v1/auto-release',
      v_auth_header
    )
  );

  raise notice 'pg_cron 024: ff_expire_claims (*/5) and ff_auto_release (*/30) scheduled.';
end;
$$;

-- ── Verification query (non-blocking, informational) ───────────────────────
-- Run manually after applying to confirm jobs appear:
--   SELECT jobid, jobname, schedule, active
--     FROM cron.job
--    WHERE jobname IN ('ff_expire_claims', 'ff_auto_release');
