# AI Newsroom - Project Context

## What This Project Is
AI Newsroom is an open-source, real-time AI/tech news aggregator exposed as an MCP (Model Context Protocol) server. It collects from 30 enabled sources (38 defined) every 6 hours, stores results in Supabase, and lets anyone query fresh AI news from Claude Code, Claude Desktop, or any MCP-compatible client with a single command.

## Architecture Overview

### Five Layers
1. **Collectors** (`src/collectors/`) — TypeScript modules that fetch and normalize data from each source type (RSS, JSON API, GitHub API, HTML scrape). Each collector outputs a common schema: `{ title, url, source, sourceCategory, score, summary, timestamp }`. Run by `collect.yml` on GitHub Actions four times a day (2:30, 8:30, 14:30, 20:30 New York time). The run is started by Supabase Cron via `workflow_dispatch`, not by GitHub's `schedule:` trigger. See `docs/scheduling.md`.

2. **Storage** (Supabase) — PostgreSQL database via Supabase free tier. Single `news_items` table with auto-cleanup of items older than 90 days. Edge Functions serve the MCP endpoint.

3. **MCP Server** (`supabase/functions/mcp/`) — Supabase Edge Function implementing the MCP protocol. Exposes tools: `get_trending`, `get_top_picks`, `search`, `get_new_since`, `get_source_updates`, `get_repo_quickstart`, `get_paper_brief`, `check_status`. Serves the AI editor's judgments with the digest's own story code (`supabase/functions/_shared/newsroom/`, shared by both runtimes). Reads only. **Merge equals deploy:** `deploy-mcp.yml` deploys it on every push to `main` that touches it, then smoke-tests the live endpoint. See `docs/mcp.md`.

4. **AI Editor** (`src/editor/`) — Judges each collected item once with Claude Haiku 5.5 against `config/editor-rubric.md` and stores the result in `news_items.editor_*` (type, importance 1–10, audience, headline, why, story key, follow-up). Runs as a second job in `collect.yml`, and again as the first job of `digest.yml`; allowed to fail in both. The digest and the MCP server read the judgments. See `docs/editor.md`.

5. **Digest Delivery** (`src/digest/`) — Builds the morning briefing from the editor's judgments: items grouped into stories (`src/editor/select.ts`, a re-export of the shared `stories.ts`), in Top stories, Also notable, For builders and Paper of note, with linked plain headlines and why-lines. Falls back to the old ranking (`buildSlottedDisplay`) when most of the window is unjudged, with a footer saying so. Sends to a Discord webhook (`plain` or `embeds` layout, `DIGEST_LAYOUT`), or Telegram/Slack/iMessage as plain text. The hosted digest is run by `digest.yml` on GitHub Actions daily at 9:00 AM New York time, again dispatched by Supabase Cron, with a 9:30 missed-digest alarm. Self-hosters can still run it locally with `scripts/setup-cron.sh`. See `docs/digest.md`.

