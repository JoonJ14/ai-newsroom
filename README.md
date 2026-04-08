# AI Newsroom

> Keeping up with AI news is a full-time job. Let your AI do it instead.

**AI Newsroom** is a real-time AI/tech news aggregator that scrapes 22+ sources every 6 hours and makes everything available via MCP. Connect it to Claude Code, Claude Desktop, or any MCP client — one command, no install, no auth.

Ask Claude *"what's new in AI today?"* and get a real answer, not stale training data.

---

## Quick Start — one command, zero config

### Claude Code
```bash
claude mcp add --transport http ai-newsroom https://jialdowpnekknmxrwrdq.supabase.co/functions/v1/mcp
```

### Claude Desktop / Any MCP Client
Add to your MCP config:
```json
{
  "mcpServers": {
    "ai-newsroom": {
      "type": "http",
      "url": "https://jialdowpnekknmxrwrdq.supabase.co/functions/v1/mcp"
    }
  }
}
```

That's it. Start asking questions.

---

## What problem does this solve?

| Problem | AI Newsroom |
|---------|-------------|
| Claude doesn't know what happened after training cutoff | 22+ sources scraped every 6h, always current |
| Asking Claude to search is slow and shallow | Pre-cached in DB, MCP returns instantly |
| Too many sources to check manually | Aggregated from blogs, Reddit, HN, ArXiv, GitHub, HuggingFace |
| Hard to know what's actually important | Community scores + optional AI relevance filtering |
| Miss weekend announcements on Monday | 7-day retention — nothing gets lost |

---

## Sources

### Company Blogs & Official Channels
Anthropic Blog, Anthropic Developer Changelog, Claude Code GitHub Releases, OpenAI News, OpenAI Codex CLI Releases, Google AI Blog, Google Research Blog, NVIDIA Developer Blog

### Community Signal
Hacker News (Top + Show HN), Reddit (r/ClaudeAI, r/LocalLLaMA, r/MachineLearning, r/artificial), HuggingFace Daily Papers, HuggingFace Trending Spaces, GitHub Trending, Dev.to AI

### Research
ArXiv cs.AI, ArXiv cs.LG, ArXiv cs.CV

### Industry News
InfoQ AI & ML, The New Stack AI

### GitHub Release Watching
anthropics/claude-code, openai/codex, vllm-project/vllm

---

## MCP Tools

| Tool | What it does |
|------|-------------|
| `get_top_picks` | Smart slotted display: official announcements, community highlights, research, industry — with diversity caps |
| `get_trending` | All cached news. Filter by `source` or `category` |
| `search` | Full-text search across titles and summaries |
| `get_new_since` | Everything added after a timestamp — "what's new since Friday?" |
| `get_source_updates` | Items from one specific source |
| `check_status` | Cache health: last updated, item counts, per-source breakdown |

---

## Optional: Personal Digest

Get a daily AI news briefing delivered to your messaging app, filtered by topics you care about.

### Supported platforms
- **Discord** — webhook (easiest setup)
- **Telegram** — bot API
- **Slack** — incoming webhook
- **iMessage** — macOS only

### Setup
1. Copy `config/sources.yaml` and customize the `digest` section
2. Set your delivery adapter and webhook URL in `.env`
3. Optionally set `ANTHROPIC_API_KEY` for AI-powered relevance filtering
4. Add a cron job: `0 7 * * * cd /path/to/ai-newsroom && npm run digest`

The digest pulls the latest items, scores them against your configured priority topics, and sends a formatted summary to your chosen platform.

---

## Self-Hosting

Don't want to use the hosted endpoint? Run everything locally.

### With Supabase (recommended)
```bash
git clone https://github.com/joonj14/ai-newsroom
cd ai-newsroom
npm install

# Set up your Supabase project and add credentials to .env
cp .env.example .env

# Run the database migration
supabase db push

# Collect news manually
npm run collect

# Deploy the MCP Edge Function
supabase functions deploy mcp
```

### With SQLite (fully local, no external services)
```bash
git clone https://github.com/joonj14/ai-newsroom
cd ai-newsroom
npm install

# Enable local mode
echo "NEWSROOM_STORAGE=sqlite" >> .env
echo "NEWSROOM_DB_PATH=./data/newsroom.db" >> .env

# Collect news
npm run collect

# Run MCP server locally
npm run dev:mcp
```

### Customizing Sources
Edit `config/sources.yaml` to enable/disable individual sources or entire groups:

```yaml
# Disable all Reddit sources at once
# In the sources list, set enabled: false for each reddit source

# Or use source groups to quickly filter
# Only want Anthropic + community? Enable those groups, disable the rest
```

---

## How It Works

```
┌─────────────────────────────────────────────────────────┐
│  GitHub Actions (every 6h)                              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐   │
│  │ RSS      │ │ Reddit   │ │ GitHub   │ │ HN API   │   │
│  │ Collector│ │ Collector│ │ Collector│ │ Collector│   │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘   │
│       └─────────────┴────────────┴─────────────┘        │
│                         │ write                         │
└─────────────────────────┼───────────────────────────────┘
                          ▼
                 ┌─────────────────┐
                 │    Supabase     │
                 │   PostgreSQL    │
                 │  (news_items)   │
                 └────────┬────────┘
                          │ read
              ┌───────────┼───────────┐
              ▼           ▼           ▼
     ┌──────────────┐ ┌────────┐ ┌────────────┐
     │ MCP Server   │ │ Digest │ │ Direct SQL │
     │ (Edge Func)  │ │ Script │ │ (self-host)│
     └──────┬───────┘ └───┬────┘ └────────────┘
            │              │
            ▼              ▼
     Claude Code      Discord/
     Claude Desktop   Telegram/
     Cursor/etc.      Slack
```

---

## Contributing

Issues and PRs welcome. If you want to add a new source:

1. Add the source definition to `config/sources.yaml`
2. If it uses a new collector type, implement it in `src/collectors/`
3. Test with `npm run collect -- --source your_source_id`
4. Submit a PR

---

## License

MIT — do whatever you want with it.

---

Built by [Joon Jung](https://github.com/joonj14)
