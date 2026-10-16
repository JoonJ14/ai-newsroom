# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

> **Deploy note:** the MCP tool list is served by the deployed Edge Function, not
> by this repo. Run `npx supabase functions deploy mcp` to make the changes below
> live; until then the endpoint keeps serving the previous build.

### Added

**AI editor (ranking rebuild, step 2 of 4)**

- **`npm run editor`** (`src/editor/`): judges each recently collected item once
  with Claude Haiku 5.5 (`claude-haiku-5-5`, `EDITOR_MODEL` to change) and stores
  type, importance 1–10, audience (`general` / `builder`), a plain-language
  headline, a why-it-matters line, a story key and a follow-up flag, plus the
  model, rubric version and time. Batches of 25, structured JSON output,
  validated and clamped; a malformed entry is rejected on its own, a batch cut
  off at `max_tokens` is retried as two halves. Per-run caps on items, calls and
  input tokens; tokens and estimated cost are logged on every run. **Nothing
  displays the judgments yet** (step 3).
- **Migration `004_editor_judgments.sql`** (run by hand, idempotent): ten
  nullable `editor_*` columns, check constraints, a partial index on unjudged
  rows and one on `editor_story_key`. RLS unchanged.
- **The rubric is a file**, `config/editor-rubric.md`, with a version line stored
  on each judgment. Built around "would someone who follows AI be annoyed to
  learn about this a week late?", with an anchored 1–10 scale, rules for papers,
  tool releases and wire stories on HN, and instructions to treat titles and
  summaries as data.
- **Story keys**: each request lists the keys judged in the last 7 days, so
  copies from other outlets reuse a key and follow-ups are flagged.
- **`collect.yml` runs the editor** as a second job after collection, allowed to
  fail (`continue-on-error`): a failure never fails or undoes collection, and
  unjudged items are retried next run.
- **`editor-backfill.yml`**: `workflow_dispatch` run over the last N days with
  higher caps.
- **Workload identity federation** on GitHub Actions (`id-token: write` on the
  editor jobs only; IDs as repository variables). It requests a fresh GitHub OIDC
  token for every exchange. Falls back to the `ANTHROPIC_API_KEY` secret while the
  variables are unset, and uses `.env` locally.
- **`npm run preview:editor -- --date YYYY-MM-DD`** (or `--window`): for a
  9:00 AM ET digest window, the old digest's picks (`buildSlottedDisplay`
  unchanged), the editor's top stories, also-notable, builders and papers, and
  the 7+ stories the old digest missed. `--dry-run` judges in memory with the
  local key and stores nothing; `--all` lists every judgment. Read-only (anon key).
- **`npm run test:editor`** (68 assertions, no network) and a CI step for it.
- **`docs/editor.md`**: how it works, the rubric, cost and caps, re-judging, the
  backfill and the auth setup.

**Collection (ranking rebuild, step 1 of 4)**

- **Three press sources** for policy, business and general AI coverage, all
  tier 2, `industry_news`, keyword filter on: **Ars Technica AI**, **The
  Guardian AI** and **WIRED AI**. AP News and Axios answer 403 to feed requests,
  and Reuters has no public RSS, so those were not added.
- **Anthropic News also reads `/research`** (`extraUrls` in `sources.yaml`, a new
  optional `html_scrape` field).
- **Cross-source coverage survives dedup.** One row per story is still stored,
  but it lists the other copies in `metadata.coveredBy: [{source, url}]` and
  keeps their engagement: an HN thread's `hnPoints`, `hnId`, `hnLink` and
  `commentCount` on a press article, a paper's HF `upvotes` on its arXiv row.
  The upsert merges these with the stored row, so a later run that no longer
  sees the other copy doesn't erase them.
- **Raw engagement kept in metadata:** HN `hnPoints` (the `score` field is
  overwritten by the relevance score), Dev.to `reactions`, and for HF papers
  `upvotes`, `numComments`, `githubRepo`/`githubStars`, `projectPage` and the
  submitting organization.
- **`npm run test:collect`** (86 assertions, no network) and a CI step for it.

**Scheduling and CI**

