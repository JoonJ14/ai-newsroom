# Decisions

Architectural and design decisions that a future change could undo by
accident, question, or misread without this context. Each entry gives the
decision, why it was made, what else was tried, and what it constrains.

Older, project-wide decisions live in CLAUDE.md's "Key Design Decisions":
pre-cached data rather than on-demand scraping, refresh vs retention,
Supabase Cron scheduling with GitHub Actions executing, TypeScript everywhere,
and source customisation via config. Debugging stories are in
[`TROUBLESHOOTING.md`](TROUBLESHOOTING.md).

Phases: scheduling (PRs #5–#6), step 1 collection (PR #7), step 2 the AI
editor (PR #8), step 3 the digest (PR #9) and its tuning (PR #10), step 4 the
MCP server (PR #11). Entries for scheduling and step 1 (`DEC-017`, `DEC-018`)
were written afterwards from PRs #5–#7, `docs/scheduling.md`, migration 003 and
`reviews/review-2026-10-14-a25a5ce.md`.

---

## DEC-001: Judge each item once, at collection time, and store the judgment on the row
**Date:** 2026-10-16 | **Phase:** step 2

- **Decision:** Claude Haiku 5.5 judges every collected item once, and the
  result goes into ten nullable `editor_*` columns on `news_items` (migration
  004). The digest and the MCP read the stored judgment. Neither calls a model
  to rank. The one exception is the digest's daily repeat check (`DEC-010`).
- **Context:** the old score (`0.4 × recency + 0.4 × community + 0.2 × tier`,
  then a per-source floor) never reads content. On Oct 8 a Claude Code patch
  was Top Story and GPT-6 ranked 4th in its section. 68% of items have no
  engagement signal.
- **Alternatives considered:**
  - *Retune the formula.* The signal that tells a launch from a patch isn't in
    recency, points or tier, so no weighting finds it.
  - *Judge at read time*, in the digest and in each MCP call. Rejected: the
    cost would scale with traffic, answers would differ between callers and
    calls, and every MCP request would wait on a model call.
  - *A separate judgments table.* Rejected: same-row columns need no join and
    keep the `(url, source)` identity. Nullable columns mean "not judged yet"
    with no extra state.
- **Rationale:** about $0.02 a day (measured: 187 items for $0.020, 150 for
  $0.013). The judgment is stable once stored, and one judgment serves every
  reader.
- **Key properties:**
  - **Written once:** `writeJudgments` updates by id with
    `.is('editor_judged_at', null)`.
  - **Never written by collection:** `toUpsertRow` lists its columns, and a
    test asserts no `editor_*`, `fetched_at` or `id`. An upsert updates only
    the columns it sends.
  - **Re-judge** by clearing the columns for a window, then running the
    backfill (docs/editor.md).
  - **Caps per run:** 300 items, 20 calls, 600k input tokens, batches of 25.
  - **Every read pages on `id`** within a frozen window (PostgREST's
    1,000-row cap).

## DEC-002: No temperature; consistency from structured outputs, the rubric and effort `low`
**Date:** 2026-10-16 | **Phase:** step 2

- **Decision:** the editor sends no `temperature`. Output is constrained by a
  JSON schema (`output_config.format`), at effort `low`. The prompt uses
  batch-local refs (`i1`, `i2`…) instead of row UUIDs.
- **Context:** the brief asked for `temperature: 0`, and Haiku 5.5 rejects it
  with HTTP 400.
- **Alternatives considered:**
  - *An older model that accepts temperature.* Rejected: Haiku 5.5 is the
    current small model.
  - *Tool-forced JSON.* Rejected: structured outputs are native and simpler.
- **Rationale:** each item is judged once, so run-to-run variance (about ±1)
  only matters when re-judging. Batch-local refs save tokens, can't be
  mistyped into another row's id, and keep row ids out of the prompt.
- **Key properties:**
  - Validation clamps what the schema can't express: importance 1–10, headline
    ≤120 characters, why ≤240, key slug ≤80.
  - A malformed entry is rejected on its own.
  - A batch cut off at `max_tokens`, or declined, is retried once as two
    halves.

## DEC-003: The rubric is a versioned file; stored judgments aren't redone when it changes
**Date:** 2026-10-16 | **Phase:** steps 2–3 and tuning

- **Decision:** `config/editor-rubric.md` is the system prompt, word for word.
  Its `<!-- rubric-version: … -->` line is stored with every judgment
  (`editor_version`). A rubric change applies to new items only.
- **Context:** the owner tunes the rubric, and three versions shipped this
  session (`2026-10-16.3`, `2026-10-17.4`, `2026-10-21.5`).
- **Alternatives considered:** *re-judge history automatically on every
  change.* Rejected: it costs money, it rewrites what past digests were built
  on, and it hides which rubric produced which judgment.
- **Key properties:**
  - **Bump the version on every edit**, and try changes with
    `npm run preview:editor -- --date … --dry-run` first.
  - The field names and allowed values live in code
    (`supabase/functions/_shared/newsroom/types.ts`), not in the rubric.
  - The anchor examples overlap the test days (Oct 8, 13, 16, 18–21), so
    previews of those days flatter the rubric.
  - **Measured limit:** rubric v5 moved follow-up scores only about a point.
    Prompt rules alone don't stop repeats, which is why `DEC-010` exists.

## DEC-004: Workload identity federation with a fresh GitHub token per exchange; API key as fallback
**Date:** 2026-10-16 | **Phase:** step 2

- **Decision:** on Actions, the client uses the SDK's `oidcFederationProvider`,
  with an `identityTokenProvider` that asks the Actions runtime for a new OIDC
  token (audience `https://api.anthropic.com`) at every exchange.
  - The order is `federation-github`, then `federation-env`
    (`ANTHROPIC_IDENTITY_TOKEN_FILE`), then `api-key`, then `none`. `none`
    warns and exits 0.
  - The federation IDs are repository **variables**.
- **Context:** the documented pattern writes the token to a file once, and
  GitHub's tokens last about 5 minutes, which a backfill can outlast.
- **Alternatives considered:** *a token-file step.* It's kept as option 2 for
  other CI systems, but on GitHub it goes stale mid-run.
- **Key properties:**
  - `id-token: write` only on jobs that call Claude: the editor jobs, the
    backfill, and since PR #10 the digest job for the repeat check.
  - The federation rule should pin `repository_owner` and `ref = refs/heads/main`.
    A subject prefix alone also matches `main-anything`.
  - **Status:** the owner hasn't completed the wizard (no `ANTHROPIC_FEDERATION_*`
    variables), so production runs on the `ANTHROPIC_API_KEY` secret.

## DEC-005: Stories by `editor_story_key`; the representative item chosen by source, with a guard
**Date:** 2026-10-17 | **Phase:** step 3

- **Decision:**
  - Judged items are grouped by `editor_story_key`, and the story's
    importance is the max of its items.
  - Outlets are every copy, including `metadata.coveredBy`, named by
    display name (HN links by publisher, `DEC-012`).
  - The representative item gives the headline, the why-line and the link.
    The order is official lab, then wire service (Reuters, AP, FT, Bloomberg,
    also when linked via HN), then tier-1/2 press, then the rest; ties go to
    importance, then the earliest published.
  - **The guard:** only items within one point of the story's best
    importance, *and* matching the story's audience (`general` if any such
    item is), can represent it.
- **Context:** applied strictly, the order made NVIDIA's "run Muse Spark Open on
  GB300" post (an official lab post, rated as a builder item) the
  representative of Meta's launch.
- **Alternatives considered:**
  - *Rank items instead of stories.* That repeats one story across a section.
  - *Lead by importance only.* That loses the primary source when the press
    rates a point higher.
- **Key properties:**
  - Ranking is importance, then outlet count, then recency (`rankStories`).
  - arXiv/HF-only stories go to Paper of note. A paper the press covered is
    led by the press item, and competes as news.

## DEC-006: On digest mornings the editor runs outside the `editor` concurrency group
**Date:** 2026-10-17 | **Phase:** step 3

- **Decision:** `digest.yml` runs `npm run editor` as its own first job:
  - with `continue-on-error` on the step and the job, and the digest job on
    `if: !cancelled()`;
  - **without** `concurrency: editor`, unlike `collect.yml`'s editor job and
    the backfill.
- **Context:** the digest must go out at 9:00 even if the 8:30 collect or its
  editor was late or failed.
- **Alternatives considered:** *join the group.* A run waiting in the group
  would delay the digest, and a newer queued run would cancel the waiting one.
- **Rationale:** overlapping editors are safe, because a write needs
  `editor_judged_at IS NULL`. The worst case is a few cents of duplicate
  judging.

## DEC-007: Fall back to the old ranking when most of a window is unjudged, and say so
**Date:** 2026-10-17 | **Phase:** steps 3–4

- **Decision:** below 50% of the window judged (`DIGEST_MIN_JUDGED_SHARE`,
  shared as `DEFAULT_MIN_JUDGED_SHARE`), or when the editor columns can't be
  read, the digest and the MCP's `get_top_picks` use the old
  `buildSlottedDisplay`.
  - The digest says so in its footer: "AI editor unavailable today — basic
    ranking".
  - The MCP says so in `mode: "fallback"` and a `note`.
  - Otherwise unjudged items are left out of the sections and counted
    ("+N items not yet rated").
- **Context:** an editor failure must never stop a digest. A half-judged window
  ranked by the editor would quietly omit the unjudged half.
- **Key properties:**
  - `buildSlottedDisplay` is kept unchanged as the fallback, and lives in the
    shared `slots.ts`.
  - The MCP trims its own fallback's Official section to `officialLimit`; the
    shared code is untouched, so the digest's fallback is unchanged.

## DEC-008: Discord escaping per field; masked links; `plain` layout by default
**Date:** 2026-10-17 | **Phase:** step 3

- **Decision:**
  - Untrusted text (headlines, why-lines, outlet names, the fallback summary)
    is escaped where it's inserted (`escapeDiscord`): `\ * _ ~ ` | [ ] < >`,
    `://` → `\://`, and a word joiner after `@`, collapsed to one line.
  - Our own markup is added around the escaped text.
  - Links are `[headline](<https://…>)`. Plain messages also set `flags: 4`,
    and every payload sets `allowed_mentions: { parse: [] }`.
  - Two layouts: `plain` (the default) and `embeds` (`DIGEST_LAYOUT`).
  - A story is never split across messages.
- **Alternatives considered:**
  - *Escape the whole message with line-prefix exemptions.* That breaks every
    time our markup changes.
  - *Escape `- # ( ) :` too.* Unneeded mid-line, and it risked visible
    backslashes.
- **Key properties:**
  - With full URLs, `plain` is usually two messages (about 3,400 characters
    against the 2,000 limit); `embeds` fits one (about 3,000 of 6,000).
  - Slack, Telegram and iMessage get plain text with full URLs, and keep
    their own escaping.

## DEC-009: `last_digest_at` stores the window's end, not the time of sending
**Date:** 2026-10-17 | **Phase:** step 3

- **Decision:** a sent digest records the instant its window ended (the run's
  start) as `last_digest_at`, and the next window starts there. `updated_at`
  is still the time of the write, which is what the 9:30 alarm reads.
- **Context:** recording the send time skipped the items fetched while a digest
  was being built.
- **Key properties:**
  - **A real send moves `last_digest_at`**, which shrinks the next morning's
    window. **Never trigger an extra digest to test.** Use
    `npm run digest -- --preview --date …` (anon key, never writes) or
    `--dry-run`.

## DEC-010: The digest is a daily newspaper: a 7-day history and a model repeat check
**Date:** 2026-10-21 | **Phase:** tuning

- **Decision:** before sectioning, one Claude Haiku 5.5 call compares the
  candidates (stories rated high enough for any section) with
  `digest_state.story_history`, every story shown in the last 7 days. It
  classifies each candidate as `new`, `update` (with the new fact, whether
  it's minor, and the entry it continues) or `repeat`.
  - Repeats are dropped.
  - An update is cut to the items fetched after the story was last shown,
    preferring editor-flagged follow-ups, and ranked by those items alone.
    Its headline gets "Update: " in every layout. A minor update can't be a
    top story.
  - Candidates continuing the same story are merged, so one story is never
    shown twice.
  - **If the call fails, the key rule applies:** a key shown in the last 7
    days stays out unless an item fetched since is a follow-up.
- **Context:** the first five digests repeated retellings and showed Disney
  twice. Stored data showed that follow-up flags are over-set, keys drift, and
  step 3 only remembered one morning's Top stories.
- **Alternatives considered:**
  - *Keys plus flags only.* Shown unreliable by the data.
  - *The rubric alone* (v5). Moved scores only about a point.
  - *A "still developing" line.* Not wanted by the owner.
- **Rationale:** importance stays absolute, so dropping a repeat never pulls
  a weaker story up: a slow day shows fewer stories. The check costs about
  $0.002 a day (effort `medium`, `REPEAT_MAX_TOKENS` 12,000, at most 40
  candidates and 150 history lines).
- **Key properties:**
  - **No migration:** the history is a `digest_state` row.
  - `last_digest_story_keys` is still written, so a rollback to step 3 works.
    It seeds the history on the first run.
  - A fallback or empty day keeps the history as it was.
  - **Digest-only:** the stateless MCP doesn't use the history or the check.
  - The preview replays the 7 prior mornings, at about $0.015 with the model,
    or for free with `--no-repeat-check`.

## DEC-011: The model's links must be plausible: a copied headline, and a shared subject
**Date:** 2026-10-21 | **Phase:** tuning

- **Decision:** a verdict's link to a history entry, a `same_as` merge, and a
  key match all count only if one side's **subject** (the first name in its
  lead headline) is named in the other.
  - The history entry is found by the headline the model copied
    (`continues_headline`) before its line number. A number one or two off is
    corrected to a neighbour that passes.
  - A repeat or update of nothing related is treated as new.
- **Context:** the model miscounted refs (the false police tip as a "repeat"
  of ECDSA or India) and merged unrelated stories (Meta into OpenAI). Keys
  failed too: the editor gave Google's PyTorch tool Amazon's key.
- **Alternatives considered:**
  - *Trust the model.* Wrong several times per replay.
  - *Trust keys first.* Propagated the editor's borrowed key.
  - *Any shared capitalised word.* "Guardian" in a podcast headline linked
    MI5 to a Guardian column.
- **Key properties:** `namesIn` drops generic and sentence-start words,
  months and weekdays, and press outlet names. It keeps lab names. Names are
  normalised (`Character.AI` = `characterai`), and identical headlines always
  match.

## DEC-012: HN links name their publisher; weak sources can't lead; 2 stories per outlet
**Date:** 2026-10-21 | **Phase:** tuning (used by the MCP since step 4)

- **Decision:**
  - **Publishers:** an `hackernews_top` item linking an external article is
    credited to its publisher from `PUBLISHERS` ("Reuters (via HN)"), or the
    bare domain. Show HN and HN text posts stay as they are, and a publisher
    also carried directly is listed once.
  - **Weak sources:** a story can be a top story only if a copy is from an
    official lab, a wire service, the tier-1/2 press or a known publisher via
    HN, unless it's rated 8+ (`DIGEST_TOP_WEAK_SOURCE_MIN_IMPORTANCE`).
  - **Variety:** at most 2 stories per lead outlet in each section
    (`DIGEST_MAX_PER_OUTLET`). Overflow falls to a later section, or out, and
    is never padded in.
- **Context:** "China curbs AI exports · Hacker News" hid Reuters and AP.
  Oct 18's #1 story was backed only by a Dev.to post. Three Anthropic items
  sat in one section.
- **Key properties:**
  - `PUBLISHERS` also decides what counts as strong. Adding a domain changes
    the digest. Forbes is left out because of its contributor posts.
  - Lab domains aren't in the map yet (an open entry in TROUBLESHOOTING).

## DEC-013: One copy of the selection code, in `supabase/functions/_shared/newsroom/`
**Date:** 2026-10-22 | **Phase:** step 4

- **Decision:** the code both runtimes need lives in
  `supabase/functions/_shared/newsroom/`: `types`, `rows`, `source-names`,
  `stories`, `why` and `slots`.
  - It is pure TypeScript with no imports outside the folder, and `.ts`
    import suffixes, as Deno requires.
  - Node keeps its import paths through one-line re-exports
    (`src/editor/select.ts`, `src/utils/source-names.ts`, `src/utils/slots.ts`,
    `src/digest/why.ts`, and the `NewsItem` and `Coverage` types).
  - `tsconfig.json` gains `allowImportingTsExtensions` and
    `rewriteRelativeImportExtensions`, and drops `rootDir`.
- **Context:** the MCP had its own copies of the slotting and the names, and
  ranked differently from the digest.
- **Alternatives considered:**
  - *Import `src/` from the function by relative path.* The Supabase bundler
    may not upload files outside `supabase/functions/`, and a test deploy
    wasn't allowed.
  - *Keep two copies, with an equality test.* The brief forbade copies, and
    drift is how the MCP fell behind.
- **Key properties:**
  - **Edit the shared file, never a re-export, and never copy it.**
  - It must stay under `supabase/functions/`, or the deploy won't upload it.
    CI checks the `deno info` module graph, and also runs `deno check` and
    `deno bundle`.
  - `PRESS_SOURCES` is static, because the function can't read
    `sources.yaml`. A test keeps it equal to the YAML.
  - A test asserts that the digest path and the MCP path get the same
    function objects.

## DEC-014: The MCP serves judgments, statelessly, with the old fields kept
**Date:** 2026-10-22 | **Phase:** step 4

- **Decision:**
  - Every story carries the editor's fields (null when unjudged) and
    `outlets`, alongside every legacy field.
  - `get_top_picks` is the digest's sections for a window (24 h by default,
    `hours` or `since`).
  - The list tools group copies into stories and rank them like the digest.
    They take `min_importance`, `type` and `audience` filters; invalid values
    are answered with -32602.
  - **`get_trending` defaults to the last 7 days.**
  - Reads only.
