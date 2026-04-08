# AI Newsroom

> Keeping up with AI news is a full-time job. Let your AI do it instead.

**AI Newsroom** is a real-time AI/tech news aggregator that scrapes 22+ sources every 6 hours and makes everything available via MCP (Model Context Protocol). Connect it to Claude Code, Claude Desktop, or any MCP client — one command, no install, no auth.

Ask Claude *"what's new in AI today?"* and get a real answer, not stale training data.

> **Don't want to set anything up? I built this for you and for all of us. Just join our Discord and get daily AI news delivered automatically at noon Eastern.**
> 
> **[Join the AI Newsroom Discord](https://discord.gg/xUCRZq9c)**

---

## What problem does this solve?

| Problem | AI Newsroom |
|---------|-------------|
| Claude doesn't know what happened after training cutoff | 22+ sources scraped every 6h, always current |
| Asking Claude to search is slow and shallow | Pre-cached in DB, MCP returns instantly |
| Too many sources to check manually | Aggregated from blogs, Reddit, HN, ArXiv, GitHub, HuggingFace |
| Hard to know what's actually important | Relevance scoring + AI filtering separates signal from noise |
| Miss weekend announcements on Monday | 90-day retention — nothing gets lost |

---

## Quick Start — Connect to AI News in 60 Seconds

Pick your platform and follow the steps. You don't need to install anything or create any accounts — our hosted endpoint is free and public.

### Option A: Claude Code (Terminal)

If you use Claude Code in your terminal, this takes one command:

1. Open your terminal
2. Copy and paste this entire line:
   ```bash
   claude mcp add --transport http ai-newsroom https://jialdowpnekknmxrwrdq.supabase.co/functions/v1/mcp
   ```
3. Start a new Claude Code session by typing `claude`
4. Try asking: **"What's new in AI today?"**

That's it! Claude now has access to real-time AI news. Try these follow-up questions:
- "What are the latest Anthropic announcements?"
- "Any interesting AI papers this week?"
- "Search for news about Claude Code"
- "What did I miss since Friday?"

### Option B: Claude Desktop (Mac/Windows App)

If you use the Claude desktop app:

1. Open Claude Desktop
2. Click the menu icon (three horizontal lines) in the top-left corner
3. Click **Settings**
4. In the left sidebar, click **Developer**
5. Click **Edit Config** — this opens a text file called `claude_desktop_config.json`
6. If the file is empty, paste this entire block:
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
   If the file already has content (other MCP servers), add the `"ai-newsroom": { ... }` block inside the existing `"mcpServers"` section, separated by a comma.
7. Save the file (Ctrl+S or Cmd+S)
8. Completely quit and reopen Claude Desktop (not just close the window — fully quit the app)
9. Start a new conversation and try: **"What's the latest AI news?"**

### Option C: Cursor IDE

1. Open the Command Palette: press `Cmd+Shift+P` (Mac) or `Ctrl+Shift+P` (Windows/Linux)
2. Type "Cursor Settings" and select it
3. Go to the **MCP** section
4. Click **Add new MCP server**
5. Fill in:
   - **Name:** `ai-newsroom`
   - **Type:** `http`
   - **URL:** `https://jialdowpnekknmxrwrdq.supabase.co/functions/v1/mcp`
6. Save and restart Cursor
7. In the AI chat, ask: **"What's trending in AI right now?"**

### Option D: Any MCP-Compatible Client

Add this to your MCP configuration:
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

---

## What can you ask?

Once connected, just talk to Claude naturally. Here are some examples:

| What you want | What to ask |
|---|---|
| Quick daily briefing | "What's new in AI today?" |
| Specific company news | "Any Anthropic announcements this week?" |
| Search for a topic | "Search for news about MCP" |
| Catch up after time off | "What did I miss since Friday?" |
| Deep dive on trending | "Show me what's hot on HackerNews and Reddit" |
| Research papers | "Any interesting AI papers published recently?" |
| Release tracking | "What's the latest Claude Code version?" |
| Full firehose | "Show me all the news, no limits" |
| System health | "How fresh is the AI news data?" |

---

## Daily Digest — Get AI News Delivered to You

Instead of asking Claude for news, you can have a formatted daily briefing automatically sent to Discord, Telegram, Slack, or iMessage every day. Here's how to set it up for each platform.

### Discord Setup

#### Path 1: Join our Discord (zero setup)

Just join and the daily digest lands in your feed automatically. No accounts, no webhooks, no config files.

**[Join the AI Newsroom Discord](https://discord.gg/xUCRZq9c)** — daily AI news at noon Eastern.

#### Path 2: Run your own Discord digest

Want the digest in your own server? Follow these steps.

**Step 1: Create a Discord webhook**

If you already have a Discord server you want to use, skip to step 5.

1. Download Discord from [discord.com](https://discord.com) if you don't have it
2. Open Discord and click the **+** icon on the left sidebar to create a new server
3. Select **Create My Own**, then **For me and my friends**
4. Give it a name like "My AI News" and click Create
5. You'll see a **#general** channel — this is where your digest will appear
6. Click the **gear icon** next to the #general channel name (channel settings)
7. Click **Integrations** in the left sidebar
8. Click **Webhooks**
9. Click **New Webhook**
10. Give it a name like "AI Newsroom Bot" (this name appears as the sender)
11. Click **Copy Webhook URL** — save this URL somewhere safe, you'll need it next

**Step 2: Choose how to run the digest**

**Method A: GitHub Actions (recommended — runs automatically even if your computer is off)**

1. Go to [github.com/JoonJ14/ai-newsroom](https://github.com/JoonJ14/ai-newsroom) and click **Fork** (top-right button) to create your own copy
2. In your forked repo, click **Settings** (tab at the top)
3. In the left sidebar, click **Secrets and variables**, then **Actions**
4. Click **New repository secret** and add these three secrets one at a time:

   | Secret name | Value |
   |---|---|
   | `SUPABASE_URL` | `https://jialdowpnekknmxrwrdq.supabase.co` |
   | `SUPABASE_SERVICE_KEY` | Open your `.env` file to find this value (run `cat .env` in the project directory) |
   | `DISCORD_WEBHOOK_URL` | The webhook URL you copied in Step 1 |

5. The digest will now run **automatically every day at noon Eastern time**
6. To send one right now: go to the **Actions** tab, click **Daily AI News Digest**, click **Run workflow**

**Method B: Run on your own computer**

1. Clone the repo and install:
   ```bash
   git clone https://github.com/JoonJ14/ai-newsroom
   cd ai-newsroom
   npm install
   ```
2. Create a `.env` file in the project folder with these lines:
   ```
   SUPABASE_URL=https://jialdowpnekknmxrwrdq.supabase.co
   SUPABASE_SERVICE_KEY=your-service-key-here
   DISCORD_WEBHOOK_URL=your-webhook-url-from-step-1
   ```
   Replace `your-service-key-here` and `your-webhook-url-from-step-1` with your actual values.
3. Test without sending (just prints to your terminal):
   ```bash
   npm run digest -- --dry-run
   ```
4. Send a real test to Discord:
   ```bash
   npm run digest
   ```
5. Set up automatic daily delivery (optional):
   ```bash
   # Sends every day at noon
   ./scripts/setup-cron.sh 12 0

   # Or pick a different time — this does 8:00 AM
   ./scripts/setup-cron.sh 8 0
   ```
6. To stop the automatic digest: run `crontab -e` and delete the lines that mention `ai-newsroom`
7. Note: your computer must be on at the scheduled time for this to work. If your computer is off, the digest won't send that day.

### Telegram Setup

1. Open Telegram and search for **@BotFather**
2. Send the message `/newbot`
3. Follow the prompts: choose a name and username for your bot
4. BotFather will give you a **bot token** — copy it and save it
5. Open a chat with your new bot and send any message (like "hello")
6. Open this URL in your browser (replace `YOUR_TOKEN` with your actual token):
   ```
   https://api.telegram.org/botYOUR_TOKEN/getUpdates
   ```
7. Look for `"chat":{"id":123456789}` in the response — that number is your **chat ID**
8. Add these lines to your `.env` file:
   ```
   TELEGRAM_BOT_TOKEN=your-bot-token
   TELEGRAM_CHAT_ID=your-chat-id
   ```
9. Open `config/sources.yaml` and change the `adapter` line in the digest section to:
   ```yaml
   adapter: telegram
   ```
10. Test it: `npm run digest`

### Slack Setup

1. Go to your Slack workspace in a browser
2. Visit the [Incoming Webhooks page](https://my.slack.com/services/new/incoming-webhook/) in Slack's App Directory
3. Choose which channel should receive the digest (e.g., #ai-news)
4. Click **Add Incoming WebHooks Integration**
5. Copy the **Webhook URL** it gives you
6. Add this line to your `.env` file:
   ```
   SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
   ```
7. Open `config/sources.yaml` and change the `adapter` line in the digest section to:
   ```yaml
   adapter: slack
   ```
8. Test it: `npm run digest`

### iMessage Setup (macOS only)

This only works on Mac computers with the Messages app signed in.

1. Add this line to your `.env` file (use your phone number or Apple ID email):
   ```
   IMESSAGE_RECIPIENT=+1234567890
   ```
2. Open `config/sources.yaml` and change the `adapter` line in the digest section to:
   ```yaml
   adapter: imessage
   ```
3. Test it: `npm run digest`
4. Your Mac will ask for permission the first time — click Allow

---

## Sources (22+)

### Company Blogs & Official Channels
Anthropic Blog, Anthropic Developer Changelog, Claude Code GitHub Releases, OpenAI News, OpenAI Codex CLI Releases, Google AI Blog, Google Research Blog, NVIDIA Developer Blog

### Community Signal
Hacker News (Top + Show HN), Reddit (r/ClaudeAI, r/LocalLLaMA, r/MachineLearning, r/artificial), HuggingFace Daily Papers, HuggingFace Trending Spaces, GitHub Trending, Dev.to AI

### Research
ArXiv cs.AI, ArXiv cs.LG (Machine Learning), ArXiv cs.CV (Computer Vision)

### Industry News
InfoQ AI & ML, The New Stack AI

### GitHub Release Watching
anthropics/claude-code, openai/codex, vllm-project/vllm

---

## MCP Tools

These are the tools Claude uses behind the scenes when you ask questions:

| Tool | What it does |
|------|-------------|
| `get_top_picks` | Smart display organized by category: official announcements first, then community, research, and industry news — with diversity caps so no single source dominates |
| `get_trending` | All cached news items, optionally filtered by source or category |
| `search` | Full-text search across titles and summaries |
| `get_new_since` | Everything added after a timestamp — perfect for "what did I miss?" |
| `get_source_updates` | Latest items from one specific source |
| `check_status` | Cache health: when data was last updated, total items, per-source breakdown |

---

## Customizing Sources

All source configuration lives in `config/sources.yaml`. You can customize what gets collected without touching any code.

### Enable or disable individual sources

Find the source in the file and change `enabled: true` to `enabled: false`:
```yaml
- id: reddit_artificial
  name: r/artificial
  type: reddit
  url: https://www.reddit.com/r/artificial/hot.json
  category: community
  enabled: false  # changed from true — this source will be skipped
```

### Change digest priority topics

The `digest.priorities` section controls what topics get highlighted in your daily briefing. Adjust keywords and weights (higher weight = more important):
```yaml
digest:
  priorities:
    - label: "Anthropic & Claude Code updates"
      keywords: [anthropic, claude, claude-code, sonnet, opus, haiku, mcp]
      weight: 10    # highest priority
    - label: "OpenAI & Codex updates"
      keywords: [openai, codex, gpt, chatgpt]
      weight: 9
```

### Add a new source

1. Add it to `config/sources.yaml` with the right `type` (`rss`, `reddit`, `json_api`, `github_releases`, `github_trending`, `hackernews_algolia`, or `html_scrape`)
2. If it uses an existing type, it just works
3. If it needs a new scraper, implement it in `src/collectors/`
4. Test with `npm run collect -- --source your_source_id`

---

## Self-Hosting

Don't want to use the hosted endpoint? Run everything on your own infrastructure.

### With Supabase (recommended)
```bash
git clone https://github.com/JoonJ14/ai-newsroom
cd ai-newsroom
npm install

# Create a Supabase project at supabase.com and add credentials to .env
cp .env.example .env
# Edit .env with your Supabase URL and service key

# Run the database migration
supabase db push

# Collect news manually
npm run collect

# Deploy the MCP Edge Function
supabase functions deploy mcp --no-verify-jwt
```

### With SQLite (fully local, no external services)
```bash
git clone https://github.com/JoonJ14/ai-newsroom
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

## Troubleshooting

**"Claude doesn't seem to know about AI news"**
Make sure the MCP server is connected. In Claude Code, run `claude mcp list` to check. In Claude Desktop, restart the app after editing the config file.

**"Discord message not appearing"**
Check that your webhook URL is correct and hasn't been regenerated. Go back to your Discord channel settings > Integrations > Webhooks and verify the URL matches what's in your `.env` file.

**"Digest says 'No new AI news since your last digest'"**
This means no new items were collected since the last run. The collectors run every 6 hours — try running `npm run collect` first to fetch fresh data, then `npm run digest`.

**"npm run collect fails with 'Missing SUPABASE_URL'"**
You need a `.env` file in the project root with your Supabase credentials. See the Self-Hosting section above.

**"Some sources show 0 items"**
This is normal. Some sources (like Google Research Blog) publish infrequently. Others (like Reddit) may occasionally return errors due to rate limiting. The pipeline is designed to continue even when individual sources fail.

---

## Contributing

Issues and PRs welcome! If you want to add a new source:

1. Add the source definition to `config/sources.yaml`
2. If it uses a new collector type, implement it in `src/collectors/`
3. Test with `npm run collect -- --source your_source_id`
4. Submit a PR

---

## License

MIT — do whatever you want with it.

---

Built by [Joon Jung](https://github.com/joonj14)
