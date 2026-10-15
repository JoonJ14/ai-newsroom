-- AI Newsroom: Supabase Cron schedules, GitHub Actions executes.
--
-- WHY
--   GitHub's `schedule:` trigger on free public repos creates runs late (by
--   hours) or drops them. The 11:45 AM ET digest was landing between 2:30 and
--   6:00 PM ET. Runs created through the REST API (`workflow_dispatch`) skip
--   that scheduler and start within seconds. So Postgres is now the alarm
--   clock: pg_cron fires, pg_net calls GitHub's dispatch endpoint, and the
--   existing collect.yml / digest.yml run unchanged on GitHub's runners.
--   Full write-up: docs/scheduling.md
--
-- HOW TIMES WORK (DST-proof gating)
--   pg_cron schedules in UTC, but 9:00 AM New York is 13:00 UTC in summer and
--   14:00 UTC in winter. Hard-coding a UTC hour would be wrong half the year.
--   Instead every job runs HOURLY and gates itself on the New York local hour
--   (private.ny_hour_in). Off-hours the job does nothing.
--
--   ONE number sets the schedule: private.digest_hour_ny() (currently 9).
--     digest  -> :00 of that hour
--     alarm   -> :30 of that hour (30 min after the digest)
--     collect -> :30 of the hour BEFORE, and every 6 h from there
--                (2:30, 8:30, 14:30, 20:30 for a 9:00 digest), so the
--                digest always sees overnight news
--   If you change the digest time, change only that function. The alarm MUST
--   stay ~30 minutes after the digest; deriving it from the same number is
--   what guarantees that. Do not give the alarm its own hard-coded hour.
--
--   DST edge: on the spring-forward day the 2:00 AM local hour does not exist,
--   and on fall-back the 1:00 AM hour happens twice. A digest at 1 would go
--   out twice that night and a digest at 2 would be skipped, so
--   digest_hour_ny() refuses both (it raises, and the migration checks it on
--   every run). The 2:30 collect is still skipped once a year on spring-forward,
--   which is harmless.
--
-- SECRETS
--   Read at call time from Supabase Vault. Create them in the dashboard
--   (Integrations -> Vault) BEFORE running this file. Never put them here.
--     github_dispatch_token  fine-grained PAT, this repo only, Actions: read/write
--     discord_webhook_url    the same webhook the digest posts to
--
-- SECURITY
--   Everything lives in the `private` schema, which PostgREST does not expose,
--   and EXECUTE / USAGE is revoked from public, anon and authenticated. A
--   function in `public` would be an RPC endpoint anyone with the anon key
--   could call to trigger workflow runs.
--
-- RE-RUNNING
--   The whole file is meant to re-run cleanly: pg_cron's one-time setup is
--   skipped once the extension exists (section 1), functions use CREATE OR
--   REPLACE, and cron.schedule() with an existing job name overwrites that
--   job (upsert) rather than adding a duplicate. Still, after the first run,
--   apply a later change by running only the statements that changed (one
--   function, or one cron.schedule call). See docs/scheduling.md.

-- ---------------------------------------------------------------------------
-- 1. Extensions (as documented at supabase.com/docs/guides/cron/install and
--    supabase.com/docs/guides/database/extensions/pg_net)
--
--    pg_cron's setup runs only when the extension is missing. Once pg_cron
--    exists, re-running the `create extension` and the two grants trips
--    Supabase's own pg_cron access hook with "dependent privileges exist",
--    which aborted the whole file on a second run. Supabase's install docs
--    still list both grants for a fresh install, so they stay, guarded.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    create extension pg_cron with schema pg_catalog;
    grant usage on schema cron to postgres;
    grant all privileges on all tables in schema cron to postgres;
  end if;
end
$$;

-- pg_net registers in `extensions` but creates and uses its own `net` schema.
create extension if not exists pg_net with schema extensions;

-- ---------------------------------------------------------------------------
-- 2. Private schema
-- ---------------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Time helpers — the single place to change schedule times
-- ---------------------------------------------------------------------------

-- The digest's New York local hour (0-23). Collect and alarm derive from it.
-- Not 1 or 2: those hours repeat or vanish on DST changes (see header).
create or replace function private.digest_hour_ny()
returns integer
language plpgsql
stable
set search_path = ''
as $$
declare
  h constant integer := 9;   -- <- change this number to move the schedule
begin
  if h not between 0 and 23 or h in (1, 2) then
    raise exception 'digest_hour_ny: % is not allowed (use 0 or 3-23; 1 and 2 break on DST changes)', h;
  end if;
  return h;
end;
$$;

-- Fail the migration now rather than at the first cron run if the hour is bad.
do $$ begin perform private.digest_hour_ny(); end $$;

-- True when the current New York local hour is one of target_hours.
create or replace function private.ny_hour_in(variadic target_hours integer[])
returns boolean
language sql
stable
set search_path = ''
as $$
  select extract(hour from now() at time zone 'America/New_York')::integer
         = any(target_hours)
$$;

