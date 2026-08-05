# Session — 2026-08-04: the two missing MCP tools, and what reviewing them found

## Why this session happened

A resume claimed AI Newsroom exposed **35 sources and 8 MCP tools**. The README said
"22+ sources" and listed 6 tools. The task was to establish which was true, and make the
codebase match the claim if it wasn't.

## The audit result

| Claim | Resume | README (before) | Code (before) |
|---|---|---|---|
| Sources | 35 | "22+" | **35 defined**, 34 enabled |
| MCP tools | 8 | 6 | **6 implemented** |

Sources were already correct — the README was simply stale. Tools were not.

The "8" was not invented. `CLAUDE.md` had documented 8 tools since the project's design,
including `get_repo_quickstart` and `get_paper_brief`, but the Edge Function only ever
implemented 6. Whoever wrote the resume line read the design doc rather than `index.ts`.

**Root cause:** a design document and its implementation drifted with nothing asserting
they agreed. The same root cause produced three other defects found later this session
(see *Drift*, below).

## What was built

Two tools, in `supabase/functions/mcp/_shared/external.ts`. Unlike the six existing tools
— which read the `news_items` Postgres cache — these resolve a single identifier live, so
they work for anything the user names rather than only what a collector happened to pick up.

- `get_repo_quickstart` — GitHub metadata plus the install/usage section extracted from a
  repo's README
- `get_paper_brief` — ArXiv title, authors, abstract, categories, links

Both accept loose input (bare ID, `arXiv:` prefix, full URL, `owner/name`, github.com URL)
and fail with actionable messages.

## Review: three tiers, then a backend switch

Tiers 1–2 (structural, deep logic) plus a Tier 3 independent-model pass.

### The defect that mattered most

`extractQuickstart` treated `#` shell comments inside fenced code blocks as Markdown
headings. Since a quickstart is mostly `# install the thing` comments, the section was cut
at the opening fence. Measured across 8 real repositories, **3 returned an unterminated
code fence containing zero install commands** — the tool's entire purpose failing, on the
most popular repos anyone would try first.

| Repo | Before | After |
|---|---|---|
| `openai/codex` | 913 chars, fences unbalanced | 2283, balanced |
| `modelcontextprotocol/servers` | 505, unbalanced | 2232, balanced |
| `ggml-org/llama.cpp` | 400, unbalanced | 1201, balanced |

**Why the original tests missed it:** they asserted on the heading and the section length.
Length looked plausible precisely *because* truncation happened partway through. Assertions
now check content — balanced fences, presence of commands after the first comment.

### Tier 3 backend: opus → codex

Tier 3 ran on the `opus` backend first. All five reviewer agents produced real work — they
downloaded READMEs, built a mutation battery, ran an edge-case probe — but **none returned
a report**. Three retrieval attempts, the last asking only for the single word `NONE`, all
came back empty. That is the sixth consecutive round with this failure mode. Findings were
recovered by reading their scratchpad artifacts directly.

The owner then corrected the record: the original 2026-07-26 switch *to* opus had been
driven by **Codex tokens running low**, not by a judgement that opus reviewed better.
`active.conf` had recorded it as a deliberate quality decision, which would have misled the
next reader. With the Codex plan upgraded, the backend was switched to `codex`
(`gpt-5.6-sol`, `xhigh`).

**Codex delivered on the first real attempt and found substantially more.**

### What Codex found that earlier tiers had not

Two CRITICALs, both availability defects on a public unauthenticated endpoint:

1. **ReDoS in heading parsing.** `# Quickstart` + 16k spaces took ~2.3s — past the Edge
   Function CPU budget — and any caller could host such a README. Confirmed by measurement:
   2310ms at 16k, 9238ms at 32k, exactly 4x per doubling. Now 8.5ms and 0.9ms.
2. **The 200k cap did not bound memory.** `res.text()` decoded the whole body before the
   slice applied. GitHub serves files up to 100MB into a 256MB shared isolate.

And two real bugs in the **already-deployed** six tools, confirmed against live data:

3. **`showAll` was capped at 500 rows** while 7,111 were cached — **93% of the data
   unreachable** via the one option that promises to show everything.