- **Supabase Cron scheduling (`supabase/migrations/003_schedule_triggers.sql`).**
  GitHub's `schedule:` trigger was delivering the 11:45 AM ET digest at
  2:30–6:00 PM ET. `pg_cron` now fires hourly and gates on the America/New_York
  hour (DST-proof), and `pg_net` calls GitHub's `workflow_dispatch` API. Collect
  runs at 2:30/8:30/14:30/20:30 ET, the digest at **9:00 AM ET**, and a 9:30
  alarm posts to Discord if `digest_state.last_digest_at` wasn't refreshed. All
  functions live in a `private` schema, revoked from `anon`/`authenticated`, so
  PostgREST can't expose them. Secrets come from Vault at call time. **Manual
  steps required:** create the GitHub token and Vault secrets, then run the
  migration by hand. See `docs/scheduling.md`.
  After Codex review: `digest_hour_ny()` refuses hours 1 and 2 (doubled or
  skipped digests on DST nights), and the weekly log cleanup deletes only the
  `newsroom-*` jobs' history, not other cron jobs'.
- **`docs/scheduling.md`**: why the change, how it works, setup, verification,
  changing the digest time, token renewal, and rollback.
- **CI (`.github/workflows/ci.yml`)** — the project had none. `tsconfig.json`
  excludes `supabase/`, so the MCP server had no automated coverage whatsoever.
  Runs on every pull request and every push to `main`: typecheck, the MCP
  regression suite, a NUL-byte scan, and a docs-match-code check that asserts
  every tool is declared, routed *and* documented, with the README's tool and
  source counts matching config.
- **Branch protection on `main`** via a GitHub *ruleset* (not classic branch
  protection, so Settings → Branches stays empty by design). Requires a pull
  request and a green `typecheck + tests` check; blocks deletion and
  force-pushes. **No bypass actors** — the rule applies to everyone.
- **`get_repo_quickstart` MCP tool** — looks up a GitHub repo and returns its
  metadata (stars, forks, language, license, last push, archived flag) plus the
  install/usage section extracted from its README. Accepts `owner/name` or a
  github.com URL. Both tools had been specified in `CLAUDE.md` since the project's
  design but were never implemented; the server shipped 6 of the 8 documented tools.
- **`get_paper_brief` MCP tool** — fetches an ArXiv paper by ID and returns title,
  authors, abstract, categories, journal ref, DOI, and links. Accepts a bare ID,
  an `arXiv:` prefix, a versioned ID, or an arxiv.org abs/pdf URL.
- **`npm run test:mcp`** — 85-assertion regression suite for the MCP layer
  (`supabase/functions/mcp/external.test.ts`). Covers the pure helpers only, so it
  needs no network and no credentials. Previously nothing in CI exercised this
  code at all: `tsconfig.json` excludes `supabase/`.
- Troubleshooting entries for the deploy step, GitHub rate limits, quickstart
  heading fallback, and the `-32602` vs `-32603` distinction.

### Fixed

**Collection (ranking rebuild, step 1 of 4)**

