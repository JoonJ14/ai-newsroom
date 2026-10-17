# The AI editor

Step 2 of the ranking rebuild. The old score never reads an item's content: it is
recency, engagement and source tier, so a Claude Code patch release and GPT-6
could land side by side. The editor reads each item once, judges it against a
written rubric, and stores the judgment on the row. **Nothing displays the
judgments yet.** Step 3 builds the digest from them; step 4 has the MCP read
them.

## How it works

```
collect.yml ─▶ collect job ─▶ editor job ─▶ npm run editor
                                 │
                                 ├─ unjudged rows from the last 7 days, newest first
                                 ├─ story keys judged in the last 7 days (context)
                                 ├─ batches of 25 ─▶ Claude Haiku 5.5, structured JSON output
                                 ├─ validate, clamp, reject malformed entries one by one
                                 └─ write editor_* columns, only where editor_judged_at is null
```

- **Once per item.** A judgment is written only while `editor_judged_at` is
  null, and collection never sends `editor_*` columns (`toUpsertRow` in
  `src/utils/supabase.ts` lists its columns explicitly; a test checks it). So
  a later collect run that rewrites the score leaves the judgment alone.
- **Safe failure.** The editor is its own job in `collect.yml`, after the
  collect job, with `continue-on-error: true`. If it fails, the run stays green
  with a warning, and collection is unaffected. Unjudged items are retried on the
  next run. With no Anthropic credentials at all, it logs a warning and exits 0.
- **One at a time.** The editor job and the backfill share the `editor`
  concurrency group, so two runs never judge the same rows.
- **Stories.** Each judgment carries a `story_key` slug. The prompt lists the
  keys judged in the last 7 days, and keys named earlier in the same run, so
  copies from other outlets reuse the key and genuine follow-ups get
  `followup: true`.
