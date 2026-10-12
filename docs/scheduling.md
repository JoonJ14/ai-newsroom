# Scheduling: Supabase Cron starts the runs, GitHub Actions does the work

As of October 2026, `collect.yml` and `digest.yml` are **not** started by GitHub's
`schedule:` trigger. Supabase Cron (`pg_cron` + `pg_net`) calls GitHub's REST API at
fixed New York times and dispatches them. The code, the runners, the logs and
merge-to-main-is-deploy are all unchanged.

The SQL is in [`supabase/migrations/003_schedule_triggers.sql`](../supabase/migrations/003_schedule_triggers.sql).

## Why

The digest was scheduled for 15:45 UTC (11:45 AM ET). It was landing between
**2:30 PM and 6:00 PM ET**, so 3 to 6 hours late, and the delays were getting
worse.

The delay happens before the job starts, not while it runs. A GitHub Actions run
goes through two systems:

1. **The scheduler** decides it is time and creates the run. On free public repos,
   GitHub runs the `schedule:` trigger on a best-effort basis: under load it
   creates runs late, sometimes by hours, or skips them.
2. **The runner** picks the run up and executes it. This part has always been
   fast.

A run created through the API (`workflow_dispatch`) skips step 1 entirely and
starts within seconds. So we keep GitHub's runners and stop relying on GitHub's
clock.

This is the deliberately **tactical** fix. Moving collectors and digest
entirely into Supabase Edge Functions is still on the table. It's deferred, not
rejected. See the roadmap in the [README](../README.md#status--roadmap).

## How it works

```
pg_cron (hourly, UTC)
   │
   ▼
Eastern-time gate: is it the right hour in America/New_York?
   │  no → do nothing
   │  yes
   ▼
pg_net: POST https://api.github.com/repos/JoonJ14/ai-newsroom/actions/workflows/<file>/dispatches
        body {"ref":"main"}, token read from Vault at call time
   │
   ▼
GitHub workflow_dispatch → the normal Actions run (logs in the Actions tab)
```

**Why hourly plus a gate.** pg_cron schedules in UTC, but 9:00 AM New York is
13:00 UTC in summer and 14:00 UTC in winter. Each job runs every hour and checks
`extract(hour from now() at time zone 'America/New_York')`. It dispatches only
when that hour is its target, so daylight-saving changes need no edits.

| Job | pg_cron schedule | Acts when NY local time is | Action |
|---|---|---|---|
| `newsroom-collect` | `30 * * * *` | 2:30, 8:30, 14:30, 20:30 | dispatch `collect.yml` |
| `newsroom-digest` | `0 * * * *` | 9:00 | dispatch `digest.yml` |
| `newsroom-digest-check` | `30 * * * *` | 9:30 | missed-digest alarm |
| `newsroom-cron-log-cleanup` | `15 3 * * 0` (weekly) | any | prune `cron.job_run_details` older than 14 days |

The 8:30 collect is there so the 9:00 digest always sees overnight news.

**Missed-digest alarm.** Every successful digest run, including a "quiet day"
empty digest, upserts `digest_state.last_digest_at`. At 9:30 the alarm checks
that row. If it's missing or more than 60 minutes old, the alarm posts a warning
to the Discord webhook with likely causes and where to look.

**Security.** All functions live in a `private` schema with EXECUTE and USAGE
revoked from `public`, `anon` and `authenticated`. A function in `public` would
be exposed by PostgREST as an RPC endpoint, so anyone holding the (public) anon
key could trigger workflow runs.

**DST edge cases.** On the spring-forward night the 2:00 AM hour doesn't exist,
so the 2:30 collect is skipped once a year. On the fall-back night 1:00 AM
repeats, and nothing is scheduled then. The 9:00 digest is never affected.

## Setup, in order

### 1. Create the GitHub token

GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained
tokens** → Generate new token.

- **Repository access:** Only select repositories → `ai-newsroom`
- **Permissions → Repository → Actions:** Read and write
- Nothing else. Pick an expiry and **put a renewal reminder in your calendar**.

Copy the token. GitHub shows it only once.

### 2. Add both secrets to Supabase Vault

Use the dashboard's **Vault** page (Integrations → Vault; search "Vault" if the
dashboard has moved it). **Don't** use the SQL Editor for this: queries there
are saved in history, and the token would end up stored in plain text.