- **Context:** assistants may already call the 8 tools with the old
  parameters.
- **Alternatives considered:**
  - *`get_trending` over the whole 90-day cache*, as before. Ranked by
    importance, month-old 9s would top every answer.
  - *Pushing editor filters into SQL for every list tool.* That drops a
    story's lower-rated copies, so the pushdown is used only where a cap
    precedes ranking (`get_source_updates`).
- **Key properties:**
  - All 8 tool names and their old parameters keep working; the per-section
    limits now apply only in the fallback.
  - Paged reads re-count the window after the scan and report `truncated`.

## DEC-015: Merge equals deploy for the MCP server, with a live smoke test
**Date:** 2026-10-22 | **Phase:** step 4

- **Decision:** `deploy-mcp.yml` runs on a push to `main` under
  `supabase/functions/**` (or on `workflow_dispatch`, `main` only). Its steps:
  1. `deno check`.
  2. Stamp `build-info.ts` with `$GITHUB_SHA`.
  3. `supabase functions deploy mcp --project-ref … --no-verify-jwt --use-api`.
  4. `scripts/smoke-mcp.sh`, retried for about 2 minutes. It fails on any
     error, if the tool count isn't 8, or if the live commit isn't the one
     deployed.

  `supabase/config.toml` also sets `verify_jwt = false` for `mcp`.
