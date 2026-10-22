# Troubleshooting

Problems met while building AI Newsroom, how each was diagnosed, what was tried
and what fixed it. Newest first within each phase. The design reasoning behind
the fixes is in [`DECISIONS.md`](DECISIONS.md); what shipped is in
[`../CHANGELOG.md`](../CHANGELOG.md). Quick answers for users are in the
README's Troubleshooting section.

Phases: scheduling (PRs #5–#6), then the ranking rebuild: step 1 collection
(PR #7), step 2 the AI editor (PR #8), step 3 the digest (PR #9) and its tuning
(PR #10), step 4 the MCP server (PR #11). The scheduling and step-1 entries at
the end were written afterwards, from PRs #5–#7, `docs/scheduling.md`,
migration 003 and `reviews/review-2026-10-14-a25a5ce.md`. The full session record for steps 2–4 is
[`sessions/2026-10-22-ranking-rebuild-steps-2-4.md`](sessions/2026-10-22-ranking-rebuild-steps-2-4.md).

---

## OPEN (deferred by decision) — Old news the digest never showed comes back as "new" (the MI5 explainer)
**Phase:** digest tuning (PR #10) | **Severity:** Low | **Status:** Open; left as is by the owner (`DEC-019`), to revisit if explainers or recaps of older events keep reaching Top stories

**Symptom.** In the Oct 18–21 before-and-after comparison, Oct 20's "MI5 chief
warns AI could change the stakes for bioweapons" still showed as top story #3.
It is a Guardian video explainer on a speech from Oct 14, and its own why-line
said so ("a video explainer on a speech already covered").

**Diagnosis / root cause.** The repeat check (`src/digest/repeats.ts`) compares
candidates with stories the digest **showed** in the last 7 days
(`digest_state.story_history`). The Oct 14 speech item (rated 5) ranked sixth
in Also notable on Oct 15 and was never shown, so there was nothing to repeat:
- The model did call the explainer a repeat, but it pointed at an unrelated
  history line: an IMF warning on one run, a Guardian column on another.
- The link check (no shared subject name) correctly refused those links, and
  turned the verdict into `new`.
- The editor's stored judgment (rubric v4) rated the video 6, enough for Top
  stories.

**Solutions considered.**
- *Honour a `repeat` verdict even when it points at nothing related.* The
  model recognised a retelling, so dropping it would be right here.
  - Rejected, because the same rule would wrongly drop real stories: in the
    same run it called Claude's false police tip a "repeat" of an unrelated
    India story, and that story had never been shown either.
- *Let the check see recently collected stories, not just shown ones.* A
  retelling of anything first collected more than N days ago would count as
  old news. Plausible, but it changes the owner's rule ("never shown
  **again**"), so it was flagged rather than built.
- *Fix it at the source, with rubric v5.* Retellings, explainers and videos on
  a covered story score 1–3. A dry run moved the podcast from 5 to 2, but left
  the video at 5.

**Fix.** None, by the owner's decision of 2026-10-22 (`DEC-019`). Mitigations
in place:
- Rubric v5 lowers such items.
- The why-line guard replaces their "already covered" lines.
- At 5, the video would be one line in Also notable rather than a top story.

**Results & verification.** The behaviour is reproducible with
`npm run digest -- --preview --date 2026-10-20 --history`.

---

## OPEN — HN links to a lab's own site show as a bare domain
**Phase:** MCP (PR #11) | **Severity:** Low | **Status:** Open

**Symptom.** A story can list `OpenAI` and then `openai.com (via HN)` (or
`alignment.openai.com (via HN)`).

**Diagnosis.** `itemOutlet` names an HN link's publisher from `PUBLISHERS`
(`supabase/functions/_shared/newsroom/source-names.ts`). Lab domains aren't in
that map, so the bare domain is shown, and it isn't merged with the lab's own
direct copy.

**Solutions considered.** Add `openai.com`, `anthropic.com`, `deepmind.google`
and similar to `PUBLISHERS`. That map also decides which copies count as strong
sources and how the digest lists outlets, so the change would alter the
digest's output, which was out of scope for step 4.

**Fix.** Deferred to the owner.

---

## RESOLVED — The first MCP deploy failed: "Invalid project ref format"
**Phase:** MCP (PR #11) | **Severity:** High | **Status:** Resolved
**Date resolved:** 2026-10-22

**Symptom.** The deploy step of `deploy-mcp.yml`, triggered by the PR #11
merge, failed in under a second:
```
Invalid project ref format. Must be like `abcdefghijklmnopqrst`.
```
Supabase was never contacted, so production stayed on the old build.

**Diagnosis / root cause.** The log printed the variable with leading
whitespace: `PROJECT_REF:   jialdowpnekknmxrwrdq`. `gh variable get
SUPABASE_PROJECT_REF | od -c` showed two leading spaces in the stored value.
The variable was created by hand, and the CLI validates the ref's format
before making any API call.

**Solutions considered.**
- *Trim whitespace in the workflow* (`"${PROJECT_REF//[[:space:]]/}"`). That
  makes the workflow robust to copy-paste, but it needs another PR and merge
  before the deploy can run.
- *Fix the variable* (chosen by the owner). Instant, and it's the actual
  fault.
- *Changing the variable myself with `gh variable set`* was offered but not
  done, because it's the owner's setting.

**Fix.** The owner removed the spaces in Settings → Secrets and variables →
Actions → Variables. I confirmed it with `od -c`, then re-ran the workflow
with `gh workflow run deploy-mcp.yml --ref main`.

**Results & verification.** Run `39726965410` succeeded on every step, and
the smoke test passed on its first attempt:
- `tools/list`: 8 tools;
- `check_status`: commit `1f0d2950d9d8…`, 100% of the last 24 hours judged;
- `get_top_picks`: mode `editor`, with 5 / 5 / 3 / 0 stories in the four
  sections.

The token's minimal scopes (Edge Functions read/write, project read) were
enough. A workflow-side trim is still a cheap hardening option.

---

## RESOLVED — CI ended in `startup_failure` on PR #11
**Phase:** MCP (PR #11) | **Severity:** High | **Status:** Resolved
**Date resolved:** 2026-10-22

**Symptom.** The first CI run on PR #11 ended in `startup_failure` with no
steps run, and `gh pr checks` reported "no checks". The run page said "This
run likely failed because of a workflow file issue." The YAML linted cleanly.

**Diagnosis / root cause.** `gh api repos/JoonJ14/ai-newsroom/actions/permissions`
returned `allowed_actions: selected`, and the selected-actions list allows
GitHub-owned actions only. The new steps used `denoland/setup-deno@v2.0.5` and
(in the deploy) `supabase/setup-cli@v3.0.1`. GitHub rejects a disallowed
action before a job starts, which reads like a syntax error.

**Solutions considered.**
- *Allow-list the two actions.* That's the cleanest, but it's a repository
  policy change, which is the owner's call.
- *Install the same pinned versions without third-party actions* (chosen):
  - Deno's GitHub release ships a `.sha256sum` per asset, so it can be
    verified.
  - The Supabase CLI's npm package is pinned by version. Its npm package
    rejects a global install, so it goes into a prefix.

**Fix.** `scripts/install-deno.sh` downloads `deno-x86_64-unknown-linux-gnu.zip`
for v2.9.8, runs `sha256sum -c` against the published checksum, unzips it and
appends to `GITHUB_PATH`. `deploy-mcp.yml` installs the CLI with
`npm install --no-save --prefix "$RUNNER_TEMP/supabase-cli" supabase@2.121.0`.

**Results & verification.** The next CI run passed. Its log showed
`deno-x86_64-unknown-linux-gnu.zip: OK`, `deno 2.9.8 (… x86_64-unknown-linux-gnu)`
and `bundled 334448 bytes`. If the owner later allows the official actions,
switching back is a two-step edit.

---

## RESOLVED — Codex reviews were incomplete, or looked clean when they weren't
**Phase:** MCP (PR #11) | **Severity:** Medium | **Status:** Resolved
**Date resolved:** 2026-10-22

**Symptom.**
- I reported PR #11 ready to merge without polling Codex. The owner asked,
  and three findings were still unresolved.
- Later in the loop, one round posted "Codex Review: Something went wrong.
  Try again later", and then its summary comment flipped to `completed` with
  `has_any_findings: false`. The poll script read that as `CLEAN`.

**Diagnosis.**
- The babysit loop was run on PRs #8–#10 but skipped on #11.
- Codex keeps a single summary comment that it edits in place. After an error
  on one trigger, the summary state can describe a different trigger's result.

**Fix.**
- Run the loop on every PR before reporting it ready.
- When an error comment appears next to a "clean" state, request one more
  review (`@codex review`). Here that next review found a real bug (the
  `get_source_updates` cap).
- The final round said "Didn't find any major issues" explicitly, for head
  `6fcd570`.

**Results & verification.** The loop found and fixed 7 issues on PR #11 (see
the next entry).

---

## RESOLVED — MCP fallback and filtering bugs found in review
**Phase:** MCP (PR #11) | **Severity:** Medium | **Status:** Resolved
**Date resolved:** 2026-10-22

**Symptom.** Codex found seven cases where the MCP tools silently returned
less than they should, each reproduced with a fixture:
1. `get_top_picks` with `showAll` in the fallback returned 4 of 20 unjudged
   TechCrunch items.
2. The fallback rendered rated items as `[unrated]`.
3. `search` with `min_importance: 9` found nothing when 100 higher-scored,
   low-importance matches came first.
4. `officialLimit: 0` still showed a Claude Code release.
5. A row committed mid-scan was skipped without `truncated` being set.
6. `get_source_updates` with `min_importance: 9` missed a match that was the
   61st newest item.
7. Five low-rated title matches stopped `search` from looking at summaries.

**Diagnosis / root cause.** They all follow one pattern: **a cap or a
decision applied before the editor-aware step.**
- *1:* the shared old ranking (`slots.ts`) has more limits than the four the
  MCP lifted, plus a 500-item pool.
- *2:* the fallback mapped every item through `unjudgedEntry`.
- *3 and 7:* `search` kept the top 100 matches by old score, and decided on
  the summary search from raw row counts, both before filtering.
- *6:* `get_source_updates` took the newest 60 rows, then filtered.
- *4:* `slots.ts` caps blog entries to `officialLimit` and then appends
  every release.
- *5:* the post-scan completeness count from the old `fetchAllRows` was
  dropped in the rewrite. `fetched_at` is transaction-start time, so a batch
  begun before the cutoff can commit mid-scan inside the window.

**Solutions considered.**
- *For 4:* fixing `slots.ts` would also change the digest's fallback, which
  was out of scope, so the MCP trims its own copy of the section instead.
- *For 6:* pushing the filters into SQL for every list tool would drop a
  story's lower-rated copies (filters apply at story level, importance being
  the story's max), so the pushdown is limited to `get_source_updates`.

**Fix** (`supabase/functions/mcp/_shared/`):

| Case | Fix |
|---|---|
| 1 | `SLOTS_ALL` (every limit `Infinity`), and no pool cap under `showAll` |
| 2 | `itemEntry` keeps a judgment |
| 3 | `search` pages every match through `fetchRows` with a `search` filter, up to 5,000 per column |
| 4 | The Official section is trimmed to `officialLimit` on the MCP side |
| 5 | `fetchRows` counts the window again after the scan and sets `truncated` |
| 6 | `RowFilter.editor` adds `gte('editor_importance')` and `eq('editor_type' / 'editor_audience')` to `fetchLatest` only |
| 7 | The summary search is decided on `rankEntries(found, filters).length < 5` |

**Results & verification.** Each case has a regression test in
`tools.test.ts` (68 assertions). The `get_source_updates` pushdown was checked
against live data, read-only: TechCrunch at `min_importance: 7` returned four
7–8 stories.

---

## RESOLVED — The repeat check's model linked unrelated stories
**Phase:** digest tuning (PR #10) | **Severity:** High | **Status:** Resolved (residual variance)
**Date resolved:** 2026-10-21

**Symptom.** On real replays of Oct 18–21, the one-call repeat check:
- pointed at the wrong history line: Claude's false police tip was a "repeat"
  of an ECDSA story, then of an India story;
- merged Meta's terms story into OpenAI's agent incidents (`same_as`);
- called Google's PyTorch tool an "update" of Amazon's TorchNeuron;
- at effort `low`, called Nscale's deal an update of Anthropic's share pledge,
  and flipped Meta's Oct 18 reversal between "update" and "repeat" across
  runs.

**Diagnosis / root cause.**
- **Refs are miscounted.** The verdict names a history line as `hN`, and
  Haiku miscounts numbered lists. The correct entry for the false tip
  (`claude-false-murder-tip-philadelphia`) sat next to the one it named.
- **Topic, not event.** At low effort the model links on shared topic or
  company ("AI security", "Anthropic") rather than the underlying event.
- **Keys aren't proof either.** The PyTorch case wasn't the model's fault:
  the editor had stored Google's item under `amazon-torchneuron-pytorch-tool`,
  and keys were trusted to pin the history entry.

**Solutions considered, in the order tried.**
1. *Copy the headline.* The model returns `continues_headline` as well as
   `hN`, and it is matched (normalised) before the ref. Models copy text more
   reliably than they count. It fixed most misrefs.
2. *Keys pin the entry first.* That fixed the false tip, but it propagated the
   editor's wrong key in the PyTorch case.
3. *Any shared capitalised word.* Too loose: "Guardian" in a podcast headline
   tied MI5 to a Guardian column.
4. *The subject rule* (chosen). One side's subject, the first name in its lead
   headline, must be named in the other side.
   - `namesIn` skips generic words, months and weekdays, sentence-start words
     like "Judge", and press outlet names (`PUBLISHERS`, "Hacker News", "FT",
     …). Lab names are kept.
   - Names are normalised: `Character.AI` = `characterai`, `GPT-6` = `gpt6`.
   - Identical headlines always match.
   - The rule applies to the model's refs, to `same_as` merges, **and to key
     matches**.
   - A ref one or two lines off is corrected to a neighbour that passes.
   - A repeat or update of nothing related becomes `new`.
5. *Prompt examples* for a reversal (a major update) and for a different
   company's similar launch (new), plus "sharing a topic is not enough".
6. *Effort `medium`*, which removed the Nscale mislabel. It costs about
   $0.002 a day.

**Fix.** All of the above, in `repeats.ts`: `REPEAT_EFFORT = 'medium'`
(override with `DIGEST_REPEAT_EFFORT`), `continues_headline` in the schema,
and `related()` / `headlineNames()`.

**Results & verification.**
- Final replays had no cross-story merges and no cross-company updates.
- Tests cover a miscounted ref, an unrelated `same_as`, a borrowed key, and
  `xAI`- and `iPhone`-style names. (Lowercase-initial names were Codex's
  finding: the first version required a leading capital.)
- **Residual:** judgment calls still vary between runs. Anthropic's
  self-replicating-worms story came out as an update in one run and a repeat
  in another.

---

## RESOLVED — The repeat check ran out of output tokens at effort `medium`
**Phase:** digest tuning (PR #10) | **Severity:** Medium | **Status:** Resolved
**Date resolved:** 2026-10-21

**Symptom.** The Oct 21 replay logged
`Repeat check: key rule (stopped: max_tokens)`.

**Diagnosis.** At `medium` effort, Haiku 5.5's adaptive thinking spends output
tokens. Forty candidates plus thinking exceeded `REPEAT_MAX_TOKENS = 4000`, and
`apiRepeatCall` treats any stop other than `end_turn` as a failure.

**Fix.** `REPEAT_MAX_TOKENS = 12_000`, still under a cent a day. As intended,
the failure fell back to the key rule and the digest was still built, so it
also served as a real test of the fallback.

**Results & verification.** The re-runs completed in model mode, with 18–22k
output tokens across the 8 replayed calls.

---

## RESOLVED — Retellings and small tweaks came back; one story appeared twice
**Phase:** digest tuning (PR #10) | **Severity:** High | **Status:** Resolved (except the MI5 case above)
**Date resolved:** 2026-10-21

**Symptom.** The first five real digests (Oct 17–21) showed:
- **retellings:** OpenAI's test-hacking story again on Oct 19, and an MI5
  explainer on Oct 20;
- **one story twice:** two Disney/Character.AI items on Oct 19, one in Top
  stories and one in Also notable;
- **a small tweak:** Meta removing the word "train" on Oct 21, a day after
  dropping the scraping language.

**Diagnosis / root cause.** A read-only query of 1,465 stored judgments over
10 days found three causes:
1. **Follow-ups are over-flagged.** Both the OpenAI retelling and the MI5
   explainer had `editor_followup = true`. Step 3's rule ("not repeated unless
   an item is a follow-up") let them through.
2. **Memory was one morning and one section.** `last_digest_story_keys` held
   only the previous digest's keys, and only the Top stories counted.
3. **Keys drift.** TechCrunch's Disney story was `characterai-bankruptcy`, and
   WIRED's was `disney-characterai-tech-offer`. No key rule can join them.

**Solutions considered.**
- *Lean harder on keys and follow-up flags.* The data shows both are
  unreliable.
- *Fix it in the rubric.* Rubric v5 added key-reuse examples, "score a
  follow-up by what is new" and "retellings 1–3". A dry run moved scores only
  about a point (the OpenAI retelling 7 → 6, the "train" tweak 6 → 5).
  Necessary, but not sufficient.
- *A digest-time judgment against what readers actually saw* (chosen): one
  Claude call per morning, against a 7-day history of shown stories.

**Fix.** `digest_state.story_history` and `checkRepeats` (see `DEC-010`):
- updates are cut to the items fetched since the story was shown, and ranked
  by those alone;
- candidates continuing the same story are merged;
- minor updates can't be top stories;
- if the call fails, the key rule applies over the 7-day history.

**Results & verification.** In the Oct 18–21 comparison:
- the OpenAI retelling is gone;
- the Disney items are one "Update:" story;
- Meta's tweak is one "Update:" line in Also notable;
- no section has more than 2 stories from one outlet;
- the Dev.to-only story no longer leads.

The MI5 explainer remains (see the open entry above). 140 digest tests.

---

## RESOLVED — Why-lines described the coverage instead of the news
**Phase:** steps 2–3 and tuning | **Severity:** Medium | **Status:** Resolved
**Date resolved:** 2026-10-21

**Symptom.** Readers saw lines such as "Large open-weight release from a major
lab; same story as the existing Meta Muse Spark Open entry", "Reported security
incident involving an OpenAI model; matches the existing OpenAI test-hacking
coverage", and "Warning from a major intelligence agency, though this is a
video explainer on a speech already covered".

**Diagnosis.** The editor writes each why-line with `<known_stories>` in its
prompt. When an item is a copy, it describes the item's relation to the other
items, not the news. The reader sees only the headline and this line.

**Solutions considered.**
- *Rubric rules.* `2026-10-16.3` added "never about the item", and v4 added bad
  and good examples. Both reduced the problem, but didn't end it.
- *Re-ask the model for a clean line.* Rejected: it adds a call per story for a
  cosmetic fix.
- *A deterministic guard* (chosen).

**Fix.** `supabase/functions/_shared/newsroom/why.ts`. The patterns were built
from all 1,465 stored why-lines of Oct 12–21 ("coverage", "already/widely …
covered", "existing … story/entry", "same … as the", "matches the", "follow-up
to", "explainer", "reported by", "duplicate", "known story", "another
outlet/angle", "recap", …). `chooseWhy` uses the lead's line if it passes,
else another item's, else no line. The digest logs every replacement, and the
MCP applies the same guard.

**Results & verification.** 80 of 1,465 stored lines trip the guard, 44 of
them at importance 4+ (listed in PR #10). The tests use real stored lines, and
the replays replaced or dropped lines on every day.

---

## RESOLVED — Discord URLs weren't clickable; escaping covered the whole message
**Phase:** digest (PR #9) | **Severity:** High | **Status:** Resolved
**Date resolved:** 2026-10-17

**Symptom.** The digest printed `host/path` lines without `https://`, which
Discord doesn't link. Raw source ids such as `[wired_ai]` appeared.

**Diagnosis.**
- The old `format.ts` shortened URLs.
- `escapeDiscordMarkup` escaped every line except those starting with
  `  → `. Masked links or bold headers would have needed more line-prefix
  exemptions, which couples the escaping to the layout.
- The digest's name map lacked several sources.

**Solutions considered.** Keep the whole-message escape with more exemptions:
fragile, since every new piece of our markup needs a rule. Rejected in favour
of escaping each field where it's inserted (`DEC-008`).

**Fix.**
- `escapeDiscord` per field: `\ * _ ~ ` | [ ] < >`, `://` → `\://`, and a word
  joiner after `@`, on a single line.
- Masked links `[headline](<https://…>)`, plus `flags: 4` (`SUPPRESS_EMBEDS`).
- `allowed_mentions: { parse: [] }` on every payload.
- One shared display-name map, tested against `sources.yaml`.
- Escaping `- # ( ) :` was tried first and dropped: those only act at a line
  start, and the extra backslashes risked showing.

**Results & verification.** Tests cover hostile titles (`[x](https://evil)`,
`@everyone`, `||spoiler||`, `**`, `<@123>`) and our markup surviving. The first
live digests rendered correctly.

---

## RESOLVED — Story keys cut by the context cap never reached later batches
**Phase:** AI editor (PR #8) | **Severity:** Medium | **Status:** Resolved
**Date resolved:** 2026-10-16

**Symptom.** Found by Codex review, not in production. With more than 250 known
keys, a key emitted again in an early batch was never offered to later
batches.

**Diagnosis.** `run.ts` built `knownKeys` from **all** historical keys, but the
prompt shows only `selectKnownStories(…, 250)`. A capped-out key counted as
"known", so it wasn't added to `namedThisRun`, and later batches saw it in
neither prompt section.

**Fix.** `knownKeys = new Set(knownAtStart.map((s) => s.key))`, plus a
regression test ("a known key cut by the context cap still reaches later
batches once named").

**Results & verification.** `test:editor` went to 69, and the next Codex review
was clean.

---

## RESOLVED — The preview failed before migration 004 was applied
**Phase:** AI editor (PR #8) | **Severity:** Medium | **Status:** Resolved
**Date resolved:** 2026-10-16

**Symptom.** `preview failed: news_items read failed: column news_items.editor_type does not exist`

**Diagnosis.** The owner applies the migration by hand at merge time, so the
preview's `--dry-run` (needed to tune the rubric *before* merging) read columns
that didn't exist yet.

**Fix.** On Postgres `42703` (`UNDEFINED_COLUMN`), `fetchWindow` remembers the
fact and re-reads with the base columns. Reads that filter on an editor column
throw `MissingEditorColumnsError` instead. The digest's `readWindow` and the
MCP's `fetchRows` later reused the same fallback, so a missing column degrades
to "unjudged" rather than an error.

**Results & verification.** The Oct 8 and Oct 13 dry runs completed before the
migration existed.

---

## RESOLVED — `temperature: 0` returns HTTP 400 on Claude Haiku 5.5
**Phase:** AI editor (PR #8) | **Severity:** Medium | **Status:** Resolved
**Date resolved:** 2026-10-16

**Symptom.** A probe returned:
```
400 {"type":"error","error":{"type":"invalid_request_error","message":"`temperature` is deprecated for this model."}}
```

**Diagnosis.** Haiku 5.5 accepts only the default sampling; any explicit
temperature other than 1 is rejected.

**Fix.** Temperature is left unset (`EDITOR_TEMPERATURE` exists for older
models). Consistency comes from structured outputs (`output_config.format`
JSON schema), the rubric, and effort `low`. See `DEC-002`.

**Results & verification.** Scores vary by about ±1 between runs
(Character.AI was 8 in one run, 7 in another). Since each item is judged once,
this only matters when re-judging.

---

## RESOLVED — Staged deletions slipped into the wrong commit
**Phase:** process (PRs #9 and #11) | **Severity:** Low | **Status:** Resolved
**Date resolved:** 2026-10-22

**Symptom.** `git rm src/digest/format.ts` (PR #9), and later
`git rm supabase/functions/mcp/_shared/slots.ts` (PR #11), ended up in an
earlier commit. That left the history broken at that point: PR #11's refactor
commit would have deleted a file that its own `handlers.ts` still imported.

**Diagnosis.** `git rm` stages the deletion immediately. A later selective
`git add <files> && git commit` commits everything already staged, not just
the named files.

**Fix.** Before pushing, `git reset --soft <base>`, unstage, and recommit with
the saved messages (`git commit -F`). Lesson: check `git status` for staged
deletions before a selective commit.

---

## RESOLVED — A full re-run of migration 003 failed on Supabase
**Phase:** scheduling / step 1 (PRs #5–#7) | **Severity:** Medium | **Status:** Resolved
**Date resolved:** 2026-10-14

**Symptom.** Re-running the whole of
`supabase/migrations/003_schedule_triggers.sql` (to apply PR #6's fixes)
stopped at the pg_cron setup, with "dependent privileges exist".

**Diagnosis.** Supabase's pg_cron access hook manages privileges on schema
`cron`. Once the extension exists, re-running `create extension pg_cron` and
its two `grant` statements trips the hook, and the file stops there, before
the functions and jobs.

**Solutions considered.**
- *Drop and recreate the extension.* Rejected: it would delete the jobs and
  their history.
- *Remove the grants.* Rejected: Supabase's install docs still list them for
  a first install.
- *Guard them* (chosen).

**Fix.** In PR #7 (`d79e453`), the extension creation and the two grants run
inside `do $$ … if not exists (select 1 from pg_extension where extname =
'pg_cron') …`, so only a first install runs them. `docs/scheduling.md` says to
apply later changes by running only the changed `create or replace function`,
or the one `cron.schedule(...)` call. Named jobs are overwritten, not
duplicated.

**Results & verification.** Tested in a local postgres:16 container: it
parses, does nothing when the extension exists, and attempts the install when
it doesn't. A whole-file re-run on Supabase itself hasn't been tried since.

---

## RESOLVED — Reddit answered 403 to every request from GitHub Actions
**Phase:** step 1 (PR #7) | **Severity:** Medium | **Status:** Resolved (sources disabled)
**Date resolved:** 2026-10-15

**Symptom.** All five Reddit sources (`reddit_claudeai`, `reddit_localllama`,
`reddit_machinelearning`, `reddit_openai`, `reddit_artificial`) logged
`HTTP 403: Blocked` on every Actions run (33 of 33 checked), and never stored a
row.

**Diagnosis.** Reddit refuses these unauthenticated JSON requests from GitHub's
runners. The response is a block (`403: Blocked`), not an error in the
collector. Reddit's supported route is its official API, with a registered app
and OAuth.

**Solutions considered.**
- *Another User-Agent.* Not enough for an IP-based block.
- *Proxy the requests.* Rejected: cost, and against Reddit's terms.
- *Reddit's official API* with a registered app and OAuth. The right path,
  but it needs credentials, so it's deferred.
- *Disable, and keep the collector* (chosen).

**Fix.** `enabled: false` on all five in `config/sources.yaml`, with the reason
in a comment. `src/collectors/reddit.ts` is kept for an official-API return.

**Results & verification.** No more 403 noise in collect runs. The README
roadmap and CLAUDE.md record the possible return. Reddit is a
community-reaction signal, not a headline source (`DEC-018`).

---

## RESOLVED — `npm run collect` sat for 4–10 minutes after "Done"
**Phase:** step 1 (PR #7) | **Severity:** High | **Status:** Resolved
**Date resolved:** 2026-10-15

**Symptom.** The collect job printed `Done` and then stayed alive for 4.5–10
minutes. 6 of 33 runs hit the job's 10-minute timeout, which also skipped the
90-day cleanup step.

**Diagnosis / root cause.** rss-parser 3.13's `parseURL()` never reads or
destroys the response on a redirect or a status ≥ 300, and never aborts on its
own timeout. The open TCP socket held the Node event loop until the server
dropped it. DeepMind (301, then 404), VentureBeat (429) and Google Research (a
redirect) hit that path on every run. Each of them alone kept the process
alive more than 200 s after the last `await`, with open `TCPSocketWrap`
handles.

**Solutions considered.**
- *`process.exit()` after Done.* Hides the leak, and could cut off an
  in-flight write.
- *Fix only the three feeds.* Any future bad feed would bring it back.
- *Own every HTTP response* (chosen).

**Fix.** Feeds are fetched with `fetch` and only parsed by rss-parser. All
collector HTTP goes through `src/utils/http.ts`, which reads or cancels every
response body, with a 20 s deadline per request and a 10 MB cap. An unref'd
15 s backstop after `Done` logs whatever is still open and exits.

**Results & verification.** Locally the process exits within 0.1 s of the last
`await`. The smoke test printed `Done in 20.3s` and ended that second, and the
backstop never fired. On Actions, collect runs now finish in about 1–2
minutes.

---

## RESOLVED — GitHub's scheduler delivered the digest hours late
**Phase:** scheduling (PRs #5, #6) | **Severity:** High | **Status:** Resolved
**Date resolved:** 2026-10-12

**Symptom.** `digest.yml` was scheduled for `45 15 * * *` (11:45 AM ET), but the
digest landed between 2:30 and 6:00 PM ET, and the delays were growing.
`collect.yml` (`0 */6 * * *`) drifted the same way.

**Diagnosis / root cause.** A scheduled run passes through two systems. The
scheduler *creates* the run, and the runner *executes* it. Runs were created
late; once created, a digest reached Discord in a minute or two. On free public
repos, GitHub's `schedule:` trigger is best-effort: under load it creates runs
late, sometimes by hours, or skips them.

**Solutions considered.** See `DEC-017`. In short:
- an earlier cron time (rejected: the delay was inconsistent);
- moving everything to Supabase Edge Functions (deferred: CPU limits, IPs,
  deploys);
- Supabase Cron dispatching `workflow_dispatch`, which skips the scheduler
  (chosen).

**Fix.** Migration 003 (`pg_cron` + `pg_net`, an hourly New York-hour gate,
the functions in a `private` schema, the secrets in Vault), with the
`schedule:` blocks commented out. PR #6 (from Codex review) made
`digest_hour_ny()` refuse hours 1 and 2, and limited log cleanup to the
`newsroom-*` jobs.

**Results & verification.** The test dispatch
(`select private.dispatch_workflow('collect.yml');`) returned 204, and the run
started within seconds. The digest has landed at 9:00 AM ET every day since. A
9:30 alarm posts to Discord if `digest_state.last_digest_at` wasn't refreshed.