### Tech Stack
- **Language:** TypeScript throughout
- **Runtime:** Node.js for collectors, Deno for Supabase Edge Functions
- **Database:** Supabase PostgreSQL (hosted) or SQLite (self-hosted option)
- **CI/CD:** GitHub Actions: `ci.yml` (PR checks), `collect.yml` (collect, then the AI editor) and `digest.yml` (the AI editor, then the digest; both dispatched on schedule by Supabase Cron), `editor-backfill.yml` (manual), `deploy-mcp.yml` (deploys the MCP Edge Function on merge to `main`, or by hand), `heartbeat.yml` (weekly keep-alive)
- **LLM:** Claude Haiku 5.5 via `@anthropic-ai/sdk` for the AI editor and the digest's daily repeat check. (The digest fallback's optional summary still calls Haiku 4.5 over raw `fetch`, and only with `ANTHROPIC_API_KEY`, which the digest job now has for the repeat check.) On Actions both authenticate by workload identity federation, falling back to the `ANTHROPIC_API_KEY` secret
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
  1. **Fix collection** (done, PR #7). Only what gets collected and how cleanly;
     scoring, slotting, the digest format and the MCP were deliberately left alone.
  2. **AI editor** (done, PR #8): judge each item once, at collection time, and store
     the judgment.
  3. **The digest built on the judgments** (done, PR #9), then a tuning PR from the
     first five real digests (this one). The MCP, collection and the editor's storage
     format are unchanged.
  4. **The MCP serves the judgments** (done, this PR), with one copy of the
     selection code for both runtimes and automatic deploys. **The ranking rebuild
     is complete.**
- **What step 4 adds** (`docs/mcp.md` has the detail):
  - **Shared code** in `supabase/functions/_shared/newsroom/` (`types`, `rows`,
    `source-names`, `stories`, `why`, `slots`): pure TS, no imports outside the
    folder, `.ts` import suffixes (Deno). Node reaches it through one-line
    re-exports at the old paths (`src/editor/select.ts`, `src/utils/source-names.ts`,
    `src/utils/slots.ts`, `src/digest/why.ts`), with `allowImportingTsExtensions` and
    `rewriteRelativeImportExtensions` in `tsconfig.json` (no `rootDir` any more).
    **Edit the shared file, not a re-export, and never copy it.** It must stay under
    `supabase/functions/` or the deploy won't upload it (CI checks the module graph).
  - `PRESS_SOURCES` is static (the server can't read `sources.yaml`); a test keeps it
    equal to the `industry_news` tier-1/2 sources.
  - Tools: every entry has the editor fields (null when unjudged) and `outlets`;
    `get_top_picks` is the digest's sections for a window (24 h default, `hours` /
    `since`), falling back to the old slots under 50% judged; the list tools group into
    stories and rank like the digest; `min_importance` / `type` / `audience` filters;
    `check_status` reports the editor's last-24h coverage and the deployed commit.
    `get_trending` now defaults to the last 7 days.
  - The digest's repeat memory and repeat check are digest-only.
  - **Deploys**: `deploy-mcp.yml` (push to `main` under `supabase/functions/**`, or
    `workflow_dispatch` from `main`): `deno check`, stamp `build-info.ts` with the SHA,
    `supabase functions deploy mcp --no-verify-jwt --use-api`, then
    `scripts/smoke-mcp.sh` (8 tools, the stamped commit live). `supabase/config.toml`
    sets `verify_jwt = false` too. **Never turn JWT verification on** (every assistant's
    connection breaks), and never deploy from a branch: production changes only
    through the workflow after a merge. The `SUPABASE_ACCESS_TOKEN` secret is scoped to
    Edge Functions read/write and project read; ask for one more permission only if a
    deploy names it.
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
- **What step 2 adds** (`docs/editor.md` has the detail):
  - Migration 004 (run by hand): ten nullable `editor_*` columns, checks, a partial index on
    unjudged rows. `editor_judged_at IS NULL` means "not judged yet".
  - Judged **once**: writes only where `editor_judged_at` is null, and collection never sends
    `editor_*` columns (`toUpsertRow`, tested). Re-judge by clearing them, then backfill.
  - The rubric is `config/editor-rubric.md`, with a version line stored per judgment. Bump it
    on every edit. Try changes with `npm run preview:editor -- --date … --dry-run`.
  - Story keys group copies and follow-ups; each request lists the last 7 days' keys.
  - Titles and summaries are untrusted: JSON strings in `<items>`, `<` escaped, no tools,
    schema-constrained output.
  - **No `temperature: 0`**: Haiku 5.5 rejects any temperature but 1 (HTTP 400).
  - Auth on Actions: federation IDs as repository variables, `id-token: write` on the editor
    jobs only; a fresh GitHub OIDC token per exchange. Fallback: `ANTHROPIC_API_KEY` secret.
  - Cost: about $0.02 a day. Caps on items, calls and input tokens per run.
- **What step 3 adds** (`docs/digest.md` has the detail):
  - Rubric v4 (`2026-10-17.4`): government action against major labs at 7–8, version
    releases with only small changes are `patch_release` 1–3, why-lines never about
    coverage, an 8 band for widely covered flagship and major open-weight releases.
    Stored judgments are not redone.
  - `digest.yml` runs the editor first as its own job (same auth as `collect.yml`,
    `id-token: write` there only, allowed to fail, **not** in the `editor` concurrency
    group so the digest never waits on it). The digest job runs on `!cancelled()`.
  - Stories: grouped by `editor_story_key`; importance = the max; outlets from sources
    and `coveredBy`; representative item: official lab, then wire (also via HN),
    then tier-1/2 press, then the rest, among items rated within a point of the
    story's best and of its audience. Yesterday's top-story keys
    (`digest_state.last_digest_story_keys`, JSON) are not repeated without a follow-up.
  - Unjudged items are left out and counted in the footer. Under 50% judged, or the
    editor columns unreadable: the old `buildSlottedDisplay` ranking, footer
    "AI editor unavailable today — basic ranking".
  - Discord escaping is per field (`escapeDiscord` in `src/digest/render.ts`), never
    per message; links are masked `[headline](<https://…>)`; plain messages also set
    `SUPPRESS_EMBEDS`. Never split a story across messages.
  - `digest_state.last_digest_at` now stores the window's end (the run's start), so
    items fetched while a digest is being built fall in the next window.
  - **A real send moves `last_digest_at`.** Never trigger an extra digest to test; use
    `npm run digest -- --preview --date …` (anon key, never writes).
- **What the tuning PR adds** (`docs/digest.md`, "Repeats and updates"):
  - **A daily newspaper**: a story shown in the last 7 days is never shown again unless
    it develops; then it is one story, headline "Update: ", ranked by its new items only.
    A small tweak is at most a line in Also notable. Never the same story twice a day.
  - `digest_state.story_history` (JSON, 7 days, all sections) replaces
    `last_digest_story_keys` as the memory; the latter is still written, for rollback.
  - **The repeat check** (`src/digest/repeats.ts`): one Haiku call per digest (effort
    `medium`, ~$0.002), new / update / repeat per candidate. Its links are checked:
    copied headline before line number, and a link needs a shared subject name (keys
    are checked too: the editor reuses keys wrongly sometimes). On failure: the key
    rule (step 3's, over the 7-day history). The digest job now has `id-token: write`
    and the Anthropic credentials for it.
  - Rubric v5 (`2026-10-21.5`): key reuse with examples, follow-ups scored by what is
    new, retellings 1–3. It moved scores only about a point; the check does the work.
  - Why-line guard (`src/digest/why.ts`), HN publishers (`PUBLISHERS` in
    `source-names.ts`), weak sources can't lead below 8, 2 stories per outlet per section.
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
  metadata JSONB DEFAULT '{}',
  -- AI editor (migration 004), all nullable; written once, never by collection
  editor_type TEXT, editor_importance SMALLINT, editor_audience TEXT,
  editor_headline TEXT, editor_why TEXT, editor_story_key TEXT, editor_followup BOOLEAN,
  editor_model TEXT, editor_version TEXT, editor_judged_at TIMESTAMPTZ
);

-- Identity is (url, source), NOT url.
CREATE UNIQUE INDEX idx_news_items_url_source ON news_items(url, source);
CREATE INDEX idx_news_items_source ON news_items(source);
CREATE INDEX idx_news_items_fetched_at ON news_items(fetched_at DESC);
CREATE INDEX idx_news_items_source_category ON news_items(source_category);
CREATE INDEX idx_news_items_unjudged ON news_items(fetched_at DESC) WHERE editor_judged_at IS NULL;
CREATE INDEX idx_news_items_editor_story_key ON news_items(editor_story_key) WHERE editor_story_key IS NOT NULL;
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
| `get_trending` | Recent stories (7 days by default), most important first, optionally by source or category | `source?`, `category?`, `limit?`, `since?`, filters | cache |
| `get_top_picks` | The digest's sections for a window (default 24 h); old slots when mostly unjudged | `hours?`, `since?`, `showAll?`; `officialLimit?`, `communityLimit?`, `researchLimit?`, `industryLimit?` (fallback only) | cache |
| `search` | Keyword search across titles, editor headlines and summaries, as stories | `query`, `since?`, `limit?`, filters | cache |
| `get_new_since` | Stories added after a timestamp | `since` (ISO 8601), `limit?`, filters | cache |
| `get_source_updates` | A source's latest items, most important first | `source`, `limit?`, filters | cache |
| `get_repo_quickstart` | GitHub repo metadata + install/usage section from the README | `repo` (owner/name or URL) | live (GitHub API) |
| `get_paper_brief` | ArXiv paper abstract, authors, categories, links | `arxiv_id` (ID or arxiv.org URL) | live (ArXiv API) |
| `check_status` | Cache status, last updated, per-source breakdown, editor coverage (last 24 h), deployed commit | — | cache |

Filters: `min_importance` (1–10), `type` (an editor type), `audience` (`general` / `builder`).
Every story carries `headline`, `why`, `importance`, `type`, `audience`, `story_key`,
`followup`, `outlets`, `url`, `published_at` and the original `title`; null editor
fields when unjudged.

`GITHUB_TOKEN` is optional on the Edge Function — set it to raise `get_repo_quickstart`'s
GitHub rate limit from 60/hr to 5,000/hr.

## File Structure
Generated from `git ls-files` (2026-10-21). Regenerate it from there rather than editing by hand.
```
ai-newsroom/
├── .github/
│   ├── heartbeat.txt        # Generated by heartbeat.yml; nothing reads it
│   └── workflows/
│       ├── ci.yml           # PR + push-to-main checks (required to merge)
│       ├── collect.yml      # Collectors + 90-day cleanup, then the AI editor; dispatched by Supabase Cron
│       ├── digest.yml       # The AI editor, then the daily digest; dispatched by Supabase Cron
│       ├── deploy-mcp.yml   # Deploys the MCP Edge Function on merge to main; smoke test
│       ├── editor-backfill.yml # Manual: AI editor over the last N days, higher caps
│       └── heartbeat.yml    # Weekly commit to the `heartbeat` branch; re-enables workflows
├── config/
│   ├── editor-rubric.md     # The AI editor's system prompt, versioned; tune here
│   └── sources.yaml         # Source definitions (enable/disable, URLs, types)
├── docs/
│   ├── digest.md            # The digest: stories, sections, fallback, layouts, preview
│   ├── editor.md            # AI editor: how it works, rubric, cost, re-judging, auth setup
│   ├── mcp.md               # MCP server: judgments, shared code, deploys, verifying what's live
│   ├── scheduling.md        # Supabase Cron → workflow_dispatch: why, setup, renewal, rollback
│   └── sessions/            # Engineering session write-ups
├── reviews/                 # Saved code-review reports
├── scripts/
│   ├── setup-cron.sh        # Local crontab for the digest (self-host option)
│   └── smoke-mcp.sh         # Smoke test for the live MCP endpoint (deploy-mcp.yml, or by hand)
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
│   │   ├── generate.ts      # `npm run digest` (--dry-run, --preview): CLI, adapters
│   │   ├── run.ts           # One run: window, build, deliver, record in digest_state
│   │   ├── build.ts         # Items → digest document: editor stories, or the fallback
│   │   ├── repeats.ts       # 7-day story history; the repeat check; the key rule
│   │   ├── why.ts           # Re-export of the shared why-line guard
│   │   ├── render.ts        # Discord plain/embeds and plain text; per-field escaping; limits
│   │   ├── store.ts         # Supabase reads; the digest_state write
│   │   ├── config.ts        # Adapter credentials; layout and thresholds from env
│   │   ├── slot-options.ts  # The old ranking's slot caps (fallback, editor preview)
│   │   ├── digest.test.ts   # `npm run test:digest` regression suite (no network)
│   │   └── adapters/
│   │       ├── discord.ts   # Discord webhook adapter
│   │       ├── telegram.ts  # Telegram bot adapter
│   │       ├── slack.ts     # Slack incoming webhook adapter
│   │       └── imessage.ts  # iMessage adapter (macOS only)
│   ├── editor/
│   │   ├── index.ts         # `npm run editor`: judge unjudged items, store editor_* columns
│   │   ├── run.ts           # Batch loop with caps, story-key context, split-on-cutoff retry
│   │   ├── client.ts        # Auth (federation / API key) and the structured-output call
│   │   ├── judgment.ts      # Types, response schema, validation and clamping
│   │   ├── prompt.ts        # Rubric loading, per-item input, prompt assembly
│   │   ├── db.ts            # Paged reads, editor-only writes
│   │   ├── config.ts        # EDITOR_* settings and caps
│   │   ├── preview.ts       # `npm run preview:editor`: old digest vs editor, read-only
│   │   ├── select.ts        # Re-export of the shared story code (stories.ts)
│   │   ├── window.ts        # 9:00 AM New York digest windows; frozen clock for replays
│   │   └── editor.test.ts   # `npm run test:editor` regression suite (no network)
│   └── utils/
│       ├── supabase.ts      # Supabase client: upsert + cleanup
│       ├── cleanup.ts       # `npm run cleanup`: delete items older than 90 days
│       ├── scoring.ts       # Relevance score 0-100 (recency / community / tier)
│       ├── slots.ts         # Re-export of the shared old ranking (the fallback)
│       ├── source-names.ts  # Re-export of the shared source names and publishers
│       ├── dedup.ts         # URL + title-similarity dedup; records coveredBy on the kept row
│       ├── date-filter.ts   # Skip items older than 7 days
│       ├── http.ts          # fetch with deadline; every response read or cancelled
│       ├── normalize.ts     # Entity decoding, whitespace, utm_* stripping for every item
│       ├── relevance-filter.ts # AI keyword filter
│       ├── test-slots.ts    # Manual script: print slotted display from live data
│       └── logger.ts        # Logging utility
├── supabase/
│   ├── config.toml          # CLI config: only verify_jwt = false for mcp
│   ├── functions/
│   │   ├── _shared/
│   │   │   └── newsroom/    # Shared by the digest (Node) and the MCP (Deno); pure TS
│   │   │       ├── types.ts         # NewsItem, editor types and audiences
│   │   │       ├── rows.ts          # news_items columns; rows → items
│   │   │       ├── source-names.ts  # Display names, publishers, lab/press/paper sources
│   │   │       ├── stories.ts       # Stories, representative item, outlets, ranking, sections
│   │   │       ├── why.ts           # Why-line guard
│   │   │       └── slots.ts         # The old score-ordered ranking (fallback)
│   │   └── mcp/
│   │       ├── index.ts     # Edge Function: JSON-RPC entry point + tool routing
│   │       ├── test.ts      # Manual harness: the real handlers on real data (Node)
│   │       ├── external.test.ts # `npm run test:mcp`: live-lookup helpers (no network)
│   │       ├── tools.test.ts    # `npm run test:mcp`: news tools vs a fake client (no network)
│   │       └── _shared/
│   │           ├── tools.ts      # Tool definitions: names, descriptions, input schemas
│   │           ├── handlers.ts   # Handlers backed by the news_items cache
│   │           ├── data.ts       # Paged reads with the editor columns (reads only)
│   │           ├── present.ts    # Entries, ranking, filters, top-picks sections
│   │           ├── build-info.ts # Deployed commit, stamped by deploy-mcp.yml
│   │           └── external.ts   # Handlers backed by live GitHub / ArXiv lookups
│   └── migrations/
│       ├── 001_create_news_items.sql
│       ├── 002_create_digest_state.sql
│       ├── 003_schedule_triggers.sql # pg_cron + pg_net → GitHub dispatch (run by hand)
│       └── 004_editor_judgments.sql  # AI editor columns (run by hand, idempotent)
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
- `npm run digest` — Generate and send the digest. Moves `digest_state.last_digest_at`: never run it just to test
- `npm run digest -- --preview --date YYYY-MM-DD [--layout plain|embeds] [--text] [--history] [--no-repeat-check]` — Print the digest for a past 9:00 AM ET window from stored judgments; replays the 7 mornings before to rebuild the history (repeat check with the local `ANTHROPIC_API_KEY`, ~$0.015); anon key, never sends or writes
- `npm run digest -- --dry-run` — Print the real next digest without sending (service key)
- `npm run typecheck` — Type-check `src/` (note: `tsconfig.json` EXCLUDES `supabase/`)
- `npm run test:mcp` — MCP regression suite; no network or credentials needed
- `npm run test:collect` — collector regression suite (clean-up, dedup coverage, Anthropic parsers); no network
- `npm run test:editor` — AI editor regression suite (validation, prompts, caps, editor-column guarantee, selection); no network
- `npm run test:digest` — digest regression suite (stories, sections, repeats and updates, history, why-line guard, publishers, weak sources, caps, fallback, escaping, Discord limits, layouts, adapters, preview never sends); no network
- `npm run editor` — Judge unjudged items from the last 7 days (needs the service key, so in practice only on Actions)
- `npm run preview:editor -- --date YYYY-MM-DD [--dry-run] [--all]` — Old digest vs editor for a 9:00 AM ET window; read-only, anon key; `--dry-run` judges in memory with the local `ANTHROPIC_API_KEY`
- `npm run check:mcp` — `deno check` the Edge Function (needs Deno; CI also bundles it)
- `scripts/smoke-mcp.sh [URL] [COMMIT]` — Smoke-test the live MCP endpoint (reads only): 8 tools, the deployed commit, today's sections
- `deno run --allow-net --allow-env --allow-read supabase/functions/mcp/index.ts` — Run the Edge Function locally on :8000 (set `SUPABASE_URL`, and the anon key as `SUPABASE_SERVICE_ROLE_KEY`)
- **Never `supabase functions deploy` by hand**: merge to `main` and `deploy-mcp.yml` deploys

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

**Merge equals deploy for the MCP server.** A merge that touches
`supabase/functions/**` deploys the Edge Function to production through
`deploy-mcp.yml`. Check the run's smoke test after merging.

`.github/workflows/ci.yml` runs on every PR and every push to `main`, and the
`typecheck + tests` check is required to merge. It runs:

1. `npm run typecheck`
2. **Edge Function check** (Deno 2.9.8): `deno check`, every local import under
   `supabase/functions/` (or the deploy won't upload it), and `deno bundle`
3. `npm run test:mcp`, `npm run test:collect`, `npm run test:editor` and `npm run test:digest`
4. **NUL-byte scan** — a raw NUL makes tooling treat a source file as binary
   (ripgrep stops reporting line matches). One reached `main` on 2026-08-05.
5. **docs-match-code** — every tool declared, routed *and* in the README, with
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
SUPABASE_ANON_KEY=eyJ...   # read-only; all the preview needs. The owner's machine has only this one

# Digest delivery (optional, pick one)
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...

# GitHub (optional for collectors; collect.yml passes the workflow's own token)
GITHUB_TOKEN=...   # raises the release sources' API limit from 60/hour per IP

# Claude API: the AI editor (local runs, and the Actions fallback) and the digest fallback's summary
ANTHROPIC_API_KEY=sk-ant-...

# AI editor on Actions: workload identity federation, as repository VARIABLES (not secrets)
ANTHROPIC_FEDERATION_RULE_ID=fdrl_...
ANTHROPIC_ORGANIZATION_ID=...
ANTHROPIC_SERVICE_ACCOUNT_ID=svac_...
ANTHROPIC_WORKSPACE_ID=wrkspc_...   # only if the rule covers several workspaces
# Optional tuning: EDITOR_MODEL, EDITOR_EFFORT, EDITOR_MAX_ITEMS, EDITOR_MAX_CALLS, ... (docs/editor.md)

# Digest (optional; repository VARIABLES on Actions, docs/digest.md)
DIGEST_LAYOUT=plain   # or embeds
# Thresholds: DIGEST_TOP_MIN_IMPORTANCE=6, DIGEST_TOP_LIMIT=5, ..., DIGEST_MIN_JUDGED_SHARE=0.5,
# DIGEST_TOP_WEAK_SOURCE_MIN_IMPORTANCE=8, DIGEST_MAX_PER_OUTLET=2, DIGEST_REPEAT_EFFORT=medium

# Self-hosted mode (optional, uses SQLite instead of Supabase)
NEWSROOM_STORAGE=sqlite
NEWSROOM_DB_PATH=./data/newsroom.db
```