-- Collect hours: the hour before the digest, then every 6 hours.
create or replace function private.collect_hours_ny()
returns integer[]
language sql
stable
set search_path = ''
as $$
  select array_agg(((private.digest_hour_ny() - 1 + 6 * k) % 24 + 24) % 24 order by k)
  from generate_series(0, 3) as k
$$;

-- ---------------------------------------------------------------------------
-- 4. Dispatch a GitHub Actions workflow on main
-- ---------------------------------------------------------------------------
create or replace function private.dispatch_workflow(workflow_file text)
returns bigint
language plpgsql
set search_path = ''
as $$
declare
  token text;
begin
  if workflow_file !~ '^[A-Za-z0-9_.-]+\.ya?ml$' then
    raise exception 'dispatch_workflow: invalid workflow file name %', workflow_file;
  end if;

  select decrypted_secret into token
  from vault.decrypted_secrets
  where name = 'github_dispatch_token';

  if token is null or token = '' then
    raise exception 'dispatch_workflow: Vault secret github_dispatch_token is missing';
  end if;

  -- Asynchronous: returns a request id. The HTTP status lands in
  -- net._http_response (204 = dispatched).
  return net.http_post(
    url := 'https://api.github.com/repos/JoonJ14/ai-newsroom/actions/workflows/'
           || workflow_file || '/dispatches',
    body := jsonb_build_object('ref', 'main'),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || token,
      'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28',
      'Content-Type', 'application/json',
      -- GitHub rejects API requests that carry no User-Agent.
      'User-Agent', 'ai-newsroom-scheduler'
    ),
    timeout_milliseconds := 10000
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Missed-digest alarm
--    The digest upserts digest_state('last_digest_at') on every successful run,
--    quiet days included (saveLastDigestTime in src/digest/generate.ts). If that
--    row is missing or older than 60 minutes 30 minutes after dispatch, warn.
-- ---------------------------------------------------------------------------
create or replace function private.check_digest_sent()
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  last_sent timestamptz;
  webhook text;
begin
  select updated_at into last_sent
  from public.digest_state
  where key = 'last_digest_at';

  if last_sent is not null and last_sent > now() - interval '60 minutes' then
    return true;
  end if;

  select decrypted_secret into webhook
  from vault.decrypted_secrets
  where name = 'discord_webhook_url';

  if webhook is null or webhook = '' then
    raise exception 'check_digest_sent: digest missing AND Vault secret discord_webhook_url is missing';
  end if;

  perform net.http_post(
    url := webhook,
    body := jsonb_build_object('content',
      E':warning: **AI Newsroom: today''s digest did not go out.**\n'
      || 'Last successful digest: ' || coalesce(last_sent::text, 'never recorded') || E'\n\n'
      || E'Likely causes:\n'
      || E'- Expired or revoked GitHub token (dispatch returned 401/403)\n'
      || E'- A GitHub incident (githubstatus.com)\n'
      || E'- The digest job ran but failed\n\n'
      || E'Where to look:\n'
      || E'- Actions tab: https://github.com/JoonJ14/ai-newsroom/actions\n'
      || E'- Supabase SQL Editor: `select * from net._http_response order by created desc limit 10;`\n'
      || '  (pg_net keeps responses for only ~6 hours, so check soon)'
    ),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'User-Agent', 'ai-newsroom-scheduler'
    ),
    timeout_milliseconds := 10000
  );

  return false;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Lock the functions down. Postgres grants EXECUTE to PUBLIC by default.
-- ---------------------------------------------------------------------------
revoke all on function private.digest_hour_ny()              from public, anon, authenticated;
revoke all on function private.ny_hour_in(integer[])         from public, anon, authenticated;
revoke all on function private.collect_hours_ny()            from public, anon, authenticated;
revoke all on function private.dispatch_workflow(text)       from public, anon, authenticated;
revoke all on function private.check_digest_sent()           from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Cron jobs (named, so re-running overwrites instead of duplicating)
-- ---------------------------------------------------------------------------
select cron.schedule(
  'newsroom-collect',
  '30 * * * *',
  $$ select private.dispatch_workflow('collect.yml')
     where private.ny_hour_in(variadic private.collect_hours_ny()) $$
);

select cron.schedule(
  'newsroom-digest',
  '0 * * * *',
  $$ select private.dispatch_workflow('digest.yml')
     where private.ny_hour_in(private.digest_hour_ny()) $$
);

select cron.schedule(
  'newsroom-digest-check',
  '30 * * * *',
  $$ select private.check_digest_sent()
     where private.ny_hour_in(private.digest_hour_ny()) $$
);

-- Hourly jobs write ~72 rows/day to cron.job_run_details, which pg_cron never
-- prunes on its own. Weekly, Sundays 03:15 UTC. Only the newsroom-* jobs'
-- history is touched; other cron jobs in the project keep theirs.
select cron.schedule(
  'newsroom-cron-log-cleanup',
  '15 3 * * 0',
  $$ delete from cron.job_run_details
     where jobid in (select jobid from cron.job where jobname like 'newsroom-%')
       and coalesce(end_time, start_time) < now() - interval '14 days' $$
);
