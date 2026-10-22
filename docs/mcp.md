# The MCP server

Step 4 of the ranking rebuild. The MCP server
(`supabase/functions/mcp/`, a Supabase Edge Function on Deno) is the other
face of the product. Any AI assistant connects to
`https://jialdowpnekknmxrwrdq.supabase.co/functions/v1/mcp` and gets the same
news the morning digest sends: the AI editor's judgments
([`docs/editor.md`](editor.md)), grouped and ranked by the digest's own code
([`docs/digest.md`](digest.md)). It deploys on every merge to `main`.

## One copy of the selection code

The digest runs on Node, the server on Deno. The code they share lives in
`supabase/functions/_shared/newsroom/`:

| File | What it holds |
|---|---|
| `types.ts` | `NewsItem`, the editor's types and audiences, `ItemJudgment` |
| `rows.ts` | The `news_items` columns, and rows → items |
| `source-names.ts` | Display names, HN publishers by domain, the official-lab, press and paper source sets |
| `stories.ts` | Grouping by `editor_story_key`, the representative item, outlets, the weak-source rule, per-outlet caps, ranking, the sections and their thresholds |
| `why.ts` | The why-line guard |
| `slots.ts` | The old score-ordered ranking, the fallback for a mostly unjudged window |

Why this place:
- **Supabase's deploy uploads the function's local module graph**, and
  `supabase/functions/_shared/` is the documented home for code shared
  between functions. A file outside `supabase/functions/` might not be
  uploaded.
- **Every file is pure TypeScript** with no imports outside the folder, so both
  runtimes load it as is. Imports end in `.ts`, as Deno requires. Node allows
  that via `allowImportingTsExtensions` and `rewriteRelativeImportExtensions`
  in `tsconfig.json`.
- **Node keeps its old import paths through one-line re-exports**, not copies:
  - `src/editor/select.ts`;
  - `src/utils/source-names.ts`;
  - `src/utils/slots.ts`;
  - `src/digest/why.ts`;
  - the `NewsItem` and `Coverage` types in `src/collectors/types.ts` and
    `src/utils/dedup.ts`.

  A test checks that the digest path and the server path get the very same
  functions.
- **The press list is static** (`PRESS_SOURCES`): the server doesn't read
  `config/sources.yaml`. A test fails if it drifts from the `industry_news`
  sources with `sourceTier` 1 or 2.