- **Untrusted input.** Titles and summaries are passed as JSON strings inside
  `<items>` (with `<` escaped so a title can't close the tag), the rubric says
  to treat them as data, the model has no tools, and the response is
  constrained to the judgment schema. The worst a hostile title can do is earn a
  wrong judgment of itself.

### Stored columns (`supabase/migrations/004_editor_judgments.sql`)

| Column | Meaning |
|---|---|
| `editor_type` | `model_release`, `product_launch`, `policy_regulation`, `safety`, `business`, `legal`, `research`, `tool_release`, `opinion`, `tutorial`, `patch_release`, `other` |
| `editor_importance` | 1–10 (clamped) |
| `editor_audience` | `general` or `builder` |
| `editor_headline` | Plain-language headline (fitted to 120 characters) |
| `editor_why` | One line on why it matters |
| `editor_story_key` | Slug grouping copies and follow-ups of one story |
| `editor_followup` | A genuine new development on an earlier story |
| `editor_model` | Model that judged it |
| `editor_version` | Rubric version |
| `editor_judged_at` | When it was judged; null means "not yet" |

Check constraints hold type, importance and audience to these values. A partial
index on `fetched_at` where `editor_judged_at is null` serves the work queue.

## The rubric: `config/editor-rubric.md`

The system prompt, word for word, minus HTML comments. Tune it there without
touching code. Its first line is the version:

```
<!-- rubric-version: 2026-10-16.3 -->
```

**Bump it on every change.** It is stored with each judgment, so you can tell
which rubric judged what and re-judge a window after a change. The field names
and allowed values are fixed in code (`src/editor/judgment.ts`); renaming a type
in the rubric alone does nothing.

The test it is built around: *would someone who follows AI be annoyed to learn
about this a week late?* The importance scale is anchored with real examples.
Several come from the Oct 8 and Oct 13 windows, so previews of those two days
flatter it; judge rubric changes on other days too.

### Trying a change before it judges anything

```bash
npm run preview:editor -- --date 2026-10-13 --dry-run         # judge in memory, store nothing
npm run preview:editor -- --date 2026-10-13 --dry-run --all   # plus every judgment, by story
```

`--dry-run` uses the local `ANTHROPIC_API_KEY` and reads with
`SUPABASE_ANON_KEY`. It writes nothing. A day costs about two cents.

## The preview

```bash
npm run preview:editor -- --date 2026-10-13                   # stored judgments
npm run preview:editor -- --window 2026-10-12T13:00Z,2026-10-13T13:00Z
```

For the digest window ending at 9:00 AM New York time on that date (from 9:00
the day before), it prints:

1. **What the old digest logic picked.** `buildSlottedDisplay` unchanged, with
   the digest's own options (`src/digest/slot-options.ts`) and its clock set to
   the end of the window. It sees scores as stored *now*; later collect runs
   rewrite them, so this approximates what was actually sent. The real digest
   starts from `digest_state.last_digest_at`, which the anon key can't read, so
   the preview uses the nominal window.
2. **The editor's view.** Stories (judged items grouped by `story_key`), ranked
   by importance, then by how many outlets carried them:
   - top 5 general-audience stories at importance 5+;
   - also notable: the next 5 at 4+;
   - for builders: the top 3 `builder` stories at 4+;
   - notable papers: arXiv / HF papers at 6+ (the rubric expects one or two a week).
3. **Rated 7+ but not shown by the old digest.**

These sections are a first cut at step 3's layout (`src/editor/select.ts`).

## Cost and caps

Claude Haiku 5.5 (`claude-haiku-5-5`) at $0.10 / $0.50 per million input /
output tokens. A weekday of about 150–190 items measured 70–110k input tokens
and 16–22k output tokens: **about $0.015–0.02 a day**, well under $1 a month.
Each run logs its calls, tokens and estimated cost, and adds a summary table to
the GitHub run page.

| Variable | Default | Meaning |
|---|---|---|
| `EDITOR_MODEL` | `claude-haiku-5-5` | Model; also a repository variable |
| `EDITOR_EFFORT` | `low` | `low`, `medium` or `high` |
| `EDITOR_TEMPERATURE` | unset | Sent only if set. Haiku 5.5 rejects anything but 1 with HTTP 400, so leave it unset unless you switch to an older model |
| `EDITOR_BATCH_SIZE` | 25 | Items per request |
| `EDITOR_MAX_ITEMS` | 300 | Items per run, newest first |
| `EDITOR_MAX_CALLS` | 20 | API calls per run |
| `EDITOR_MAX_INPUT_TOKENS` | 600000 | Checked before each call; a run can exceed it by one batch |
| `EDITOR_MAX_OUTPUT_TOKENS` | 16000 | Per request |
| `EDITOR_CONTEXT_STORIES` | 250 | Known story keys offered as context |

A batch whose output is cut off, or that the model declines, is retried once as
two halves. Any other failed batch is skipped and retried next run.

**About temperature.** The plan called for temperature 0. Claude Haiku 5.5
rejects it ("`temperature` is deprecated for this model"), so the editor leaves
it unset. Structured outputs and the rubric are what keep judgments consistent.
Because each item is judged only once, there is no re-run to disagree with.

## Re-judging

After a rubric change, clear the judgments for a window in the Supabase SQL
Editor, then run the backfill:

```sql
UPDATE news_items
SET editor_type = NULL, editor_importance = NULL, editor_audience = NULL,
    editor_headline = NULL, editor_why = NULL, editor_story_key = NULL,
    editor_followup = NULL, editor_model = NULL, editor_version = NULL,
    editor_judged_at = NULL
WHERE fetched_at >= NOW() - INTERVAL '7 days';
-- or only an old rubric's judgments:  WHERE editor_version = '2026-10-16.3'
```

The editor only looks back `--days` (7 by default; the backfill takes it as an
input), so clearing older rows needs a larger `days` on the backfill.

## The backfill: `editor-backfill.yml`

Actions → **AI Editor Backfill** → Run workflow. Inputs: `days` (7),
`max_items` (1500), `max_calls` (80). Same code, logging and auth as the
scheduled run. It exists because only GitHub has the database's write key.

## Authentication

The editor picks the first that applies (`src/editor/client.ts`):

1. **Workload identity federation on GitHub Actions.** When the repository
   variables `ANTHROPIC_FEDERATION_RULE_ID` and `ANTHROPIC_ORGANIZATION_ID` are
   set and the job has `id-token: write`, it asks GitHub for an OIDC token
   (audience `https://api.anthropic.com`) and exchanges it for a short-lived
   Anthropic token. It requests a fresh GitHub token for every exchange, so a
   long backfill never presents an expired one. No Anthropic secret is stored.
2. **Federation from a token file** (`ANTHROPIC_IDENTITY_TOKEN_FILE`), handled
   by the SDK, for other CI systems.
3. **`ANTHROPIC_API_KEY`.** Locally from `.env`. On GitHub it is the fallback
   while the federation variables are unset.

The log line `auth: …` says which one ran. The mode is logged; secrets never are.

### Setting up federation

1. Claude Console → **Settings → Workload identity** → **Connect workload** →
   **GitHub Actions**.
2. Issuer: `https://token.actions.githubusercontent.com`, JWKS by discovery.
3. Service account: a new one, e.g. `ai-newsroom-editor`, in the workspace the
   editor should bill to, with the developer scope the wizard offers.
4. Federation rule:
   - subject prefix `repo:JoonJ14/ai-newsroom:ref:refs/heads/main`;
   - audience `https://api.anthropic.com`;
   - claims `repository_owner = JoonJ14` and `ref = refs/heads/main`.

   Runs from pull requests (`…:pull_request`), other branches and forks don't
   match.
5. Copy the IDs into **GitHub → Settings → Secrets and variables → Actions →
   Variables** (not Secrets): `ANTHROPIC_FEDERATION_RULE_ID` (`fdrl_…`),
   `ANTHROPIC_ORGANIZATION_ID` (a UUID, from Settings → Organization),
   `ANTHROPIC_SERVICE_ACCOUNT_ID` (`svac_…`), and `ANTHROPIC_WORKSPACE_ID`
   (`wrkspc_…`) if the rule covers more than one workspace.
6. Run **AI Editor Backfill** (or wait for a collect run) and check the log for
   `auth: workload identity federation (GitHub OIDC token)`. A rejected exchange
   is a 401 "Authentication failed"; the reason is on the Console's Workload
   identity → History tab.
7. Once it has worked, delete the `ANTHROPIC_API_KEY` repository secret. Nothing
   else in the workflows reads it.