- **`npm run collect` sat for 4–10 minutes after "Done"**, and 6 of 33 runs
  hit the job's 10-minute timeout, which also skipped the cleanup step.
  rss-parser's `parseURL` never reads or destroys the response on a redirect
  or a non-2xx status, and never aborts on its timeout, so the socket held the
  process open until the server dropped it (DeepMind's 404, VentureBeat's 429
  and Google Research's redirect did this on every run). Feeds are now fetched
  with `fetch` and only parsed by rss-parser. All collector HTTP goes through
  `src/utils/http.ts`: a deadline on every request, and every response read or
  cancelled. A 15 s backstop exits and logs what is still open, should a new
  leak appear.
- **Anthropic News missed model launches.** It followed only `/news/` links and
  the first five of them, and the Claude Haiku 5.5 launch is linked at
  `/claude-haiku-5-5`. It now takes every dated card linking into anthropic.com,
  on `/news` and `/research`. The featured card no longer yields a row titled
  "Announcements". Each recent item's own page supplies a summary and the exact
  publish time; the listing had a summary for 2 of 23 rows. The 7-day filter
  runs on that exact time, so an article from seven days ago is not dropped
  because its listing date reads as midnight UTC.
- **Anthropic changelog**: the old URL redirects to
  `platform.claude.com/docs/en/release-notes/overview` and parsed to nothing
  since August. New parser, one item per bullet (one day held a model launch
  among seven SDK notes).
- **Google DeepMind Blog** (404) and **Google Research Blog** (dead since 2024):
  new feed URLs.
- **Meta**: `ai.meta.com/blog/` server-renders only posts up to July, so the
  scraper returned the same five undated posts. `meta_ai_blog` is now Meta's
  newsroom AI-tag feed, renamed "Meta Newsroom (AI)"; it carried Muse Wonder.
- **MIT Technology Review** uses its AI topic feed. The whole-site feed lost
  about half its items to the keyword filter.
- **HF Daily Papers upvotes were always 0**: the collector read `numLikes`; the
  API field is `paper.upvotes`. Papers now feed real upvotes into the existing
  score (note: with `scoring.ts:47`, 0 upvotes still scores above 1–49).
- **HF Spaces field mapping** (source disabled, code kept correct): the listing
  has no `lastModified` or `cardData`, so every Space was undated and scored as
  new forever. `publishedAt` is now `createdAt`.
- **HN Algolia returned 20 hits** whatever `maxItems` said; `hitsPerPage` is now
  set from it. Text posts' HTML `story_text` becomes plain text.
- **Titles and summaries**: HTML entities decoded (43 Verge titles had
  `&#8217;`), newlines collapsed. **URLs**: `utm_*` parameters stripped before
  the `(url, source)` identity is formed (203 InfoQ rows had them).
- **Dedup merged unrelated items**: its URL comparison dropped the query string,
  so every HN text post (`item?id=…`) matched every other. The query and
  fragment now count; scheme, `www.` and a trailing slash still don't.
- **GitHub release sources** get the workflow's `GITHUB_TOKEN` (`collect.yml`).
  Unauthenticated calls hit the 60/hour limit on 2026-10-06.
- **Migration 003 can be re-run.** pg_cron's `create extension` and grants now
  run only when the extension is missing; on a second run they tripped
  Supabase's pg_cron access hook ("dependent privileges exist").
- After review (Codex):
  - The upsert merges stored metadata. If that read fails, or hits PostgREST's
    1,000-row cap, the run now only inserts new items, rather than overwrite
    existing rows and erase their coverage. `collect.yml` runs one at a time,
    so overlapping runs can't write back stale copies.
  - Collector responses are capped at 10 MB, cancelled past that instead of
    buffered.
  - Decoded titles are plain text in every digest adapter: Telegram no longer
    parses them as HTML ("<model>" failed the send), Discord sends no mentions
    and escapes its markup on title lines (no masked links, spoilers or
    emphasis), Slack sends with `mrkdwn: false` and `<`, `>`, `&` escaped,
    and Telegram gets a word joiner after `@` so a title can't mention anyone. Every item's text is decoded exactly once: HN
    text and cheerio's (already decoded) scraped text were decoded twice. HN
    summaries are cut to 500 characters after decoding, not before. No cut
    leaves half an emoji (PostgreSQL rejects a lone surrogate, failing the
    whole upsert batch), and lone surrogates from feeds are dropped.
  - `utm_` parameters are also stripped when percent-encoded (`utm%5Fsource`). Control characters are dropped
    from titles and summaries (a decoded `&#27;` is a terminal escape).
  - The metadata lookup quotes and escapes every URL itself: supabase-js's
    `.in()` doesn't escape `"` or `\`, so one odd feed URL failed the lookup.
  - Changelog entries that share their first eight words get a hash of their
    text, not a number by position, so an entry added above can't take an
    older entry's row.
  - Dedup ignores a URL's fragment again (`story#comments` is `story`), except
    app routes (`#/…`). Changelog URLs therefore carry the day in the query
    (`?day=…&entry=…#…`): the same opening words on two days are two entries.
  - Dedup groups copies into stories, so a copy matching one story by URL and
    another by title joins them, and the kept row carries the story's biggest
    HN thread even after its absorber was replaced. Titles merge copies from
    different sources only, and no story ever holds two different URLs from
    one source: within a source, different URLs are different items (two
    changelog entries for two regions were 0.83 alike). Copies of one
    `(url, source)` row are merged first, so an upsert batch never holds a row
    twice; then every URL match, then titles, so a similar title can't claim
    a copy whose exact URL belongs to another story.
  - A failed upsert batch now fails the run (exit code 1), after every batch
    has been tried. Before, lost items still gave a green run.
  - The orchestrator stops starting sources after 5 minutes, so a broad outage
    can't run the 10-minute job out before anything is stored.

**MCP server — availability**

- **Quadratic backtracking in README heading parsing (ReDoS).** `# Quickstart`
  followed by 16k spaces took ~2.3s, past the Edge Function CPU budget, and was
  reachable by anyone able to name a repo they control against a public,
  unauthenticated endpoint. Now linear: 8.5ms at 16k, 0.9ms at 100k.
- **Quadratic backtracking in ArXiv XML parsing.** Lazy-quantifier tag regexes
  rescanned the suffix for every candidate opening tag (~4x cost per doubling).
  Replaced with a linear index scan: 20k unclosed tags now parse in 1.7ms.
- **Unbounded response buffering.** `res.text()` decoded an entire body before the
  200k cap applied, so the cap bounded what was scanned but not peak memory —
  GitHub serves files up to 100MB into a 256MB shared isolate. Bodies are now read
  incrementally and cancelled at the cap.
- **Stack overflow on malformed XML.** The tag scanner recursed past each
  prefix collision (`<summary>` vs `<summary_detail>`); a 200k body admits more
  collisions than the stack allows. Now iterative.
- **No timeout on upstream calls.** A stalled GitHub or ArXiv response held the
  invocation open until the platform killed it. Now a 10s deadline with a clear
  error.
- Unread response bodies on error paths are now cancelled instead of held open.

**MCP server — correctness**

- **`get_top_picks` with `showAll: true` returned at most 500 rows**, and a naive
  raised limit still returned only 1,000: PostgREST enforces `db-max-rows`
  server-side regardless of the requested `.limit()`. With 7,112 rows cached that
  was 14% of the data behind the one option that promises to show everything. Now
  pages the whole table — verified at 7,112/7,112 — freezing the working set with
  a captured cutoff and seeking on the immutable primary key, and reporting any
  shortfall via a `truncated` flag rather than returning a partial answer as whole.
- **`check_status` reported two contradictory numbers.** Its total came from an
  exact count while its per-source breakdown came from an uncapped select subject
  to the same 1,000-row cap, so the breakdown summed to at most 1,000 against a
  7,112-row total. The breakdown is now paged and the total derived from it, so
  the two cannot disagree.
- **`check_status` could report `lastUpdated: "never"`.** `fetched_at` is nullable
  and Postgres sorts NULLS FIRST on DESC, so a single row without a timestamp won
  the ordering. NULLs are now excluded from that lookup.
- **A JSON `null` request body crashed the endpoint.** `req.json()` resolves for
  `null`, `[]` and scalars, and the result was destructured outside the try block,
  so a public unauthenticated request could raise an uncaught `TypeError`. Non-object
  bodies now return `-32600`.
- **`search`'s summary fallback swallowed its own error**, returning title-only
  results as though the search were complete, and deduplicated by `url` — which
  suppressed a legitimate match from a different source.
- **`search` ignored `since` in its summary fallback.** When the title search
  matched fewer than five rows, the fallback appended results with no time bound,
  returning items older than the caller asked for.
- **Row identity is `(url, source)`, not `url`.** Deduplicating by URL silently
  dropped rows — 54 rows in the live cache share a URL with a row from a different
  source. All dedup now keys on the row id.
- **`officialLimit` did not bound release entries**, so the Official Announcements
  section could exceed the requested maximum.
- **Negative and `NaN` limits are now clamped.** `officialLimit: -1` reached
  `slice(0, -1)`, which drops the last entry instead of returning none.
- **`get_top_picks` advertised defaults that the code did not use** (15/5/3/2 in the
  schema vs 10/8/6/4 in execution). The schema is what clients plan against.
- **Quickstart extraction returned unusable output for many repos.** `#` comments
  inside fenced code blocks were parsed as Markdown headings, truncating the section
  at the opening fence — 3 of 8 real repos returned an unterminated code block with
  zero install commands. Fence-aware masking now preserves the whole section.
- Heading selection no longer lets a passing mention ("Data collection, usage, and
  retention") outrank a real "Getting started"; honours CommonMark's closing-fence
  length rule, 1–3 space heading indentation, and ATX closing sequences (`## X ##`,
  while preserving `C#`); handles CRLF READMEs; and closes a fence left dangling by
  truncation.
- **XML entity decoding is now a single pass**, so a replacement's output is never
  re-scanned: `&amp;lt;` and `&#38;amp;` stay literal. Astral characters survive
  (`fromCodePoint`, plus hex entities), entity-encoded surrogate *pairs* combine,
  and only genuinely lone surrogates are dropped.
- **Repo identifiers are validated before use in an API URL.** Query strings and
  fragments are stripped, the charset is checked against GitHub's rules, and the
  dot-segments `.` / `..` are rejected — `repos/a/..` resolved to `repos/`, a
  different endpoint whose payload rendered as "undefined".
- **Caller errors return `-32602` instead of `-32603`**, so clients stop retrying
  requests that cannot succeed. Non-string arguments are rejected before use.
- **The two live-lookup tools no longer require Supabase credentials** — they never
  touch the database, but the client was constructed before routing.

### Changed

**AI editor (ranking rebuild, step 2 of 4)**

- The digest's slot options moved to `src/digest/slot-options.ts` so the preview
  replays them exactly. Same values; digest output unchanged.
- The collector upsert builds its rows in an exported `toUpsertRow`, now tested
  to send no `editor_*` column. Same columns as before.
- `@anthropic-ai/sdk` 0.135.0 added as a dependency.
- **Temperature is left unset**, not 0 as planned: Claude Haiku 5.5 returns HTTP 400
  ("`temperature` is deprecated for this model") for any value but 1, so the
  editor leaves it unset; `EDITOR_TEMPERATURE` sends one for older models.

**Collection (ranking rebuild, step 1 of 4)**

- **Disabled, with the reason in `sources.yaml`:** the five Reddit sources
  (every request from GitHub Actions got `403 Blocked`; no row was ever stored),
  HuggingFace Trending Spaces (demos and LoRAs, pinned at 93 by the date bug),
  and VentureBeat AI (a Vercel bot challenge answers 429 to every feed URL). 30
  of 38 sources are enabled. Reddit may return via its official API.
- One shared User-Agent for collector requests, naming the project and its URL.

**Scheduling and CI**

- **`collect.yml` / `digest.yml`**: the `schedule:` blocks are commented out
  (not deleted; forks can uncomment them to fall back to GitHub's scheduler).
  Runs now arrive via `workflow_dispatch`. Both workflows are pinned to
  `permissions: contents: read`. `heartbeat.yml` is unchanged; it may now be
  redundant, but that hasn't been confirmed.
- **The heartbeat now commits to a `heartbeat` branch instead of `main`**, so
  `main` can be protected without an exception. Required-status-check rules
  reject a freshly pushed commit — its checks have not run yet — and on a
  user-owned repository the GitHub Actions app cannot be granted a ruleset
  bypass at all (*"Actor GitHub Actions integration must be part of the ruleset
  source or owner organization"*). GitHub's 60-day inactivity rule counts
  repository activity rather than default-branch activity, so a side branch
  keeps `collect.yml` and `digest.yml` enabled just as well. The workflow also
  re-enables those workflows if it finds them disabled.
- **`SOURCE_NAMES` now covers all 35 sources** (was 24). The 11 missing entries
  rendered to users as raw IDs — `techcrunch_ai` instead of "TechCrunch". This
  affects the six pre-existing tools as well.
- **`supabase/functions/mcp/test.ts` imports the real `TOOLS` and `sourceName`**
  rather than keeping copies. The copies had drifted: it reported 6 tools when the
  server had 8, held 23 of 35 source names, and printed a 7-day retention against
  the actual 90.

### Documentation

- README and CLAUDE.md: the four-step ranking rebuild, the Reddit roadmap note,
  source count 38 (30 enabled) with the disabled ones and why.
  `docs/scheduling.md`: after migration 003's first run, apply later changes by
  running only the changed functions or jobs.
- README: new "Status & roadmap" section (scheduling change, deferred
  full-Supabase move and its costs, ranking rebuild next). The digest time now
  reads 9:00 AM ET. The fork instructions explain that a fork needs either the
  Supabase trigger or an uncommented `schedule:` block. Removed the stale
  `npm run dev:mcp` line from the SQLite self-host block (the script no longer
  exists).
- CLAUDE.md: replaced the "GitHub Actions for collectors, not Supabase cron"
  decision with "Supabase Cron schedules, GitHub Actions executes". Added
  "Current Direction". Fixed the stale trigger, digest and CI/CD descriptions.
  Regenerated the file tree from `git ls-files`: it listed a nonexistent
  `src/utils/sqlite.ts` and omitted three workflows.
- Source count corrected from "22+" to **35** in README, `CLAUDE.md`, and
  `package.json`. The README's source list was missing 11 sources and had two in the
  wrong category; sections now carry the `category` value used by `get_trending`.
  Noted that 34 of 35 are enabled by default (`xai_blog` is disabled — x.ai returns
  403 to plain HTTP scraping).
- MCP tool table updated to 8 entries, with usage examples for the new tools.
- `CLAUDE.md`: corrected `get_top_picks` parameters, marked which tools read the
  cache versus resolve live, and documented the optional `GITHUB_TOKEN`.
- **`CLAUDE.md`'s schema block was wrong** and caused real bugs during this work: it
  declared `url TEXT NOT NULL UNIQUE` (the migration has a unique index on
  `(url, source)`), omitted `tags`, and did not mark `score` and `fetched_at`
  nullable. It now defers to the migration as source of truth and lists the three
  query constraints that have actually bitten: `(url, source)` identity, the
  invisible `db-max-rows` cap, and why `score`/`fetched_at` are unsound cursors.