- **Context:** nothing deployed the function, so it lagged `main` for months.
- **Rationale:**
  - **The JWT setting:** assistants connect without a Supabase JWT, and
    turning verification on would break every connection. It's set in two
    places, so neither alone can turn it on.
  - **The stamped commit** makes "what's live?" a single call.
- **Key properties:**
  - **Never deploy by hand or from a branch.**
  - The token is scoped to Edge Functions read/write plus project read. Ask
    for one more permission only if a deploy names it.
  - A deploy doesn't touch the function's secrets (`GITHUB_TOKEN`).
  - `contents: read`; one deploy at a time, never cancelled.

## DEC-016: No third-party GitHub Actions; pinned, verified installs instead
**Date:** 2026-10-22 | **Phase:** step 4

- **Decision:**
  - Deno is installed by `scripts/install-deno.sh`: v2.9.8 from its GitHub
    release, checked with `sha256sum -c` against the published checksum.
  - The Supabase CLI comes from npm (`supabase@2.121.0`), installed into a
    prefix.
- **Context:** the repository's Actions policy allows GitHub-owned actions
  only, and `denoland/setup-deno` made CI fail at startup.
- **Alternatives considered:** *allow-list the official actions.* That's the
  owner's policy to change. Switching back is a small edit if they do.

---

