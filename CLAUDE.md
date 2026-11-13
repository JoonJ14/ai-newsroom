# AI Newsroom - Project Context

## What This Project Is
AI Newsroom is an open-source, real-time AI/tech news aggregator exposed as an MCP (Model Context Protocol) server. It collects from 30 enabled sources (38 defined) every 6 hours, stores results in Supabase, and lets anyone query fresh AI news from Claude Code, Claude Desktop, or any MCP-compatible client with a single command.

## Architecture Overview

### Five Layers
1. **Collectors** (`src/collectors/`) — TypeScript modules that fetch and normalize data from each source type (RSS, JSON API, GitHub API, HTML scrape). Each collector outputs a common schema: `{ title, url, source, sourceCategory, score, summary, timestamp }`. Run by `collect.yml` on GitHub Actions four times a day (2:30, 8:30, 14:30, 20:30 New York time). The run is started by Supabase Cron via `workflow_dispatch`, not by GitHub's `schedule:` trigger. See `docs/scheduling.md`.

2. **Storage** (Supabase) — PostgreSQL database via Supabase free tier. Single `news_items` table with auto-cleanup: 90 days, or 14 for items the AI editor rated 1–2. Edge Functions serve the MCP endpoint.

3. **MCP Server** (`supabase/functions/mcp/`) — Supabase Edge Function implementing the MCP protocol. Exposes tools: `get_trending`, `get_top_picks`, `search`, `get_new_since`, `get_source_updates`, `get_repo_quickstart`, `get_paper_brief`, `check_status`. Serves the AI editor's judgments with the digest's own story code (`supabase/functions/_shared/newsroom/`, shared by both runtimes). Reads only. **Merge equals deploy:** `deploy-mcp.yml` deploys it on every push to `main` that touches it, then smoke-tests the live endpoint. See `docs/mcp.md`.

4. **AI Editor** (`src/editor/`) — Judges each collected item once with Claude Haiku 5.5 against `config/editor-rubric.md` and stores the result in `news_items.editor_*` (type, importance 1–10, audience, headline, why, story key, follow-up). Runs as a second job in `collect.yml`, and again as the first job of `digest.yml`; allowed to fail in both. The digest and the MCP server read the judgments. See `docs/editor.md`.

5. **Digest Delivery** (`src/digest/`) — Builds the morning briefing from the editor's judgments: items grouped into stories (`src/editor/select.ts`, a re-export of the shared `stories.ts`), in Top stories, Also notable, For builders and Paper of note, with linked plain headlines and why-lines. Falls back to the old ranking (`buildSlottedDisplay`) when most of the window is unjudged, with a footer saying so. Sends to a Discord webhook (`plain` or `embeds` layout, `DIGEST_LAYOUT`), or Telegram/Slack/iMessage as plain text. The hosted digest is run by `digest.yml` on GitHub Actions daily at 9:00 AM New York time, again dispatched by Supabase Cron, with a 9:30 missed-digest alarm. Self-hosters can still run it locally with `scripts/setup-cron.sh`. See `docs/digest.md`.