**CI checks the function itself** (`ci.yml`, "Edge Function type-check and
bundle"). On Deno 2.9.8 it runs:
- `deno check`;
- a check that every local module in its graph is under `supabase/functions/`;
- `deno bundle`.

**Digest-only:** the repeat memory (`story_history`) and the repeat check.
The server is stateless and answers for any window, so neither applies.

## What the tools return

The news tools read `news_items` with the editor columns (reads only, with the
`SUPABASE_SERVICE_ROLE_KEY` of the Edge Function environment) and shape the
answer in `supabase/functions/mcp/_shared/present.ts`.

**Every story** carries:
- the representative item's fields, under the names the tools always used:
  `title`, `url`, `source`, `sourceId`, `category`, `score`, `summary`,
  `authors`, `publishedAt`, `fetchedAt`;
- the editor's judgment: `headline`, `why` (after the guard), `importance`,
  `type`, `audience`, `story_key` and `followup`;
- `outlets` (every copy, HN links as "Publisher (via HN)"), `published_at`, and
  `copies` (rows grouped into it).

An item not judged yet has the same shape, with the editor fields `null`.

| Tool | What it does now |
|---|---|
| `get_top_picks` | The digest's four sections (Top stories, Also notable, For builders, Paper of note) for the last 24 hours, or `hours` / `since`, with the digest's default thresholds, weak-source rule and 2-per-outlet caps. `showAll` lifts the limits and caps, not the thresholds. Under 50% of the window judged, it returns the old score-ordered slots instead, with `mode: "fallback"` and a `note`, as the digest falls back. `officialLimit` and the other per-section limits apply to that fallback only |
| `get_trending` | Stories from the last 7 days (or `since`), filtered by `source` / `category` as before |
| `search` | Matches on titles and on the editor's headlines, plus summaries when those find little |
| `get_new_since` | Everything after `since` |
| `get_source_updates` | One source's newest items, the most important first |

**How the list tools rank:**
- Judged stories come first, by importance, then by how widely carried, then by
  recency: the digest's ranking.
- Unjudged items follow, one entry each, by the old score.
- Copies of one story are one entry.

**Filters** (all optional, validated, answered with -32602 when invalid):
`min_importance` (1–10), `type` (an editor type) and `audience` (`general` or
`builder`). With a filter, unjudged items are left out, because they have
nothing to match.

`get_repo_quickstart` and `get_paper_brief` are unchanged.

**`check_status`**, in addition to what it always reported, now gives:
- `editor.last24h`: items, judged, the share judged, rubric versions and
  models;
- `editor.newestJudgedAt`;
- `deployment.commit` and `deployment.builtAt`: which commit is live.

**A behaviour change:** `get_trending` used to return the highest-scored items
of the whole 90-day cache. Now that it ranks by importance, it looks at the
last 7 days unless given `since`. Otherwise month-old 9s would top every
answer.

## Deploys: merge equals deploy

`.github/workflows/deploy-mcp.yml` runs on every push to `main` that touches
`supabase/functions/**`, `supabase/config.toml`, the smoke test or the
workflow itself. It can also be run by hand from the Actions tab
(`workflow_dispatch`), for the first deploy and for redeploys. **It never runs
for a pull request or another branch**: the job checks the ref.

Steps:
1. Check out, install Deno 2.9.8 (`denoland/setup-deno@v2.0.5`), and
   `deno check` the function.
2. Stamp the commit: overwrite `supabase/functions/mcp/_shared/build-info.ts`
   with `$GITHUB_SHA` and the time. The committed file says `dev`.
3. Install Supabase CLI 2.121.0 (`supabase/setup-cli@v3.0.1`).
4. `supabase functions deploy mcp --project-ref $SUPABASE_PROJECT_REF --no-verify-jwt --use-api`:
   - **`--no-verify-jwt`** keeps the endpoint public. Assistants connect without
     a Supabase JWT, so turning verification on would break every connection.
     `supabase/config.toml` sets `verify_jwt = false` for `mcp` too, so a
     manual deploy without the flag can't turn it on either.
   - **`--use-api`** bundles on Supabase's side, so no Docker is needed.
5. **Smoke test**: `scripts/smoke-mcp.sh` against the live URL, with no
   Authorization header. It fails if:
   - a call errors;
   - `tools/list` doesn't return 8 tools;
   - `check_status` doesn't report the commit just deployed.

   It retries for about two minutes while the new version rolls out.

Settings: `permissions: contents: read`, a `deploy-mcp` concurrency group (one
deploy at a time, none cancelled), and only the access token as a secret,
which the logs never print.

**Credentials:**
- **`SUPABASE_ACCESS_TOKEN`** is a repository secret: a scoped personal access
  token with Edge Functions read and write, Project settings read, and
  Projects (account wide) read. It has nothing else: no database, auth keys,
  Edge Function secrets or organization settings.
- **`SUPABASE_PROJECT_REF`** is a repository variable: `jialdowpnekknmxrwrdq`.
- **If a deploy fails with a permission error**, the token is minimal by
  design: add only the permission the error names.
- **The function's own secrets are untouched by a deploy**: `GITHUB_TOKEN` for
  `get_repo_quickstart`, and the built-in `SUPABASE_URL` and
  `SUPABASE_SERVICE_ROLE_KEY`.

**Never deploy by hand from a branch.** Production changes only through this
workflow, after a merge. Before merging, test with CI's checks, the test
suites and, if needed, a local run:
`deno run --allow-net --allow-env --allow-read supabase/functions/mcp/index.ts`
with `SUPABASE_URL` set and the anon key as `SUPABASE_SERVICE_ROLE_KEY` (reads
only), then POST JSON-RPC to `http://localhost:8000`.

### The first deploy

Before this change nothing deployed the function. On Oct 22, 2026, the live
endpoint served 8 tools with the old score-ordered sections and no commit in
`check_status`. The first run of the workflow ships everything since then at
once, and its smoke test is what proves it works.

## Verifying what's live

```bash
scripts/smoke-mcp.sh                       # the hosted endpoint: tools, commit, today's sections
scripts/smoke-mcp.sh "$URL" <commit-sha>   # and fail unless that commit is live
```

Or ask any connected assistant to run `check_status`: its text ends with
`Deployed commit: <sha> (<time>)`. The `initialize` response's `serverInfo.version`
carries the commit too.

## Files

| File | What it does |
|---|---|
| `supabase/functions/mcp/index.ts` | JSON-RPC entry point, routing, error codes |
| `supabase/functions/mcp/_shared/tools.ts` | Tool names, descriptions and schemas |
| `supabase/functions/mcp/_shared/handlers.ts` | The cache-backed tools |
| `supabase/functions/mcp/_shared/data.ts` | Paged reads with the editor columns; reads only |
| `supabase/functions/mcp/_shared/present.ts` | Entries, ranking, filters, `get_top_picks` sections, editor status |
| `supabase/functions/mcp/_shared/external.ts` | `get_repo_quickstart`, `get_paper_brief` |
| `supabase/functions/mcp/_shared/build-info.ts` | The deployed commit (stamped by the workflow) |
| `supabase/functions/mcp/tools.test.ts` | The news tools against a fake Supabase client (`npm run test:mcp`) |
| `supabase/functions/mcp/test.ts` | Manual harness: the real handlers against real data, in Node |
| `.github/workflows/deploy-mcp.yml`, `scripts/smoke-mcp.sh` | Deploy and smoke test |
