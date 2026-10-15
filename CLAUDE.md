# AI Newsroom - Project Context

## What This Project Is
AI Newsroom is an open-source, real-time AI/tech news aggregator exposed as an MCP (Model Context Protocol) server. It collects from 30 enabled sources (38 defined) every 6 hours, stores results in Supabase, and lets anyone query fresh AI news from Claude Code, Claude Desktop, or any MCP-compatible client with a single command.

## Architecture Overview

### Four Layers
1. **Collectors** (`src/collectors/`) — TypeScript modules that fetch and normalize data from each source type (RSS, JSON API, GitHub API, HTML scrape). Each collector outputs a common schema: `{ title, url, source, sourceCategory, score, summary, timestamp }`. Run by `collect.yml` on GitHub Actions four times a day (2:30, 8:30, 14:30, 20:30 New York time). The run is started by Supabase Cron via `workflow_dispatch`, not by GitHub's `schedule:` trigger. See `docs/scheduling.md`.

2. **Storage** (Supabase) — PostgreSQL database via Supabase free tier. Single `news_items` table with auto-cleanup of items older than 90 days. Edge Functions serve the MCP endpoint.

3. **MCP Server** (`supabase/functions/mcp/`) — Supabase Edge Function implementing the MCP protocol. Exposes tools: `get_trending`, `get_top_picks`, `search`, `get_new_since`, `get_source_updates`, `get_repo_quickstart`, `get_paper_brief`, `check_status`.

4. **Digest Delivery** (`src/digest/`) — Optional personal layer. Pulls latest items, filters by user-configured priority topics via Claude API, formats a briefing, and sends to Discord/Telegram/Slack/iMessage webhook. The hosted digest is run by `digest.yml` on GitHub Actions daily at 9:00 AM New York time, again dispatched by Supabase Cron, with a 9:30 missed-digest alarm. Self-hosters can still run it locally with `scripts/setup-cron.sh`.

### Tech Stack
- **Language:** TypeScript throughout
- **Runtime:** Node.js for collectors, Deno for Supabase Edge Functions
- **Database:** Supabase PostgreSQL (hosted) or SQLite (self-hosted option)
- **CI/CD:** GitHub Actions: `ci.yml` (PR checks), `collect.yml` and `digest.yml` (dispatched on schedule by Supabase Cron), `heartbeat.yml` (weekly keep-alive)
- **Scheduling:** Supabase Cron (`pg_cron` + `pg_net`) calls GitHub's `workflow_dispatch` API (`supabase/migrations/003_schedule_triggers.sql`)
- **MCP Protocol:** HTTP transport via Supabase Edge Function

## Source Configuration
Sources are defined in `config/sources.yaml`. Each source has:
- `id`: unique identifier (e.g., `anthropic_blog`)
- `name`: display name
- `type`: `rss` | `json_api` | `github_releases` | `github_trending` | `html_scrape`
- `url`: fetch endpoint
- `extraUrls`: `html_scrape` only, more pages for the same site scraper (Anthropic News also reads `/research`)
- `category`: `company_blog` | `community` | `research` | `industry_news` | `github`
- `enabled`: boolean
- `refreshIntervalHours`: override per-source if needed

## Current Direction

- **Scheduling is a deliberately tactical hybrid** (Supabase Cron → GitHub Actions; see the design decision below).
  A full move of collectors and digest into Supabase Edge Functions is **deferred, not rejected**. Revisit it if
  the two-platform setup causes trouble. Known costs of that move: Edge Function CPU and wall-clock limits, some
  sources may block cloud-provider IPs, and deploys would stop happening automatically on merge to `main`.