### Tech Stack
- **Language:** TypeScript throughout
- **Runtime:** Node.js for collectors, Deno for Supabase Edge Functions
- **Database:** Supabase PostgreSQL
- **CI/CD:** GitHub Actions: `ci.yml` (PR checks), `collect.yml` (collect, then the AI editor) and `digest.yml` (the AI editor, then the digest; both dispatched on schedule by Supabase Cron), `editor-backfill.yml` (manual), `deploy-mcp.yml` (deploys the MCP Edge Function on merge to `main`, or by hand), `heartbeat.yml` (weekly keep-alive)
- **LLM:** Claude Haiku 5.5 via `@anthropic-ai/sdk` for the AI editor, the digest's daily repeat check and the fallback digest's optional summary, all through one client (`createAnthropicClient` in `src/editor/client.ts`). On Actions they authenticate by workload identity federation (live since Nov 13, 2026); the repository holds no Anthropic key. `ANTHROPIC_API_KEY` is for local runs and forks
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
- **Ranking rebuild: complete (2026-10-22)**, one PR per step, based on a read-only audit
  (`ranking-audit.md`, the owner's local file, not committed). The product: a morning
  briefing of the big AI news (frontier model launches, major product launches,
  policy and safety, lab and business news), with builder content as a secondary.
  1. **Fix collection** (done, PR #7). Only what gets collected and how cleanly;
     scoring, slotting, the digest format and the MCP were deliberately left alone.
  2. **AI editor** (done, PR #8): judge each item once, at collection time, and store
     the judgment.
  3. **The digest built on the judgments** (done, PR #9), then a tuning PR from the
     first five real digests (done, PR #10).
  4. **The MCP serves the judgments** (done, PR #11), with one copy of the
     selection code for both runtimes and automatic deploys. First deployed
     2026-10-22 (`1f0d295`), smoke test green.
  - **Engineering record:** `docs/sessions/2026-10-22-ranking-rebuild-steps-2-4.md`,
    `docs/TROUBLESHOOTING.md` (debugging stories) and `docs/DECISIONS.md`
    (`DEC-001`–`DEC-021`; read before changing scheduling, collection, the editor, the
    digest, the repeat check, the shared code, retention or deploys).
- **Workload identity federation is live (Nov 13, 2026).**
  - Every GitHub run authenticates through rule `ai-newsroom-github-main`
    (`fdrl_01GjkdTFb4hZy8f84afJqnRn`): Branch/ref `refs/heads/main` (**the full
    ref**; `refs/head/main` failed with `match_subject_prefix`), any event, Default
    workspace only, service account `ai-newsroom-github-actions`.
  - The `ANTHROPIC_API_KEY` repository secret is deleted. With the federation
    variables set, a failed exchange doesn't fall back to a key.
  - **Renaming the GitHub user or the repository breaks the rule** until its name
    fields are edited.
  - Settings and diagnosis: `docs/editor.md` ("Authentication"), TROUBLESHOOTING
    ("Token exchange failed").
- **Cleanup after the rebuild: done (PR #13).** Lab names for HN links (naming only,
  `DEC-021`), the deploy's project-ref check, the fallback summary on the editor's
  client, the SQLite and unused digest settings removed, and 14-day retention for items
  rated 1–2 (`DEC-020`).
- **Owner steps and decisions:**
  - Optional: the disabled-sources SQL in TROUBLESHOOTING ("Old rows from disabled
    sources"). Preview first.
  - Decided 2026-11-13: HN links to a lab's own site stay **naming-only** (`DEC-021`).
    They aren't strong sources, the lab for the per-outlet cap, or one outlet for the
    tiebreak. Revisit only if a lab's own announcement is noticed ranking too low.
  - Optional: narrow the federation rule's OAuth scope if the Console offers
    something below `workspace:developer` that can still call the Messages API.
  - Local model-backed previews need a fresh `ANTHROPIC_API_KEY` in `.env`:
    `ai-newsroom-local` expired on 2026-11-13, and `ai-newsroom-mac-local` expires
    around 2026-11-15.
- **Dates:**
  - The Vault GitHub token (`github_dispatch_token`, which Supabase Cron dispatches
    with) expires around **2027-01-10**. Renew it around **2027-01-03**
    (`docs/scheduling.md`).
  - The Supabase deploy token (`SUPABASE_ACCESS_TOKEN`) never expires.
- **Cleanup list** (the next session):
  - **The `npm audit` warnings.**
  - **Generic rubric examples** instead of dated stories (the anchors overlap the
    preview days).
  - **A source health check.**
  - **Commit the audit report** (`ranking-audit.md`, on the DGX Spark only) under
    `docs/audits/`.
  - **Explicit grants in migrations 001 and 002** (see "Supabase change, Oct 30, 2026"
    below). Not done in PR #13, which left migrations alone.
- **Watch items:**
  - The same story twice in one MCP answer under different keys, e.g. an essay about
    the top story listed under builders. A possible fix is a same-day merge in the
    shared code.
  - The repeat memory warming up: right after PR #10 deployed, the history held only
    the previous morning, so early repeats were expected.
  - MI5-type explainers or recaps of never-shown older events (`DEC-019`). Revisit if
    they keep reaching Top stories.
- **Deferred:**
  - Reddit through the official API.
  - The full move to Supabase.
  - More policy and business sources (AP, Axios and Reuters have no usable feeds).
  - Discovery: a `SKILL.md`, MCP directory listings, and optionally Agensi.
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
    jobs only; a fresh GitHub OIDC token per exchange. Live since Nov 13, 2026; the
    `ANTHROPIC_API_KEY` fallback is for local runs and forks.
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
- **What the tuning PR (#10) adds** (`docs/digest.md`, "Repeats and updates"):
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
- **What the cleanup PR (#13) adds:**
  - **Lab names for HN links** (`LAB_PUBLISHERS`, `knownLab` in `source-names.ts`):
    "OpenAI (via HN)", listed once with the lab's own copy. Names match
    `SOURCE_DISPLAY_NAMES` (`blog.google` is "Google AI"). **Naming only**: the ranking reads
    `rankingOutlet` (strong sources, the per-outlet cap, `Story.breadth` for the "widely
    carried" tiebreak), which still sees the bare domain; readers see `itemOutlet`. The
    repeat check's `OUTLET_WORDS` still reads `PUBLISHERS` only. Don't merge the two maps.
    Naming-only is the owner's decision (2026-11-13, `DEC-021`).
  - **Retention** (`src/utils/retention.ts`): judged items rated ≤ 2 are deleted 14 days
    after fetching; unjudged keep 90. `CLEANUP_LOW_IMPORTANCE_MAX` (0 = off) and
    `CLEANUP_LOW_IMPORTANCE_DAYS` (8–90) as repository variables, set for the whole collect
    job: `npm run collect` and `npm run cleanup` both call `applyRetention` (`DEC-020`).
  - **The fallback summary** (`src/digest/summary.ts`): `createAnthropicClient`,
    `EDITOR_MODEL`, effort `low`, 1,024-token cap, 30 s timeout, one retry, at most 800
    characters (the intro must fit Discord's first message). Titles go in as data
    (`tagSafeJson` in `<items>`), like the editor's. Any failure leaves it out with a
    warning.
  - **The deploy checks `SUPABASE_PROJECT_REF`** first (`scripts/project-ref.sh`: trim,
    then 20 lowercase letters), tested in CI (`scripts/project-ref.test.sh`).
  - Removed: `better-sqlite3`, the SQLite docs, and the `digest` section's `priorities`,
    `schedule` and `maxItems` (only `adapter` is read).
- **Reddit is disabled.** It may return later via Reddit's official API, which needs a
  registered Reddit app and its own credentials. It was a secondary, community-reaction signal.
- The README's "Status & roadmap" section says the same thing. Keep the two in sync.

## Key Design Decisions
- **Pre-cached data, not on-demand scraping.** MCP calls read from DB — instant response, no waiting for scrapes.
- **Refresh interval (6h) is independent of data retention (90 days; 14 for items the editor rated 1–2, `DEC-020`).** Refresh = how often new data arrives. Retention = how far back users can look.
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

Auto-cleanup, by `npm run cleanup` and at the end of `npm run collect` (`src/utils/retention.ts`):
`fetched_at` older than 90 days, and rows with `editor_judged_at` set, `editor_importance <= 2` and
`fetched_at` older than 14 days. Unjudged rows keep the 90 days.

### Supabase change, Oct 30, 2026

Supabase stops granting Data API access automatically to **new** tables in `public`.
Any new table needs explicit `grant` statements in the same migration, matching its
RLS. Existing tables (`news_items`, `digest_state`) are unaffected. Migrations 001
and 002 have no explicit grants, which matters only for a fresh setup; it's on the
cleanup list.

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
Generated from `git ls-files` (2026-11-13). Regenerate it from there rather than editing by hand.
```
ai-newsroom/
├── .github/
│   ├── heartbeat.txt        # Generated by heartbeat.yml; nothing reads it
│   └── workflows/
│       ├── ci.yml           # PR + push-to-main checks (required to merge)
│       ├── collect.yml      # Collectors + cleanup (90 days; 14 if rated 1–2), then the AI editor; dispatched by Supabase Cron
│       ├── digest.yml       # The AI editor, then the daily digest; dispatched by Supabase Cron
│       ├── deploy-mcp.yml   # Deploys the MCP Edge Function on merge to main; smoke test
│       ├── editor-backfill.yml # Manual: AI editor over the last N days, higher caps
│       └── heartbeat.yml    # Weekly commit to the `heartbeat` branch; re-enables workflows
├── config/
│   ├── editor-rubric.md     # The AI editor's system prompt, versioned; tune here
│   └── sources.yaml         # Source definitions (enable/disable, URLs, types)
├── docs/
│   ├── DECISIONS.md         # Design decisions DEC-001…: alternatives, rationale, constraints
│   ├── TROUBLESHOOTING.md   # Problems met: symptom, root cause, approaches tried, fix, evidence
│   ├── digest.md            # The digest: stories, sections, fallback, layouts, preview
│   ├── editor.md            # AI editor: how it works, rubric, cost, re-judging, auth setup
│   ├── mcp.md               # MCP server: judgments, shared code, deploys, verifying what's live
│   ├── scheduling.md        # Supabase Cron → workflow_dispatch: why, setup, renewal, rollback
│   └── sessions/            # Engineering session write-ups
├── reviews/                 # Saved code-review reports
├── scripts/
│   ├── install-deno.sh      # Pinned, checksum-checked Deno for CI and the deploy
│   ├── project-ref.sh       # Trims and checks SUPABASE_PROJECT_REF before a deploy
│   ├── project-ref.test.sh  # Its tests (CI)
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
│   │   ├── generate.ts      # `npm run digest` (--dry-run, --preview): CLI, adapters, credentials
│   │   ├── run.ts           # One run: window, build, deliver, record in digest_state
│   │   ├── build.ts         # Items → digest document: editor stories, or the fallback
│   │   ├── repeats.ts       # 7-day story history; the repeat check; the key rule
│   │   ├── summary.ts       # The fallback's optional AI summary, on the editor's client
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
│       ├── supabase.ts      # Supabase client: upsert; the retention deletes (applyRetention)
│       ├── cleanup.ts       # `npm run cleanup`: both retention rules
│       ├── retention.ts     # Retention rules: 90 days; 14 for judged items rated ≤ 2; settings
│       ├── scoring.ts       # Relevance score 0-100 (recency / community / tier)
│       ├── slots.ts         # Re-export of the shared old ranking (the fallback)
│       ├── source-names.ts  # Re-export of the shared source names, publishers and labs
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
│   │   │       ├── source-names.ts  # Display names, publishers and labs by domain, lab/press/paper sources
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
- `npm run cleanup` — Both retention rules: 90 days, and 14 for judged items rated ≤ 2 (`CLEANUP_LOW_IMPORTANCE_*`). Deletes, so service key only, in practice on Actions after each collect. `npm run collect` ends with the same pass
- `npm run digest` — Generate and send the digest. Moves `digest_state.last_digest_at`: never run it just to test
- `npm run digest -- --preview --date YYYY-MM-DD [--layout plain|embeds] [--text] [--history] [--no-repeat-check]` — Print the digest for a past 9:00 AM ET window from stored judgments; replays the 7 mornings before to rebuild the history (repeat check with the local `ANTHROPIC_API_KEY`, ~$0.015; the old per-machine keys expire by about 2026-11-15, so a fresh one); anon key, never sends or writes
- `npm run digest -- --dry-run` — Print the real next digest without sending (service key)
- `npm run typecheck` — Type-check `src/` (note: `tsconfig.json` EXCLUDES `supabase/`)
- `npm run test:mcp` — MCP regression suite; no network or credentials needed
- `npm run test:collect` — collector regression suite (clean-up, dedup coverage, Anthropic parsers, retention rules); no network
- `npm run test:editor` — AI editor regression suite (validation, prompts, caps, editor-column guarantee, selection); no network
- `npm run test:digest` — digest regression suite (stories, sections, repeats and updates, history, why-line guard, publishers and labs, weak sources, caps, fallback and its summary, escaping, Discord limits, layouts, adapters, preview never sends); no network
- `npm run editor` — Judge unjudged items from the last 7 days (needs the service key, so in practice only on Actions)
- `npm run preview:editor -- --date YYYY-MM-DD [--dry-run] [--all]` — Old digest vs editor for a 9:00 AM ET window; read-only, anon key; `--dry-run` judges in memory with the local `ANTHROPIC_API_KEY`
- `npm run check:mcp` — `deno check` the Edge Function (needs Deno; CI also bundles it)
- `scripts/smoke-mcp.sh [URL] [COMMIT]` — Smoke-test the live MCP endpoint (reads only): 8 tools, the deployed commit, today's sections
- `scripts/project-ref.test.sh` — tests for the deploy's `SUPABASE_PROJECT_REF` check; no network
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
2. **Edge Function check** (Deno 2.9.8 via `scripts/install-deno.sh`; the repo's Actions
   policy allows GitHub-owned actions only): `deno check`, every local import under
   `supabase/functions/` (or the deploy won't upload it), and `deno bundle`
3. `npm run test:mcp`, `npm run test:collect`, `npm run test:editor`, `npm run test:digest`
   and `scripts/project-ref.test.sh`
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

**On a development machine** `.env` holds only `SUPABASE_URL`, `SUPABASE_ANON_KEY`
(read-only) and `ANTHROPIC_API_KEY`:
- **No service key on dev machines.** Writes happen on GitHub Actions.
- **One Anthropic key per machine.** The old ones are ending (`ai-newsroom-local`
  expired on 2026-11-13, `ai-newsroom-mac-local` expires around 2026-11-15); create a
  fresh one only when a model-backed
  preview is wanted. Without one, the digest preview uses the key rule and
  `npm run preview:editor -- --dry-run` refuses to run.
- **Never `source .env` in the terminal you start Claude Code from.** Claude Code
  then picks up `ANTHROPIC_API_KEY` and bills the API instead of the Max login.
  This happened once. The npm scripts load `.env` themselves, through `dotenv`.

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

# Claude API key: local runs (editor --dry-run, the preview's repeat check and fallback summary),
# and forks without federation. This repository's GitHub runs use federation and have no key.
ANTHROPIC_API_KEY=sk-ant-...

# Claude on Actions: workload identity federation, as repository VARIABLES (not secrets); live
ANTHROPIC_FEDERATION_RULE_ID=fdrl_...
ANTHROPIC_ORGANIZATION_ID=...
ANTHROPIC_SERVICE_ACCOUNT_ID=svac_...
ANTHROPIC_WORKSPACE_ID=wrkspc_...   # only if the rule covers several workspaces
# Optional tuning: EDITOR_MODEL, EDITOR_EFFORT, EDITOR_MAX_ITEMS, EDITOR_MAX_CALLS, ... (docs/editor.md)

# Digest (optional; repository VARIABLES on Actions, docs/digest.md)
DIGEST_LAYOUT=plain   # or embeds
# Thresholds: DIGEST_TOP_MIN_IMPORTANCE=6, DIGEST_TOP_LIMIT=5, ..., DIGEST_MIN_JUDGED_SHARE=0.5,
# DIGEST_TOP_WEAK_SOURCE_MIN_IMPORTANCE=8, DIGEST_MAX_PER_OUTLET=2, DIGEST_REPEAT_EFFORT=medium

# Retention (optional; repository VARIABLES on Actions, set for the whole collect job)
CLEANUP_LOW_IMPORTANCE_MAX=2    # judged items rated this or lower...; 0 switches the rule off
CLEANUP_LOW_IMPORTANCE_DAYS=14  # ...are deleted this many days after fetching (8-90)
```