4. **`search` ignored `since` in its summary fallback** — 19 rows older than a 24h bound
   would come back.

### The Codex loop, and where it stopped

Eight rounds, stopped at diminishing returns with the remainder handed to the GitHub PR
review loop. Every finding was verified or reproduced before being fixed.

Round 1 found the two CRITICALs. Rounds 2–3 found defects in the round-1 fixes. Round 4
found that the *schema documentation was wrong*, which invalidated two fixes. Round 7 found
three pre-existing user-visible bugs. Round 8 was the first round whose findings shared one
narrow root cause with no new defect class — the stopping signal.

### The measurement that mattered more than any finding

A round-6 fix replaced pagination with a single query, on the reasoning that one statement
runs in one MVCC snapshot and is therefore consistent by construction. It was correct
reasoning and the wrong answer.

Run against the live database, it returned **1,000 of 7,112 rows**: PostgREST enforces
`db-max-rows` server-side regardless of the `.limit()` requested. The "more correct" design
would have shipped an 86% data loss — and because the *rows it did return* were perfectly
consistent, every later review round would have kept validating a mostly-empty answer.

The lesson is narrow and worth keeping: a design argument about consistency says nothing
about whether the data arrives. Check the output against the real system.

## Drift — the recurring theme

Four separate defects, one shape: **a copy of something, with nothing asserting the copy
still matched.**

| Copy | Source of truth | How far it had drifted |
|---|---|---|
| `CLAUDE.md` tool table | `index.ts` routing | 8 documented vs 6 implemented |
| `CLAUDE.md` schema block | `001_create_news_items.sql` | wrong uniqueness, missing column, nullability unmarked |
| `test.ts` inline `NAMES` | `slots.ts` `SOURCE_NAMES` | 23 vs 35 entries |
| `test.ts` tool list | `tools.ts` `TOOLS` | 6 vs 8 |
| `tools.ts` schema defaults | `slots.ts` defaults | 15/5/3/2 vs 10/8/6/4 |

The schema copy was the expensive one. It claimed `url TEXT NOT NULL UNIQUE`; the migration
declares a unique index on `(url, source)`. Two fixes were written against that wrong model
and had to be redone — and the consequence was silent, since deduplicating by `url` drops
rows without erroring. **54 rows in the live cache share a URL with a row from a different
source.**

`test.ts` now imports the real modules instead of copying them — both are dependency-free,
so the duplication was never necessary. The schema defaults were corrected to match
execution, since the schema is what clients plan against.

## Test coverage: from zero to load-bearing

`tsconfig.json` excludes `supabase/`, so **no CI check ran against any of this code**. A
mutation battery confirmed it: every fix could be reverted and nothing would notice.

`npm run test:mcp` now runs 85 assertions with no network or credentials required. Each
corresponds to a defect that actually shipped. The suite was itself mutation-tested — every
mutant is killed, including the two regressions introduced *during* the review.

## Regressions introduced while fixing, and caught

Recorded because they are the honest part of the record:

1. **A lone-surrogate guard destroyed valid surrogate pairs.** `&#xD83D;&#xDE00;` decoded
   correctly to an emoji before the fix and to an empty string after. Some feeds encode
   astral characters as their two UTF-16 halves; rejecting surrogates during decoding
   discarded each half before they could combine. The repair pass now runs last.
2. **A tag scanner recursed past each prefix collision and overflowed the stack.**
   `<summary_detail>` is 16 chars, so a 200k body admits ~12.5k collisions against a ~10k
   frame limit — reachable inside the cap. Now iterative.

Both are the late-cycle signature the review process predicts: once the original code is
clean, the remaining findings are defects in the fixes.

## The GitHub Codex review loop

After the local rounds, the change went through GitHub's Codex reviewer on PR #3
(opened against a base branch pinned at the pre-merge commit, since the code was
already on `main`; closed rather than merged afterwards).

**4 rounds, 7 findings, zero false positives from Codex.**

| Round | Finding | |
|---|---|---|
| 1 | README truncation flag discarded — partial install steps shown as complete | P2 |
| 1 | arXiv URLs with `?query` rejected though the schema promises they work | P3 |
| 2 | Schema warning trapped inside a code fence, so it never rendered | P3 |
| 3 | Fence left open on the README-cap path | P3 |
| 3 | Literal NUL byte in `handlers.ts` | P3 |
| 4 | Truncation marker rendered inside the code block, copyable as a command | P2 |
| 4 | Category parsing rescanned from each malformed fragment (~1.6s on 190k) | P3 |

