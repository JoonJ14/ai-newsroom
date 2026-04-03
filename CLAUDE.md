# AI Newsroom - Project Context

## What This Project Is
AI Newsroom is an open-source, real-time AI/tech news aggregator exposed as an MCP (Model Context Protocol) server. It scrapes 22+ sources every 6 hours, stores results in Supabase, and lets anyone query fresh AI news from Claude Code, Claude Desktop, or any MCP-compatible client with a single command.

## Architecture Overview

### Four Layers
1. **Collectors** (`src/collectors/`) — TypeScript modules that fetch and normalize data from each source type (RSS, JSON API, GitHub API, HTML scrape). Each collector outputs a common schema: `{ title, url, source, sourceCategory, score, summary, timestamp }`. Triggered by GitHub Actions on a 6-hour cron schedule.

2. **Storage** (Supabase) — PostgreSQL database via Supabase free tier. Single `news_items` table with auto-cleanup of items older than 7 days. Edge Functions serve the MCP endpoint.

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
- **Refresh interval (6h) is independent of data retention (7 days).** Refresh = how often new data arrives. Retention = how far back users can look.
- **GitHub Actions for collectors, not Supabase cron.** More transparent, forkable, and decoupled from storage layer.
- **TypeScript everywhere.** MCP ecosystem is TS-native; Supabase Edge Functions run Deno (TS); keeps one language across the project.
- **Source customization via config.** Users can enable/disable individual sources or source groups without touching code.

## Database Schema
Single table `news_items`:
```sql
CREATE TABLE news_items (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  source_category TEXT NOT NULL,
  score INTEGER DEFAULT 0,
  summary TEXT,
  authors TEXT,
  fetched_at TIMESTAMPTZ DEFAULT NOW(),
  published_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX idx_news_items_source ON news_items(source);
CREATE INDEX idx_news_items_fetched_at ON news_items(fetched_at);
CREATE INDEX idx_news_items_source_category ON news_items(source_category);
```

Auto-cleanup via pg_cron or collector job: `DELETE FROM news_items WHERE fetched_at < NOW() - INTERVAL '7 days'`

## MCP Tools
| Tool | Description | Parameters |
|------|-------------|------------|
| `get_trending` | All cached news, optionally filtered by source or category | `source?`, `category?`, `limit?` |
| `get_top_picks` | Top N items ranked by score | `n` (default 10) |
| `search` | Keyword search across titles and summaries | `query`, `since?` |
| `get_new_since` | Items added after a timestamp | `since` (ISO 8601) |
| `get_source_updates` | Items from a specific source | `source`, `limit?` |
| `get_repo_quickstart` | GitHub repo metadata + README quickstart | `repo` (owner/name) |
| `get_paper_brief` | ArXiv paper abstract and metadata | `arxiv_id` |
| `check_status` | Cache status, last updated, per-source breakdown | — |

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
│   ├── mcp/
│   │   └── tools.ts         # MCP tool definitions and handlers
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
│   │       └── index.ts     # Edge Function: MCP server endpoint
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
- `npm run dev:mcp` — Run MCP server locally for testing
- `supabase functions serve mcp` — Run Edge Function locally

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
