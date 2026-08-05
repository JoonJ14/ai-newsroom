# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

> **Deploy note:** the MCP tool list is served by the deployed Edge Function, not
> by this repo. Run `npx supabase functions deploy mcp` to make the changes below
> live; until then the endpoint keeps serving the previous build.

### Added

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