The findings were a different *class* from the local rounds: those probed
internal correctness, while these were about the boundary where a real user's
input meets the tool — a link someone pastes, output someone reads.

**One false positive, and it was mine.** I dismissed the NUL-byte finding after
"verifying" with three tools that all share the same blind spot: `grep -P` cannot
match a NUL (it uses NUL-terminated strings internally), `sed` printed the byte
invisibly, and a plain `rg` count did not reveal binary treatment. A byte-level
read found it instantly. Confident agreement between tools that fail the same way
is not evidence. Retracted on the PR and fixed.

Round 4 also caught the same ordering bug twice: `…(truncated)` was appended
before the fence was closed. Round 3 fixed one branch; the sibling branch kept
the defect. Fixing one instance of a bug without checking its twin is its own
failure mode.

Operationally: a round can return *"Codex Review: Something went wrong"* and needs
re-triggering, and every round after the first requires an explicit
`@codex review` — pushes do not trigger it. Silence means nothing was triggered,
not that nothing was found.

## CI and branch protection

Neither existed. `tsconfig.json` excludes `supabase/`, so **nothing ran the test
suite automatically** — the 123 assertions added during this work would have run
only when someone remembered to.

`ci.yml` now runs on every PR and push to `main`: typecheck, the suite, a
NUL-byte scan, and a docs-match-code check asserting every tool is declared,
routed and documented with the README counts matching config. That last check
exists because documentation drifting from code was this session's root cause.

`main` is protected by a GitHub **ruleset** — requiring a PR and a green
`typecheck + tests`, blocking deletion and force-pushes, with **no bypass
actors**. Rulesets are the newer system; Settings → Branches (classic protection)
stays empty by design.

The obstacle was the heartbeat, which pushed straight to `main` to keep scheduled
workflows alive — and if those get disabled, the collectors stop. Neither obvious
fix works: required status checks reject a freshly pushed commit because its
checks have not run, and on a user-owned repo the GitHub Actions app **cannot** be
a bypass actor (*"must be part of the ruleset source or owner organization"* —
org-only). Rather than weaken the rule, the heartbeat moved to its own branch:
the 60-day rule counts repository activity, not default-branch activity. `main`
needs no exception, so there is no hole in it.

Verified both directions rather than assumed: a real push to `main` was rejected
with `GH013`, and the heartbeat ran successfully afterwards.

## Operational notes

- **The tool list comes from the deployed Edge Function, not the repo.** The live endpoint
  served 6 tools throughout this session. `npx supabase functions deploy mcp` is required;
  it is not automated — there is no deploy workflow.
- **Deploying also fixes display names.** `SOURCE_NAMES` covered 24 of 35 sources, so 11
  rendered as raw IDs (`techcrunch_ai`). That affects the six existing tools too.
- **Set `GITHUB_TOKEN` on the Edge Function** to lift `get_repo_quickstart` from 60 to
  5,000 GitHub calls/hour. The limit is per-IP and shared across all callers.

## Files

| File | Change |
|---|---|
| `supabase/functions/mcp/_shared/external.ts` | new — both live-lookup tools |
| `supabase/functions/mcp/external.test.ts` | new — 85-assertion regression suite |
| `supabase/functions/mcp/_shared/tools.ts` | +2 tool declarations; defaults corrected |
| `supabase/functions/mcp/index.ts` | routing; lazy Supabase client; `-32602` mapping |
| `supabase/functions/mcp/_shared/handlers.ts` | `search` since-bound; `showAll` pagination |
| `supabase/functions/mcp/_shared/slots.ts` | 11 source names; release cap; limit clamping |
| `supabase/functions/mcp/test.ts` | imports real modules instead of copies |
| `README.md`, `CLAUDE.md`, `package.json` | 35 sources, 8 tools, troubleshooting |
| `CHANGELOG.md` | new |
| `reviews/review-2026-08-04-932c993.md` | full review record |