| Secret name | Value |
|---|---|
| `github_dispatch_token` | the token from step 1 |
| `discord_webhook_url` | the webhook URL the digest posts to |

The names must match exactly. The SQL looks them up by name.

**Getting the Discord webhook URL.** GitHub secrets can't be read back, so copy
the URL from Discord again: open the digest channel's **Edit Channel** (gear
icon) → **Integrations** → **Webhooks** → click the webhook the digest uses →
**Copy Webhook URL**. Copy the existing webhook. If you create a new one, the
alarm will post to a different place than the digest. Don't click "Delete" or
regenerate it either: that would break the `DISCORD_WEBHOOK_URL` GitHub secret.

### 3. Merge the PR

This comments out the `schedule:` blocks. From the moment it merges until step 4
is done, **nothing runs automatically**. Do step 4 right away.

### 4. Run migration 003

Open the Supabase SQL Editor, paste the whole of
`supabase/migrations/003_schedule_triggers.sql`, and run it. It's safe to re-run:
extensions use `if not exists`, functions use `create or replace`, and named
cron jobs are overwritten, not duplicated.

### 5. Verify

```sql
-- The four jobs should be listed and active.
select jobid, jobname, schedule, active from cron.job where jobname like 'newsroom-%';

-- Recent runs. Most hourly runs succeed while doing nothing (gate closed).
select j.jobname, d.status, d.return_message, d.start_time
from cron.job_run_details d join cron.job j using (jobid)
order by d.start_time desc limit 20;

-- Manual test dispatch. Use COLLECT, not digest, so no extra digest is sent.
select private.dispatch_workflow('collect.yml');

-- A few seconds later: the HTTP status from GitHub. 204 = success.
select id, status_code, content, error_msg, created
from net._http_response order by created desc limit 5;
```

Then check the **Actions** tab. A "Collect AI News" run triggered by
`workflow_dispatch` should appear within about a minute.

If the status is not 204:

| Status | Meaning |
|---|---|
| 401 | Token wrong, expired or revoked |
| 403 | Token lacks Actions: write, or isn't scoped to this repo |
| 404 | Wrong repo or workflow filename, or the token can't see the repo |
| 422 | `ref` problem, or the workflow has no `workflow_dispatch` trigger |

`net._http_response` keeps rows for only about 6 hours, so check soon after a
failure.

## Changing the digest time

Change **one number**: the `select 9` in `private.digest_hour_ny()` in migration
003 (a New York local hour, 0–23). Then re-run the migration, or just that
`create or replace function` statement.

The other times derive from it, so they move together:

- The alarm runs at :30 of the digest hour, so it stays 30 minutes after the
  digest. It must stay about that far behind. Don't give it its own hour.
- The collect runs at :30 of the hour before the digest, then every 6 hours.

Update this doc and the README if you change it.

## Renewing the token

Fine-grained tokens expire. When yours is close:

1. Generate a new token with the same settings (step 1). Or use **Regenerate
   token** on the existing one.
2. In the dashboard's Vault page, edit `github_dispatch_token` and paste the new
   value. Again, not through the SQL Editor.
3. Run `select private.dispatch_workflow('collect.yml');` and confirm a 204 in
   `net._http_response`, plus a new run in the Actions tab.

If you forget, dispatches start returning 401. At 9:30 the alarm posts to
Discord that the digest didn't go out. That alarm is the safety net, not the
plan.

## Rolling back to GitHub's scheduler

1. In `.github/workflows/collect.yml` and `digest.yml`, uncomment the
   `schedule:` block (via a PR, since `main` is protected).
2. Stop the Supabase jobs so the workflows aren't started twice:

   ```sql
   select cron.unschedule('newsroom-collect');
   select cron.unschedule('newsroom-digest');
   select cron.unschedule('newsroom-digest-check');
   select cron.unschedule('newsroom-cron-log-cleanup');
   ```

The functions in `private` can stay. They do nothing unless called.

## Heartbeat: kept for now

`heartbeat.yml` exists because GitHub disables scheduled workflows after 60 days
of repository inactivity. That rule is believed to target workflows with a
`schedule:` trigger. With those blocks commented out, `collect.yml` and
`digest.yml` may no longer be at risk, and the heartbeat may be unnecessary.
That hasn't been confirmed, so the heartbeat stays unchanged until it is. It's
cheap, and it also re-enables the workflows if they were ever disabled.
