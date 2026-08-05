# AI Newsroom - Project Context

## What This Project Is
AI Newsroom is an open-source, real-time AI/tech news aggregator exposed as an MCP (Model Context Protocol) server. It scrapes 35 sources every 6 hours, stores results in Supabase, and lets anyone query fresh AI news from Claude Code, Claude Desktop, or any MCP-compatible client with a single command.

## Architecture Overview

### Four Layers
1. **Collectors** (`src/collectors/`) — TypeScript modules that fetch and normalize data from each source type (RSS, JSON API, GitHub API, HTML scrape). Each collector outputs a common schema: `{ title, url, source, sourceCategory, score, summary, timestamp }`. Triggered by GitHub Actions on a 6-hour cron schedule.

2. **Storage** (Supabase) — PostgreSQL database via Supabase free tier. Single `news_items` table with auto-cleanup of items older than 90 days. Edge Functions serve the MCP endpoint.

3. **MCP Server** (`supabase/functions/mcp/`) — Supabase Edge Function implementing the MCP protocol. Exposes tools: `get_trending`, `get_top_picks`, `search`, `get_new_since`, `get_source_updates`, `get_repo_quickstart`, `get_paper_brief`, `check_status`.

4. **Digest Delivery** (`src/digest/`) — Optional personal layer. Pulls latest items, filters by user-configured priority topics via Claude API, formats a briefing, and sends to Discord/Telegram/Slack/iMessage webhook. Runs on user's local machine via cron.

### Tech Stack
- **Language:** TypeScript throughout
- **Runtime:** Node.js for collectors, Deno for Supabase Edge Functions
- **Database:** Supabase PostgreSQL (hosted) or SQLite (self-hosted option)
- **CI/CD:** GitHub Actions for scheduled collection
- **MCP Protocol:** HTTP transport via Supabase Edge Function

## Source Configuration
Sources are defined in `config/sources.yaml`. Each source has:
- `id`: unique identifier (e.g., `anthropic_blog`)
- `name`: display name
- `type`: `rss` | `json_api` | `github_releases` | `github_trending` | `html_scrape`
- `url`: fetch endpoint
- `category`: `company_blog` | `community` | `research` | `industry_news` | `github`
- `enabled`: boolean
- `refreshIntervalHours`: override per-source if needed

## Key Design Decisions
- **Pre-cached data, not on-demand scraping.** MCP calls read from DB — instant response, no waiting for scrapes.
- **Refresh interval (6h) is independent of data retention (90 days).** Refresh = how often new data arrives. Retention = how far back users can look.
- **GitHub Actions for collectors, not Supabase cron.** More transparent, forkable, and decoupled from storage layer.
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
```
ai-newsroom/
├── .github/workflows/
│   └── collect.yml          # GitHub Actions: runs collectors every 6h
├── config/
│   └── sources.yaml         # Source definitions (enable/disable, URLs, types)
├── src/
│   ├── collectors/
│   │   ├── index.ts         # Orchestrator: loads sources.yaml, runs enabled collectors
│   │   ├── rss.ts           # RSS/Atom feed collector
│   │   ├── reddit.ts        # Reddit JSON API collector
│   │   ├── hackernews.ts    # HackerNews API collector
│   │   ├── github.ts        # GitHub trending + release watcher
│   │   ├── huggingface.ts   # HuggingFace papers + spaces
│   │   ├── scraper.ts       # Generic HTML scraper (fallback)
│   │   └── types.ts         # Shared types: NewsItem, Source, etc.
│   ├── digest/
│   │   ├── generate.ts      # Pull data, filter by relevance, format briefing
│   │   ├── adapters/
│   │   │   ├── discord.ts   # Discord webhook adapter
│   │   │   ├── telegram.ts  # Telegram bot adapter
│   │   │   ├── slack.ts     # Slack incoming webhook adapter
│   │   │   └── imessage.ts  # iMessage adapter (macOS only)
│   │   └── config.ts        # Personal digest configuration
│   └── utils/
│       ├── supabase.ts      # Supabase client setup
│       ├── sqlite.ts        # SQLite client (self-hosted option)
│       └── logger.ts        # Logging utility
├── supabase/
│   ├── functions/
│   │   └── mcp/
│   │       ├── index.ts     # Edge Function: JSON-RPC entry point + tool routing
│   │       ├── test.ts      # Local test harness (runs under Node, not Deno)
│   │       └── _shared/
│   │           ├── tools.ts     # Tool definitions: names, descriptions, input schemas
│   │           ├── handlers.ts  # Handlers backed by the news_items cache
│   │           ├── external.ts  # Handlers backed by live GitHub / ArXiv lookups
│   │           └── slots.ts     # Category slotting + display formatting
│   └── migrations/
│       └── 001_create_news_items.sql
├── CLAUDE.md                # This file
├── README.md
├── package.json
├── tsconfig.json
├── .gitignore
└── LICENSE
```

## Commands
- `npm run collect` — Run all enabled collectors once (manual trigger)
- `npm run collect -- --source anthropic_blog` — Run a single collector
- `npm run digest` — Generate and send personal digest
- `supabase functions serve mcp` — Run Edge Function locally (this is the MCP server endpoint)

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

# Claude API (optional, for relevance filtering in digest)
ANTHROPIC_API_KEY=sk-ant-...

# Self-hosted mode (optional, uses SQLite instead of Supabase)
NEWSROOM_STORAGE=sqlite
NEWSROOM_DB_PATH=./data/newsroom.db
```