## DEC-017: Supabase Cron schedules the runs; GitHub Actions still executes them
**Date:** 2026-10-12 | **Phase:** scheduling (PRs #5, #6)

- **Decision:** GitHub's `schedule:` triggers are commented out, not deleted.
  `pg_cron` fires hourly and gates on the America/New_York hour.
  `pg_net` then POSTs to `…/actions/workflows/<file>/dispatches` with
  `{"ref":"main"}`, and the run itself happens on GitHub Actions as before
  (migration 003, `docs/scheduling.md`).
- **Context:** `digest.yml` was scheduled for `45 15 * * *` (11:45 AM ET) but
  landed between 2:30 and 6:00 PM ET, and the delays were getting worse.
  - The runners were never the problem: once a run exists, the digest reaches
    Discord in a minute or two.
  - GitHub's scheduler creates runs late, or drops them, on free public repos
    under load.
  - API dispatches skip that scheduler and start within seconds.
- **Alternatives considered:**
  - *(a) Schedule earlier on GitHub.* Rejected: the delay varied by hours, so
    no offset would land reliably.
  - *(c) Move collectors and the digest into Supabase Edge Functions.*
    **Deferred, not rejected.** The costs: Edge Function CPU and wall-clock
    limits, sources that may block cloud IPs, and deploys that would no longer
    follow a merge. Revisit only if the hybrid causes trouble.
- **Rationale for (b):** it fixes the timing and keeps everything else:
  - merge-to-main is still the deploy for collect and digest;
  - full GitHub runners, with no CPU limits, so a headless browser stays
    possible;
  - the same egress IPs, so no new blocked-source risk;
  - the Actions logs and the "Run workflow" button;
  - a rollback in minutes (uncomment `schedule:`, unschedule the jobs).
- **Key properties:**
  - **One number sets the times:** `private.digest_hour_ny()`, currently 9.
    The 9:30 alarm and the collects (2:30, 8:30, 14:30, 20:30) derive from it.
    Hours 1 and 2 are refused (they double or vanish on DST nights). The 8:30
    collect exists so the digest sees overnight news.
  - **Security:** all functions are in a `private` schema, with EXECUTE and
    USAGE revoked from `public`, `anon` and `authenticated`. In `public`, the
    anon key could trigger workflow runs through PostgREST.
  - **The request headers** include `User-Agent: ai-newsroom-scheduler`;
    GitHub rejects API calls without one.
  - **Secrets are in Supabase Vault only,** added through the dashboard rather
    than the SQL Editor, so they never reach query history:
    `github_dispatch_token` (a fine-grained PAT, this repo, Actions read/write)
    and `discord_webhook_url` (the 9:30 alarm).
  - **The token expires around 2027-01-10;** renew it around 2027-01-03
    (`docs/scheduling.md`, "Renewing the token").
  - **Free-tier keep-alive:** the collectors write every 6 hours, which also
    keeps the free Supabase project from pausing for inactivity.
  - The old CLAUDE.md decision "GitHub Actions for collectors, not Supabase
    cron" was replaced by this one.

## DEC-018: Rebuild the ranking in four PRs, starting with collection only
**Date:** 2026-10-14 | **Phase:** step 1 (PR #7)

- **Decision:** the ranking is rebuilt in four separate PRs: collection, the
  AI editor, the digest, the MCP.
  - Step 1 deliberately left scoring, slotting, the digest format and the MCP
    alone.
  - The product was reframed: a morning briefing of the big AI news for anyone
    following AI (model launches named clearly, policy and regulation, safety,
    lab and business news), with builder content secondary.
- **Context:** a read-only audit of the code plus 14 days of real data
  (`ranking-audit.md`, the owner's local file, not committed). Its key
  findings:
  - **The score never read content:** `0.4 × recency + 0.4 × community +
    0.2 × tier`, then a per-source `scoreFloor`. 68% of items had no
    engagement signal.
  - **Floors equalised official items:** a Claude Code patch scored 80, like a
    major announcement. On Oct 8 a patch was Top Story while GPT-6 sat 4th.
  - **Every arXiv paper scored 72–73.**
  - **HF Spaces were pinned at 93:** with no date field they always looked
    fresh, and they were Top Story 4 days out of 7.
  - **HF Papers showed 0 upvotes:** the code read `numLikes`, but the field is
    `paper.upvotes`.
  - **Config that did nothing:** the `priorities` weights in `sources.yaml`
    were never read, and the digest's AI summary never ran, because the
    workflow passed no API key.
  - **13 of 34 enabled sources produced nothing in 14 days:**
    - Reddit ×5 (403, never stored a row);
    - DeepMind (404);
    - VentureBeat (429);
    - the Anthropic changelog (moved URL);
    - Meta (a stale scraper);
    - Google Research (a dead feed);
    - Karpathy, Altman and Steinberger (no posts, which is normal).
  - **The Anthropic scraper missed Haiku 5.5:** it only followed `/news/` links.
  - **Collect hung for 4–10 minutes after "Done"** (TROUBLESHOOTING).
  - **Signals were dropped:** HN points weren't stored, and engagement wasn't
    carried through dedup.
- **Alternatives considered:** *one big rewrite.* Rejected: four reviewable
  PRs, each verified on real data before the next, kept the 9:00 digest
  running throughout.
- **Key properties (the owner's calls):**
  - **Reddit:** disabled, collector kept. It may return through the official
    API, which needs a registered app. It's a community-reaction signal, not a
    headline source.
  - **HF Spaces:** dropped (demos and LoRAs).
  - **HF Papers:** kept, with upvotes fixed; a paper appears only when the
    editor marks it notable (about 1–2 a week).
  - **New outlets:** Ars Technica, The Guardian and WIRED were added. AP and
    Axios answer 403 to feed requests, and Reuters has no public RSS.
  - **Every disabled source** carries its reason in `config/sources.yaml`.

## DEC-019: Explainers and recaps of never-shown older events aren't filtered (for now)
**Date:** 2026-10-22 | **Phase:** digest tuning

- **Decision:** the repeat check compares only with stories the digest
  **showed** in the last 7 days. An explainer, podcast or recap of an older
  event the digest never showed (the Oct 20 MI5 video) is treated as new, and
  is ranked on its stored importance.
- **Context:** the Oct 18–21 comparison, and TROUBLESHOOTING's "Old news the
  digest never showed comes back as new".
- **Alternatives considered:**
  - *Honour a `repeat` verdict that names no related history entry.* Rejected:
    the same rule would drop real stories that the model mislinked (the false
    police tip).
  - *Also check against recently collected, never-shown stories.* Deferred: it
    changes the owner's rule ("never shown **again**").
- **Rationale (the owner's decision, 2026-10-22):** leave it as is. The
  mitigations are rubric v5 (retellings 1–3; it scored the MI5 podcast 2 and
  the video 5) and the why-line guard.
- **Revisit** only if explainers or recaps of older events keep reaching Top
  stories.