- **Ranking rebuild in progress**, one PR per step, based on a read-only audit
  (`ranking-audit.md`, the owner's local file, not committed). The product: a morning
  briefing of the big AI news (frontier model launches, major product launches,
  policy and safety, lab and business news), with builder content as a secondary.
  1. **Fix collection** (this step). Only what gets collected and how cleanly;
     scoring, slotting, the digest format and the MCP were deliberately left alone.
  2. **AI editor:** judge each item once, at collection time, and store the judgment.
  3. **New digest layout**, with a preview mode.
  4. **MCP reads the stored judgments**, then redeploy the Edge Function.
- **What step 1 changed** (CHANGELOG has the full list):
  - Disabled: Reddit ×5 (403 from Actions), HuggingFace Trending Spaces (demos, and pinned
    at 93 by a date bug), VentureBeat (bot challenge, 429). Reasons are in `sources.yaml`.
  - Fixed: Anthropic News (dated cards on `/news` and `/research`, including top-level model
    pages like `/claude-haiku-5-5`; summaries and exact times from each article page),
    Anthropic changelog (new URL, one item per bullet), DeepMind and Google Research
    (new feed URLs), Meta (newsroom AI-tag feed instead of a stale scrape), MIT TR (AI topic
    feed), HF Daily Papers (`paper.upvotes`), HN (`hitsPerPage`, raw points kept).
  - Added: Ars Technica AI, The Guardian AI, WIRED AI (tier 2, `industry_news`).
  - Every item: HTML entities decoded, whitespace collapsed, `utm_*` stripped from URLs
    before the `(url, source)` identity is formed (`src/utils/normalize.ts`).
  - Dedup keeps one row per story but records the other copies in `metadata.coveredBy`
    and keeps their `hnPoints` / `upvotes`; the upsert merges these with what's stored.
  - The post-"Done" hang: rss-parser's `parseURL` left responses open. All HTTP now goes
    through `src/utils/http.ts` (deadline, read-or-cancel), with a 15 s exit backstop.
- **Reddit is disabled.** It may return later via Reddit's official API, which needs a
  registered Reddit app and its own credentials. It was a secondary, community-reaction signal.
- The README's "Status & roadmap" section says the same thing. Keep the two in sync.

## Key Design Decisions
- **Pre-cached data, not on-demand scraping.** MCP calls read from DB — instant response, no waiting for scrapes.
- **Refresh interval (6h) is independent of data retention (90 days).** Refresh = how often new data arrives. Retention = how far back users can look.
- **Supabase Cron schedules, GitHub Actions executes (Oct 2026).** Originally GitHub's `schedule:` trigger did both. On free public repos that scheduler creates runs late or drops them: the 11:45 AM ET digest was landing at 2:30–6:00 PM ET, and getting worse. API-dispatched runs skip the scheduler and start within seconds. So `pg_cron` fires hourly, gates on the America/New_York hour (DST-proof), and `pg_net` POSTs to GitHub's `workflow_dispatch` endpoint. Execution, logs and merge-to-main-is-deploy stay on GitHub Actions. The `schedule:` blocks are commented out, not deleted, so forks can fall back. Setup, token renewal and rollback are in `docs/scheduling.md`. The one number that sets all times is `private.digest_hour_ny()` in migration 003; the 9:30 alarm and the collect times derive from it. It refuses 1 and 2, which repeat or vanish on DST changes.
- **TypeScript everywhere.** MCP ecosystem is TS-native; Supabase Edge Functions run Deno (TS); keeps one language across the project.
- **Source customization via config.** Users can enable/disable individual sources or source groups without touching code.

## Database Schema

Single table `news_items`.

**`supabase/migrations/001_create_news_items.sql` is the source of truth — read it before
writing a query.** This block is a summary and has been wrong before.

```sql
CREATE TABLE news_items (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  url TEXT NOT NULL,              -- NOT unique on its own
  source TEXT NOT NULL,
  source_category TEXT NOT NULL,
  score INTEGER DEFAULT 0,        -- nullable
  summary TEXT,
  authors TEXT,
  tags TEXT[] DEFAULT '{}',
  fetched_at TIMESTAMPTZ DEFAULT NOW(),   -- nullable
  published_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}'
);

-- Identity is (url, source), NOT url.
CREATE UNIQUE INDEX idx_news_items_url_source ON news_items(url, source);
CREATE INDEX idx_news_items_source ON news_items(source);
CREATE INDEX idx_news_items_fetched_at ON news_items(fetched_at DESC);
CREATE INDEX idx_news_items_source_category ON news_items(source_category);
```

Auto-cleanup via pg_cron or collector job: `DELETE FROM news_items WHERE fetched_at < NOW() - INTERVAL '90 days'`

### Query constraints that have caused real bugs

- **Row identity is `(url, source)`.** Two sources legitimately carry the same link — 54 rows
  did as of 2026-08-04. Deduplicating by `url` silently drops them; use `id`.
- **PostgREST enforces `db-max-rows` (1000 here) regardless of `.limit()`.** An uncapped
  `select` over a 7,000-row table returns 1,000 rows and no error. Anything that must see the
  whole table has to page — this silently broke both `showAll` and `check_status`.
- **`score` and `fetched_at` are both nullable and `score` is mutable**, so neither is a sound
  pagination cursor. Page on `id`, and freeze the working set with a captured cutoff so
  mid-read inserts cannot shift it.

## MCP Tools (8)

Six read from the `news_items` cache; two (`get_repo_quickstart`, `get_paper_brief`) resolve a
single identifier live against an external API, so they work for anything the user names — not
just what a collector happened to pick up.

| Tool | Description | Parameters | Backing |
|------|-------------|------------|---------|
| `get_trending` | All cached news, optionally filtered by source or category | `source?`, `category?`, `limit?` | cache |
| `get_top_picks` | Slotted display across 5 category sections, with per-source diversity caps | `officialLimit?`, `communityLimit?`, `researchLimit?`, `industryLimit?`, `showAll?` | cache |
| `search` | Keyword search across titles and summaries | `query`, `since?` | cache |
| `get_new_since` | Items added after a timestamp | `since` (ISO 8601), `limit?` | cache |
| `get_source_updates` | Items from a specific source | `source`, `limit?` | cache |
| `get_repo_quickstart` | GitHub repo metadata + install/usage section from the README | `repo` (owner/name or URL) | live (GitHub API) |
| `get_paper_brief` | ArXiv paper abstract, authors, categories, links | `arxiv_id` (ID or arxiv.org URL) | live (ArXiv API) |
| `check_status` | Cache status, last updated, per-source breakdown | — | cache |

`GITHUB_TOKEN` is optional on the Edge Function — set it to raise `get_repo_quickstart`'s
GitHub rate limit from 60/hr to 5,000/hr.

## File Structure
Generated from `git ls-files` (2026-10-14). Regenerate it from there rather than editing by hand.
```
ai-newsroom/
├── .github/
│   ├── heartbeat.txt        # Generated by heartbeat.yml; nothing reads it
│   └── workflows/
│       ├── ci.yml           # PR + push-to-main checks (required to merge)
│       ├── collect.yml      # Runs collectors + 90-day cleanup; dispatched by Supabase Cron
│       ├── digest.yml       # Sends the daily digest; dispatched by Supabase Cron
│       └── heartbeat.yml    # Weekly commit to the `heartbeat` branch; re-enables workflows
├── config/
│   └── sources.yaml         # Source definitions (enable/disable, URLs, types)
├── docs/
│   ├── scheduling.md        # Supabase Cron → workflow_dispatch: why, setup, renewal, rollback
│   └── sessions/            # Engineering session write-ups
├── reviews/                 # Saved code-review reports
├── scripts/
│   └── setup-cron.sh        # Local crontab for the digest (self-host option)
├── src/
│   ├── collectors/
│   │   ├── index.ts         # Orchestrator: loads sources.yaml, runs enabled collectors
│   │   ├── collect.test.ts  # `npm run test:collect` regression suite (no network)
│   │   ├── rss.ts           # RSS/Atom feed collector
│   │   ├── reddit.ts        # Reddit JSON API collector
│   │   ├── hackernews.ts    # HackerNews API collector
│   │   ├── github.ts        # GitHub trending + release watcher
│   │   ├── huggingface.ts   # HuggingFace papers + spaces
│   │   ├── scraper.ts       # Site-specific HTML scrapers (Anthropic news/research, release notes)
│   │   └── types.ts         # Shared types: NewsItem, Source, etc.
│   ├── digest/
│   │   ├── generate.ts      # Pull data, filter, send; records digest_state.last_digest_at
│   │   ├── format.ts        # Renders the slotted display for messaging apps
│   │   ├── config.ts        # Digest config loader (digest section of sources.yaml)
│   │   └── adapters/
│   │       ├── discord.ts   # Discord webhook adapter
│   │       ├── telegram.ts  # Telegram bot adapter
│   │       ├── slack.ts     # Slack incoming webhook adapter
│   │       └── imessage.ts  # iMessage adapter (macOS only)
│   └── utils/
│       ├── supabase.ts      # Supabase client: upsert + cleanup
│       ├── cleanup.ts       # `npm run cleanup`: delete items older than 90 days
│       ├── scoring.ts       # Relevance score 0-100 (recency / community / tier)
│       ├── slots.ts         # Slotted display layout (get_top_picks, digest)
│       ├── dedup.ts         # URL + title-similarity dedup; records coveredBy on the kept row
│       ├── date-filter.ts   # Skip items older than 7 days
│       ├── http.ts          # fetch with deadline; every response read or cancelled
│       ├── normalize.ts     # Entity decoding, whitespace, utm_* stripping for every item
│       ├── relevance-filter.ts # AI keyword filter
│       ├── test-slots.ts    # Manual script: print slotted display from live data
│       └── logger.ts        # Logging utility
├── supabase/
│   ├── functions/
│   │   └── mcp/
│   │       ├── index.ts     # Edge Function: JSON-RPC entry point + tool routing
│   │       ├── test.ts      # Manual harness against real Supabase data (Node, not Deno)
│   │       ├── external.test.ts # `npm run test:mcp` regression suite (no network)
│   │       └── _shared/
│   │           ├── tools.ts     # Tool definitions: names, descriptions, input schemas
│   │           ├── handlers.ts  # Handlers backed by the news_items cache
│   │           ├── external.ts  # Handlers backed by live GitHub / ArXiv lookups
│   │           └── slots.ts     # Category slotting + display formatting
│   └── migrations/
│       ├── 001_create_news_items.sql
│       ├── 002_create_digest_state.sql
│       └── 003_schedule_triggers.sql # pg_cron + pg_net → GitHub dispatch (run by hand)
├── .env.example
├── .gitignore
├── CHANGELOG.md
├── CLAUDE.md                # This file
├── LICENSE
├── README.md
├── package.json
├── package-lock.json
└── tsconfig.json
```

## Commands
- `npm run collect` — Run all enabled collectors once (manual trigger). Not while
  a `collect.yml` run is in progress: each run reads stored metadata, merges and
  writes it back, so the two could overwrite each other's coverage. `collect.yml`
  runs one at a time (`concurrency: collect`); a local run is outside that.
- `npm run collect -- --source anthropic_blog` — Run a single collector
- `npm run digest` — Generate and send personal digest
- `npm run typecheck` — Type-check `src/` (note: `tsconfig.json` EXCLUDES `supabase/`)
- `npm run test:mcp` — MCP regression suite; no network or credentials needed
- `npm run test:collect` — collector regression suite (clean-up, dedup coverage, Anthropic parsers); no network
- `supabase functions serve mcp` — Run Edge Function locally (this is the MCP server endpoint)

## Branching and CI

**`main` is protected — direct pushes are rejected.** Enforced by a GitHub
*ruleset* (Settings → Rules → Rulesets), not classic branch protection, so the
Settings → Branches page is empty by design. There are **no bypass actors**: the
rule applies to everyone, including repository admins and GitHub Actions.

Every change goes through a pull request:

```bash
git checkout -b my-change
# edit, commit
git push -u origin my-change
gh pr create --fill
gh pr merge --auto --merge     # 0 approvals required; CI must be green
```

**Merge with a regular merge commit (`--merge`), never `--squash`.** Squashing
collapses a PR's commits into one and loses the individual history, which the
owner wants kept. The repo allows merge commits and the ruleset has no
linear-history rule, so `--merge` works.

`.github/workflows/ci.yml` runs on every PR and every push to `main`, and the
`typecheck + tests` check is required to merge. It runs:

1. `npm run typecheck`
2. `npm run test:mcp` and `npm run test:collect`
3. **NUL-byte scan** — a raw NUL makes tooling treat a source file as binary
   (ripgrep stops reporting line matches). One reached `main` on 2026-08-05.
4. **docs-match-code** — every tool declared, routed *and* in the README, with
   the README's tool and source counts matching `tools.ts` and `sources.yaml`.
   Documentation drifting from code has caused real bugs here; it now fails CI.

### The heartbeat writes to its own branch, not `main`

`heartbeat.yml` commits a weekly timestamp to the **`heartbeat`** branch. GitHub
disables scheduled workflows after 60 days of repository inactivity, which would
silently stop `collect.yml` and `digest.yml`; the commit prevents that. The rule
counts *repository* activity, not default-branch activity, so a side branch
works.

It used to push to `main`, which is incompatible with protecting `main`:
required status checks reject a freshly pushed commit (its checks have not run),
and on a **user-owned** repo the GitHub Actions app cannot be granted a bypass at
all — the API refuses with *"Actor GitHub Actions integration must be part of the
ruleset source or owner organization."* Moving the heartbeat off `main` means the
ruleset needs no exception, so there is no hole in it.

The workflow also re-enables `collect.yml` / `digest.yml` / `heartbeat.yml` if it
finds them disabled. Query workflow state through the API — `gh workflow view`
has **no** `--json` flag, and the version of this step that used it silently did
nothing while reporting success.

**Possibly redundant since Oct 2026, kept on purpose.** `collect.yml` and
`digest.yml` no longer have an active `schedule:` trigger (Supabase Cron
dispatches them). The 60-day rule is believed to target scheduled workflows
only, so the heartbeat may no longer be needed. That hasn't been confirmed, so
don't remove it until it is.

## Environment Variables
```
# Supabase (required for hosted mode)
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=eyJ...

# Digest delivery (optional, pick one)
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...

# GitHub (optional for collectors; collect.yml passes the workflow's own token)
GITHUB_TOKEN=...   # raises the release sources' API limit from 60/hour per IP

# Claude API (optional, for relevance filtering in digest)
ANTHROPIC_API_KEY=sk-ant-...

# Self-hosted mode (optional, uses SQLite instead of Supabase)
NEWSROOM_STORAGE=sqlite
NEWSROOM_DB_PATH=./data/newsroom.db
```
