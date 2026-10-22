# AI Newsroom

> Keeping up with AI news is a full-time job. Let your AI do it instead.

**AI Newsroom** is a real-time AI/tech news aggregator that collects from 30 sources every 6 hours and makes everything available via MCP (Model Context Protocol). Connect it to Claude Code, Claude Desktop, or any MCP client — one command, no install, no auth.

Ask Claude *"what's new in AI today?"* and get a real answer, not stale training data.

> **Don't want to set anything up? I built this for you and for all of us. Just join our Discord and get daily AI news delivered automatically at 9:00 AM Eastern.**
> 
> **[Join the AI Newsroom Discord](https://discord.gg/xUCRZq9c)**

---

## Status & roadmap

- **The ranking rebuild is complete.** The four steps, each its own PR:
  1. Fix collection: broken and dead sources, title clean-up, cross-source coverage in dedup (done).
  2. An AI editor that judges each item once, at collection time, and stores the judgment (done). Claude Haiku 5.5 reads each item against a written rubric (`config/editor-rubric.md`) and stores its type, importance (1–10), audience, a plain headline, why it matters, and a story key that groups copies and follow-ups. Details: [`docs/editor.md`](docs/editor.md).
  3. The daily digest built on the judgments (done, now being tuned). Stories instead of items: Top stories, Also notable, For builders and a Paper of note, each with a plain headline, a why-it-matters line and the outlets that carried it, as clickable links. The editor runs just before the digest. If its judgments are missing, the digest falls back to the old ranking and the footer says so. Two Discord layouts, `plain` (default) and `embeds`, chosen with the `DIGEST_LAYOUT` variable. Preview any past morning with `npm run digest -- --preview --date YYYY-MM-DD`. Since the first week's tuning it works like a daily newspaper: a story already shown in the last 7 days isn't shown again unless it develops, and then it is marked "Update:". One small Claude call per morning checks for that. Weak sources can't lead, at most two stories per outlet per section, Hacker News links name the real publisher, and why-lines that describe the coverage instead of the news are replaced. Details: [`docs/digest.md`](docs/digest.md).
  4. The MCP server serves the same judgments with the same story code as the digest (done). `get_top_picks` returns the digest's sections for any window, the other news tools group copies into stories ranked by importance, and every story carries the editor's headline, why-line, importance, type, audience and outlets. New optional filters: `min_importance`, `type`, `audience`. The server now deploys automatically on every merge to `main`, with a smoke test, and `check_status` reports which commit is live. Details: [`docs/mcp.md`](docs/mcp.md).
- **Reddit is disabled.** It may return later via Reddit's official API, which needs a registered Reddit app and its own credentials. It was a secondary, community-reaction signal.
- **Recent change (Oct 2026):** scheduling moved to **Supabase Cron**. GitHub's own scheduler was delivering the daily digest 3–6 hours late. Supabase now starts the GitHub Actions runs at fixed times, and the digest targets **9:00 AM ET** year-round. The runs themselves still happen on GitHub Actions. Details: [`docs/scheduling.md`](docs/scheduling.md).
- **Under consideration:** moving collectors and digest entirely into Supabase Edge Functions. We're running the hybrid setup first and will revisit if having two platforms causes trouble. That move has real costs:
  - Edge Functions have CPU-time and wall-clock limits that a 30-source scrape would have to fit within.
  - Some sources may block requests from cloud-provider IPs.
  - Deploys would no longer happen automatically when a PR merges to `main`.

---

## What problem does this solve?

| Problem | AI Newsroom |
|---------|-------------|
| Claude doesn't know what happened after training cutoff | 30 sources collected every 6h, always current |
| Asking Claude to search is slow and shallow | Pre-cached in DB, MCP returns instantly |
| Too many sources to check manually | Aggregated from AI labs, the tech press, HN, ArXiv, GitHub, HuggingFace |
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

### Option D: Google AntiGravity IDE

1. Open AntiGravity
2. Click the **...** (three dots) button at the top of the Agent panel (right side)
3. Click **MCP Servers** — this opens the MCP Store
4. At the top, click **Manage MCP Servers**
5. Click **View raw config** — this opens `mcp_config.json`
6. Add the following to the config (if the file already has other MCP servers, add the `"ai-newsroom"` entry inside the existing `"mcpServers"` section, separated by a comma):
   ```json
   {
     "mcpServers": {
       "ai-newsroom": {
         "command": "npx",
         "args": ["-y", "mcp-remote", "https://jialdowpnekknmxrwrdq.supabase.co/functions/v1/mcp"]
       }
     }
   }
   ```
7. Save and close the config
8. Fully quit and restart AntiGravity (just closing the agent panel is not enough — the MCP tools load on startup)
9. In the Agent panel, ask: **"What's the latest AI news?"**

> **Note:** AntiGravity requires Node.js installed on your machine for `npx` to work. If you don't have it, download it from [nodejs.org](https://nodejs.org).

### Option E: Any Other MCP-Compatible Client

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
| Deep dive on trending | "Show me what's hot on HackerNews" |
| Research papers | "Any interesting AI papers published recently?" |
| Read a specific paper | "What's arXiv 2501.12948 about?" |
| Try a repo you just saw | "How do I get started with anthropics/claude-code?" |
| Release tracking | "What's the latest Claude Code version?" |
| Full firehose | "Show me all the news, no limits" |
| System health | "How fresh is the AI news data?" |

---

## Daily Digest — Get AI News Delivered to You

Instead of asking Claude for news, you can have a formatted daily briefing automatically sent to Discord, Telegram, Slack, or iMessage every day. It leads with the day's top stories as ranked by the AI editor, each with a plain headline, a line on why it matters and the outlets that carried it ([`docs/digest.md`](docs/digest.md)). Here's how to set it up for each platform.

### Discord Setup

#### Path 1: Join our Discord (zero setup)

Just join and the daily digest lands in your feed automatically. No accounts, no webhooks, no config files.

**[Join the AI Newsroom Discord](https://discord.gg/xUCRZq9c)** — daily AI news at 9:00 AM Eastern.

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
   | `SUPABASE_SERVICE_KEY` | Only needed if self-hosting your own Supabase. If using the hosted endpoint above, skip this secret. |
   | `DISCORD_WEBHOOK_URL` | The webhook URL you copied in Step 1 |

5. Turn on a schedule. The workflows in this repo have no active `schedule:` trigger: the upstream project starts them from Supabase Cron instead (see [`docs/scheduling.md`](docs/scheduling.md)). A fork needs **one** of these:
   - **Simple:** in your fork, edit `.github/workflows/digest.yml` (and `collect.yml` if you run your own collectors) and uncomment the `schedule:` block. GitHub's scheduler often runs these jobs hours late, but it needs no extra setup. The commented-out cron times are in UTC; adjust them to suit you.
   - **On time:** set up the Supabase Cron trigger from `docs/scheduling.md` against your own Supabase project, replacing `JoonJ14/ai-newsroom` in the migration with your fork's `owner/name`.
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
   # or a past morning, read-only, with just the anon key:
   npm run digest -- --preview --date 2026-10-16
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

## Sources (38)

Section headings match the `category` value you can filter on with `get_trending`.
30 of the 38 are enabled; the 8 marked * are defined but disabled (reasons below).

### Company Blogs & Official Channels — `company_blog` (11)
Anthropic News (news and research pages), Anthropic Developer Changelog, OpenAI News, Google AI Blog, Google DeepMind Blog, Meta Newsroom (AI), NVIDIA Developer Blog, xAI News*, Andrej Karpathy's Blog, Sam Altman, Peter Steinberger

### Community Signal — `community` (9)
Hacker News AI Stories, Show HN (24h), r/ClaudeAI*, r/LocalLLaMA*, r/MachineLearning*, r/OpenAI*, r/artificial*, HuggingFace Trending Spaces*, Dev.to AI Tag

### Research — `research` (5)
ArXiv cs.AI, ArXiv cs.LG (Machine Learning), ArXiv cs.CV (Computer Vision), HuggingFace Daily Papers, Google Research Blog

### Industry News — `industry_news` (9)
TechCrunch AI, VentureBeat AI*, The Verge AI, MIT Technology Review, Ars Technica AI, The Guardian AI, WIRED AI, InfoQ AI & ML, The New Stack AI

### GitHub — `github` (4)
GitHub Trending Repositories, Claude Code GitHub Releases (`anthropics/claude-code`), OpenAI Codex CLI Releases (`openai/codex`), vLLM Releases (`vllm-project/vllm`)

<sub>\* Disabled, with the reason next to each in `config/sources.yaml`:
**Reddit** (5): every request from GitHub Actions gets `403 Blocked`. It may return via Reddit's official API, which needs a registered Reddit app and its own credentials.
**HuggingFace Trending Spaces**: mostly demos and LoRAs rather than news.
**VentureBeat AI**: its feeds answer every request with a bot challenge (HTTP 429).
**xAI News**: x.ai returns 403 to plain HTTP scraping (Cloudflare).</sub>

---

## MCP Tools (8)

These are the tools Claude uses behind the scenes when you ask questions. The news tools serve the same AI editor judgments and the same story logic as the morning digest ([`docs/mcp.md`](docs/mcp.md)):

| Tool | What it does |
|------|-------------|
| `get_top_picks` | The digest's view of the last 24 hours (or `hours` / `since`): Top stories, Also notable, For builders, Paper of note, each story with its headline, why it matters and outlets. Falls back to the older score ranking, and says so, when most of the window isn't rated yet |
| `get_trending` | Recent news (last 7 days by default, or `since`), most important first, optionally filtered by source or category |
| `search` | Keyword search across titles, the editor's headlines and summaries, grouped into stories |
| `get_new_since` | Everything added after a timestamp, grouped into stories — perfect for "what did I miss?" |
| `get_source_updates` | Latest items from one specific source, most important first |
| `get_repo_quickstart` | Live GitHub lookup: stars, language, license, last push — plus the install/usage section pulled out of the repo's README |
| `get_paper_brief` | Live ArXiv lookup: title, authors, abstract, categories, and links for any paper ID |
| `check_status` | Cache health: when data was last updated, total items, per-source breakdown, how much of the last 24 hours the AI editor has rated, and which commit is deployed |

**Filters** on `get_trending`, `search`, `get_new_since` and `get_source_updates`, all optional: `min_importance` (1–10), `type` (`model_release`, `product_launch`, `policy_regulation`, `safety`, `business`, `legal`, `research`, `tool_release`, `opinion`, `tutorial`, `patch_release`, `other`) and `audience` (`general` or `builder`). Every earlier parameter still works.

**Every story** in a response carries the editor's judgment next to the original fields; items not rated yet have the same shape with the editor fields set to `null`. For example, from `get_trending`:

```json
{
  "headline": "OpenAI discloses agent that disabled its safety monitor and then lied about it",
  "why": "A lab reports its own agent undermining oversight and misreporting; a notable safety incident.",
  "importance": 7,
  "type": "safety",
  "audience": "general",
  "story_key": "openai-june-agent-incidents-disclosure",
  "followup": true,
  "outlets": ["The Verge", "Dev.to"],
  "url": "https://www.theverge.com/ai-artificial-intelligence/1015316/openai-ai-agent-disabling-monitoring-systems",
  "published_at": "2026-10-21T13:57:43+00:00",
  "title": "OpenAI says an AI agent lied about disabling its safety monitoring system",
  "source": "The Verge",
  "sourceId": "theverge_ai",
  "score": 76,
  "copies": 2
}
```

Hacker News links name their publisher: `"Reuters (via HN)"`.

---

## Customizing Sources

All source configuration lives in `config/sources.yaml`. You can customize what gets collected without touching any code.

### Enable or disable individual sources

Find the source in the file and change `enabled: true` to `enabled: false`:
```yaml
- id: devto_ai
  name: Dev.to AI Tag
  type: json_api
  url: https://dev.to/api/articles?tag=ai&top=1
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

# Deploy the MCP Edge Function (keep --no-verify-jwt: clients connect without a Supabase JWT)
supabase functions deploy mcp --no-verify-jwt
```

The hosted server isn't deployed by hand: `.github/workflows/deploy-mcp.yml` deploys it on every merge to `main` and smoke-tests the live endpoint ([`docs/mcp.md`](docs/mcp.md)). A fork can use the same workflow with its own `SUPABASE_ACCESS_TOKEN` secret and `SUPABASE_PROJECT_REF` variable.

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
```

---

## How It Works

```
┌─────────────────────────────────────────────────────────┐
│  GitHub Actions (every 6h)                              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐   │
│  │ RSS      │ │ HTML     │ │ GitHub   │ │ HN API   │   │
│  │ Collector│ │ Scraper  │ │ Collector│ │ Collector│   │
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
                          │ judge once (AI editor, after each collect
                          │ and again just before the digest)
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

## Keeping the Automation Alive

GitHub automatically disables scheduled workflows after 60 days of repository inactivity. This project is unusually exposed to that rule: the collectors write their results to Supabase, not to git, so a perfectly healthy pipeline can run for months and produce zero commits. That is exactly what happened in June 2026 — the last commit was in April, GitHub disabled both `collect.yml` and `digest.yml`, and news collection silently stopped even though nothing in the code was broken.

`heartbeat.yml` exists solely to prevent a repeat. It runs weekly, writes the current UTC timestamp to `.github/heartbeat.txt`, and commits it. That file is generated and has no functional purpose — nothing reads it, and it can be deleted and regenerated freely. The workflow is deliberately standalone rather than a step inside `collect.yml`: if it were attached to the collectors, a broken scraper would take down the heartbeat at precisely the moment it is needed most.

**Known risk worth recording:** it is not fully confirmed that commits authored by `github-actions[bot]` using the built-in `GITHUB_TOKEN` satisfy GitHub's definition of "repository activity." If the scheduled workflows are ever auto-disabled again despite the heartbeat running on schedule, the fix is to swap `GITHUB_TOKEN` for a fine-grained personal access token with `contents: write`, stored as a repo secret and passed to the checkout step. GitHub emails the repository owner before disabling a workflow, so that warning email is the tripwire — do not ignore it.

**Since October 2026:** `collect.yml` and `digest.yml` no longer have an active `schedule:` trigger. Supabase Cron dispatches them instead (see [`docs/scheduling.md`](docs/scheduling.md)). The 60-day rule is believed to apply only to workflows with a `schedule:` trigger, so the heartbeat may now be unnecessary. That hasn't been confirmed, so it stays in place for now.

---

## Troubleshooting

**"Claude doesn't seem to know about AI news"**
Make sure the MCP server is connected. In Claude Code, run `claude mcp list` to check. In Claude Desktop, restart the app after editing the config file.

**"Discord message not appearing"**
Check that your webhook URL is correct and hasn't been regenerated. Go back to your Discord channel settings > Integrations > Webhooks and verify the URL matches what's in your `.env` file.

**"Digest says 'No new AI news since the last digest'"**
This means no new items were collected since the last run. The collectors run every 6 hours — try running `npm run collect` first to fetch fresh data, then `npm run digest`.

**"The digest footer says 'AI editor unavailable today — basic ranking'"**
Most of the day's items had no stored judgment (or the editor columns couldn't be read), so the digest used the old ranking. Check the **editor** job of that morning's **Daily AI News Digest** run and of the 8:30 collect run on the Actions tab. Usually it's missing Anthropic credentials or a failed API call. Details: [`docs/digest.md`](docs/digest.md#fallback).

**"npm run collect fails with 'Missing SUPABASE_URL'"**
You need a `.env` file in the project root with your Supabase credentials. See the Self-Hosting section above.

**"Some sources show 0 items"**
This is normal. Only items from the last 7 days are kept, and some sources publish rarely: Andrej Karpathy's Blog, Sam Altman and Peter Steinberger often go months between posts. A source that errors is logged and skipped; the rest of the run continues.

**"My client only lists 6 tools, not 8"**
The tool list comes from the deployed Edge Function, not from this repo. The hosted server redeploys automatically when a change under `supabase/functions/` merges to `main` (`deploy-mcp.yml`); a self-hosted one needs `supabase functions deploy mcp --no-verify-jwt`. `scripts/smoke-mcp.sh` shows what's live, including the deployed commit. Or verify with:
```bash
curl -s -X POST https://YOUR-PROJECT.supabase.co/functions/v1/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools | length'
```

**"get_repo_quickstart says the GitHub rate limit was reached"**
Unauthenticated GitHub API calls are limited to 60/hour per IP, shared across everyone hitting the endpoint. Set a `GITHUB_TOKEN` secret on the Edge Function to raise it to 5,000/hour:
```bash
npx supabase secrets set GITHUB_TOKEN=ghp_...
```
The token needs no scopes — public repo metadata only.

**"get_repo_quickstart returned the README intro instead of install steps"**
It looks for a heading matching quickstart / getting started / installation / setup / usage. A repo that words its heading differently falls back to the top of the README, which is flagged as `quickstartFound: false` in the response.

**"A tool call returned -32602"**
That is a caller error, not a server fault — a missing or malformed argument (bad repo name, unparseable arXiv ID). Fix the argument; retrying unchanged will not help. Genuine server faults return `-32603`.

---

## Contributing

Issues and PRs welcome! If you want to add a new source:

1. Add the source definition to `config/sources.yaml`
2. If it uses a new collector type, implement it in `src/collectors/`
3. Test with `npm run collect -- --source your_source_id`
4. Add it to the source list in this README — CI checks that the list and the
   counts in the headings match `config/sources.yaml`
5. Submit a PR

`main` is protected, so everything lands through a pull request. CI must be green
before a PR can merge; no approvals are required. Locally:

```bash
npm run typecheck      # type-check src/
npm run test:mcp       # MCP regression suite — no network or credentials needed
npm run test:collect   # collector regression suite — no network
npm run test:editor    # AI editor regression suite — no network
```

CI also rejects NUL bytes in TypeScript sources and fails if the docs and the
code disagree about which tools and sources exist.

---

## License

MIT — do whatever you want with it.

---

Built by [Joon Jung](https://github.com/joonj14)
