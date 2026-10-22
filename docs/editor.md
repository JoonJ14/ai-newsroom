# The AI editor

Step 2 of the ranking rebuild. The old score never reads an item's content: it is
recency, engagement and source tier, so a Claude Code patch release and GPT-6
could land side by side. The editor reads each item once, judges it against a
written rubric, and stores the judgment on the row. Since step 3 the daily
digest is built from the judgments ([`docs/digest.md`](digest.md)), and since
step 4 the MCP server serves them too ([`docs/mcp.md`](mcp.md)).

## How it works

```
collect.yml ─▶ collect job ─▶ editor job ─▶ npm run editor
digest.yml  ─▶ editor job ─▶ digest job     (the same editor, just before the 9:00 digest)
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
- **One at a time, mostly.** `collect.yml`'s editor job and the backfill share
  the `editor` concurrency group. The editor job in `digest.yml` stays out of
  it, so the 9:00 digest never waits or gets cancelled in the queue. If it
  overlaps another run, both may judge the same rows; the first write wins
  (writes need `editor_judged_at` to be null), and the cost is a few cents.
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
<!-- rubric-version: 2026-10-21.5 -->
```

**Bump it on every change.** It is stored with each judgment, so you can tell
which rubric judged what and re-judge a window after a change. The field names
and allowed values are fixed in code (`src/editor/judgment.ts`); renaming a type
in the rubric alone does nothing.

The test it is built around: *would someone who follows AI be annoyed to learn
about this a week late?* The importance scale is anchored with real examples.
Several come from the Oct 8, Oct 13, Oct 16 and Oct 18–21 windows, so previews
of those days flatter it; judge rubric changes on other days too.

### Version history

- **`2026-10-21.5`**, from the first five real digests (Oct 17–21):
  - **Key reuse:** before making a new key, look in `<known_stories>` for the
    same company or people and the same underlying event, and reuse its key
    even for a later development or a smaller part of it. The examples are the
    cases that slipped through: Disney and Character.AI, OpenAI's test hacking,
    Meta's terms, MI5.
  - **Follow-up importance:** score a follow-up by what is new in it, never the
    known story's importance.
  - **Retellings** (recaps, explainers, podcasts, videos, opinion on a covered
    story) are not follow-ups and score 1–3.

  A dry run of Oct 18–21 against the stored v4 judgments:
  - Key reuse got better: WIRED's Disney piece reused `characterai-bankruptcy`.
  - Follow-up scores moved about a point: the OpenAI government-website
    retelling 7 → 6, Meta's "train" tweak 6 → 5, the Guardian's MI5 podcast
    5 → 2. The MI5 video stayed at 5.

  The rubric alone doesn't stop repeats. The digest's repeat check does
  (`docs/digest.md`); v5 makes its key fallback and grouping more reliable.
- **`2026-10-17.4`** (step 3). From a preview of Oct 16, where judgments were
  sound overall but:
  - **Regulators and governments**: an investigation, a government lawsuit or
    enforcement against a major AI company is 7. A final ruling, fine or
    enforcement order is 8. (An FTC probe of OpenAI and Anthropic had scored 6,
    below a foreign court ruling.)
  - **Releases**: notes with only small features, fixes or tweaks are a
    `patch_release` at 1–3. `tool_release` 4–6 needs a headline feature most
    users would notice. (A Claude Code release the editor itself called "mostly
    minor" had scored 5.)
  - **Why-lines** are about the news, never the coverage, with bad and good
    examples. ("Same story as the existing Meta Muse Spark Open entry" kept
    appearing.)
  - **Calibration at the top**: a new 8 band. A major lab's flagship model, or a
    major open-weight release, that is widely covered is 8; 9–10 stays rare.
    (Meta's 816B-parameter open-weight model, carried by five outlets, had
    scored 7, and nothing on Oct 16 reached 8.)

  A dry run of Oct 16 with v4 gave all four fixes: the FTC probe at 7, the
  Claude Code release a `patch_release` at 2, Muse Spark Open at 8, and no
  why-line about coverage.
- **`2026-10-16.3`**: the first rubric used for stored judgments, including
  the backfill of the week to Oct 16.

**Judgments are not redone when the rubric changes.** New items get the new
version; stored ones keep theirs (`editor_version`). To re-judge a window,
see [Re-judging](#re-judging).

### Trying a change before it judges anything

```bash
npm run preview:editor -- --date 2026-10-13 --dry-run         # judge in memory, store nothing
npm run preview:editor -- --date 2026-10-13 --dry-run --all   # plus every judgment, by story
```

`--dry-run` uses the local `ANTHROPIC_API_KEY` and reads with
`SUPABASE_ANON_KEY`. It writes nothing. A day costs about two cents.

To see the effect on the digest itself, `npm run digest -- --preview --date …`
shows the digest built from stored judgments ([`docs/digest.md`](digest.md)).

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
2. **The editor's view.** Stories (judged items grouped by `story_key`) in the
   digest's sections, with its default thresholds (`supabase/functions/_shared/newsroom/stories.ts`,
   shared with the digest; the rules are in [`docs/digest.md`](digest.md)):
   Top stories, Also notable, For builders, Paper of note. Unlike the digest,
   it doesn't leave out the previous morning's top stories.
3. **Rated 7+ but not shown by the old digest.**

## Cost and caps

Claude Haiku 5.5 (`claude-haiku-5-5`) at $0.10 / $0.50 per million input /
output tokens. A weekday of about 150–190 items measured 70–110k input tokens
and 16–22k output tokens: **about $0.015–0.02 a day**, well under $1 a month.
Each run logs its calls, tokens and estimated cost, and adds a summary table to
the GitHub run page.

**Billing:** the editor, and the digest's repeat check, run on the API credits
included with the owner's Max plan, through a Claude Console organization.
They don't draw on the Max plan's chat or Claude Code usage limits.

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

Clearing `editor_judged_at` alone is enough. The editor rejudges any row where
it is null, and its write replaces every `editor_*` column.

**Done once for real on Oct 17, 2026**, so the first new digest would use
rubric v4. The 30-hour window covered that morning's digest:

```sql
update news_items set editor_judged_at = null
where fetched_at > now() - interval '30 hours'
  and editor_version is distinct from '2026-10-17.4';
```

Clear and backfill well before 8:30 AM ET, or after 9:00. Otherwise the
morning's digest may find the window mostly unjudged and fall back to the old
ranking. The digest's own editor job only judges up to its caps (300 items, 20
calls).

## The backfill: `editor-backfill.yml`

Actions → **AI Editor Backfill** → Run workflow. Inputs: `days` (7),
`max_items` (1500), `max_calls` (80). Same code, logging and auth as the
scheduled run. It exists because only GitHub has the database's write key.

**The first backfill** (Oct 16–17, 2026, right after migration 004 and the PR #8 merge) judged **924 of 924**
items in 37 calls, for about $0.11.

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
7. Once it has worked, delete the `ANTHROPIC_API_KEY` repository secret. Only
   the editor jobs read it (in `collect.yml`, `digest.yml` and the backfill).

**Status (Oct 22, 2026): not done yet. This is an owner follow-up.** No
`ANTHROPIC_FEDERATION_*` variables exist, so every run uses the
`ANTHROPIC_API_KEY` secret. To finish:
1. Complete the Console wizard (steps 1–5).
2. Confirm that an editor log says `auth: workload identity federation (GitHub OIDC token)`.
3. Then delete the secret.
