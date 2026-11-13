# The daily digest

Step 3 of the ranking rebuild. The digest posts to Discord at 9:00 AM New York
time, and is built from the AI editor's judgments ([`docs/editor.md`](editor.md)):
stories rather than items, ranked by importance, with a plain headline and a
line on why each matters. Like a daily newspaper, it doesn't reprint
yesterday's front page, but runs an update when a story develops. When the
judgments are missing, it falls back to the old ranking and says so in the
footer.

## How a digest is made

```
Supabase Cron ─▶ digest.yml ─▶ editor job ──▶ digest job ─▶ npm run digest
                                 │               │
                                 │               ├─ items with fetched_at after digest_state.last_digest_at
                                 │               ├─ judged items grouped into stories (editor_story_key)
                                 │               ├─ repeat check: one Claude call against the 7-day history
                                 │               │    (new / update / repeat); key rule if it fails
                                 │               ├─ sections: thresholds, weak-source rule, 2 per outlet
                                 │               ├─ why-lines that describe coverage replaced or dropped
                                 │               ├─ under 50% judged, or judgments unreadable: old ranking
                                 │               ├─ Discord: plain or embeds layout
                                 │               └─ digest_state: last_digest_at, story_history,
                                 │                    last_digest_story_keys
                                 └─ npm run editor: judges anything still unjudged
```

- **The editor runs first.** `digest.yml` runs `npm run editor` as its own job
  before the digest, with the same auth as `collect.yml` (workload identity
  federation, live since Nov 13, 2026; [`docs/editor.md`](editor.md#authentication)).
  It covers a late or failed 8:30 collect-and-editor run. The step and
  the job are allowed to fail, and the digest job runs whatever happened
  (`if: !cancelled()`).
- **No `editor` concurrency group on that job.** A run waiting in the group
  would hold up the 9:00 digest, and a newer queued run would cancel it. Two
  editors overlapping is safe: a judgment is only written while the row is
  still unjudged.
- **Window.** As before: every item with `fetched_at` after
  `digest_state.last_digest_at`, up to the start of the run, paged past
  PostgREST's 1,000-row cap.

## Stories

Judged items are grouped by `editor_story_key` (`supabase/functions/_shared/newsroom/stories.ts`, shared with the MCP server, [`docs/mcp.md`](mcp.md)). For
each story:

- **Importance**: the highest importance among its items.
- **Outlets**: every item's source and its `metadata.coveredBy` sources, once
  each, by display name. A Hacker News link to an article names the
  publisher, not HN (see [Outlets](#outlets)).
- **Headline, why-line and link**: from the representative item, chosen in this
  order:
  1. an official lab source;
  2. a wire service (Reuters, AP, the FT, Bloomberg), also when linked from
     Hacker News: an HN item's URL is the article, so that's the link;
  3. tier-1/2 press (`industry_news` sources with `sourceTier` 1 or 2);
  4. anything else.

  Ties go to the higher-rated item, then the earliest published.

  **One guard:** only items judged as the story's main event can represent it,
  meaning importance within one point of the story's best and the story's
  audience (`general` if any such item is). Without it, NVIDIA's "run Muse
  Spark Open on GB300" post, an official lab post rated as a builder item,
  would have headlined the general story of Meta's launch on Oct 16.

## Repeats and updates

The owner's rule: the digest is a daily newspaper. Importance is absolute, so
leaving out a repeat never pulls a weaker story up: a slow day shows fewer
stories, as the thresholds already make it do.

| Case | Example (Oct 17–21, 2026) | What happens |
|---|---|---|
| **Same event, retold** | "OpenAI model reportedly hacked a government website during testing", two days after the OpenAI test-hacking story | Never shown again |
| **A genuine new development** | "Disney agrees to hire most of Character.AI's workforce", after the bankruptcy | Shown once, headline prefixed **"Update: "**, ranked by the new development alone |
| **A small tweak** | "Meta removes the word train from its commercial terms", a day after Meta dropped the scraping language | At most one line in Also notable, if the new item is rated 4+; never a top story |

**One story is never shown twice in one digest**: stories the check or the
keys find to be the same are merged before sectioning.

### History

`digest_state.story_history` (JSON) holds every story shown in the last 7 days,
in any section:
- its key, and every key it covered;
- its representative headline;
- the section;
- the New York date it was shown;
- the newest `fetched_at` among its items then.

It is written with `last_digest_at` after each sent digest and pruned to 7
days. A fallback or empty day keeps it as it was. No migration: it is a row in
`digest_state`.

**Production history starts empty and fills day by day.** The first digest
after this change has only the previous digest's keys, from step 3's
`last_digest_story_keys` (with the key as headline). From then on, each
morning adds its own stories. `last_digest_story_keys` is still written, so a
rollback to step 3 works.

### The repeat check

Story keys drift: the editor sometimes gives a continuing story a new key, and
occasionally gives a new story an old one. So before sectioning, **one Claude
call** (`src/digest/repeats.ts`) reads the candidates (stories rated high
enough for any section) and the history's headlines, and classifies each
candidate:
- `new`: unrelated to anything shown;
- `update`: the same story with a genuinely new fact, a short phrase naming
  it, the history entry it continues, and whether it is minor (a tweak);
- `repeat`: the same event retold, a recap, an explainer, or an opinion on it.

The model is the editor's (`EDITOR_MODEL`, Haiku 5.5) at effort `medium`
(`DIGEST_REPEAT_EFFORT`), with structured outputs, a 12,000-token output cap,
and at most 40 candidates and 150 history lines. It has the same auth as the
editor, and the same injection rules: headlines are JSON strings in tags with
`<` escaped, no tools. A day's check costs about $0.002, and the step summary
logs its tokens.

**What the digest does with the answer:**
- `repeat`: dropped.
- `update`: cut down to the items fetched after the history entry. Its
  importance is the max of those new items only, never the original story's,
  and its representative comes from them. Nothing fetched since means it's
  dropped. Minor updates can't be top stories.
- `new`: as before. A story whose key was already shown is still cut to its
  new items.

**Checks on the model's links**, because Haiku does sometimes point at the
wrong line:
- It copies the history headline it means, and that is matched before the line
  number. A line number one or two off is corrected to a neighbour about the
  same company.
- A link only counts if one side's subject (the first name in its headline) is
  named in the other: "Disney agrees to hire Character.AI's staff" can continue
  "Character.AI files for bankruptcy"; "Google releases a PyTorch tool" can't
  continue "Amazon launches a PyTorch tool". Outlet names don't count as
  subjects.
- Key matches get the same check: the editor gave Google's tool Amazon's key.
- A repeat or update of nothing related is treated as new: the reader hasn't
  seen it. Two candidates are merged only if they pass the same check.

**If the call fails** (no credentials, an API error, output cut off, no usable
verdicts), the **key rule** applies: a story whose key is in the history is
left out unless an item fetched since it was shown is a follow-up
(`editor_followup`); then it is an update of those items. The digest sends
either way, and the run gets a warning annotation.

## Sections

| Section | Shows | Rule (default) |
|---|---|---|
| **Top stories** | Up to 5: linked headline, why-line, outlets | `general` stories at importance 6+, by importance then outlet count, from a strong source (below). `builder` stories join only at 7+, and only when general ones run short. No minor updates |
| **Also notable** | Up to 5, one linked line each | the next `general` stories at 4+ |
| **For builders** | Up to 3, one linked line each | `builder` stories at 4+ not already shown |
| **Paper of note** | 0 or 1 | a `research` story (or an arXiv / HF Papers one) at 6+. Usually empty: the rubric expects one or two a week |

**Weak sources don't lead.** A story can be a top story only if at least one
copy (an item, or one in its `coveredBy`) is from an official lab, a wire
service, the tier-1/2 press, or an HN link to a known publisher (below). On
Oct 18 the #1 story, "OpenAI discloses four June agent incidents", was backed
by a single Dev.to post. The exception is a story rated 8 or higher
(`DIGEST_TOP_WEAK_SOURCE_MIN_IMPORTANCE`). Otherwise it is considered for Also
notable.

**Variety.** Each section shows at most 2 stories with the same lead outlet
(`DIGEST_MAX_PER_OUTLET`). "Reuters (via HN)" counts as Reuters. A story over
the cap falls to the next section it qualifies for, or is left out. Nothing is
padded in. On Oct 17, Also notable carried three Anthropic posts.

Each story appears in one section at most. arXiv and HF Papers items appear
only as the paper of note, unless a lab or the press covered the same story:
then that coverage leads it, and it competes for Top stories as news. A quiet day shows fewer stories, never filler. When
nothing qualifies for Top stories, it says so in one line ("No top stories
today."). Empty sections are left out.

**Footer:**
- `Ranked by the AI editor · N items reviewed`, where N is the judged items in
  the window;
- `(+N items not yet rated)` when some are still unjudged. Those are left out
  of the sections;
- `AI editor unavailable today — basic ranking` in the fallback.

### Thresholds

All optional. Set them as repository variables (Settings → Secrets and
variables → Actions → Variables) or in `.env`. A bad value logs a warning and
keeps the default. It never stops the digest.

| Variable | Default |
|---|---|
| `DIGEST_TOP_LIMIT` / `DIGEST_TOP_MIN_IMPORTANCE` | 5 / 6 |
| `DIGEST_TOP_BUILDER_MIN_IMPORTANCE` | 7 |
| `DIGEST_NOTABLE_LIMIT` / `DIGEST_NOTABLE_MIN_IMPORTANCE` | 5 / 4 |
| `DIGEST_BUILDERS_LIMIT` / `DIGEST_BUILDERS_MIN_IMPORTANCE` | 3 / 4 |
| `DIGEST_PAPER_LIMIT` / `DIGEST_PAPER_MIN_IMPORTANCE` | 1 / 6 |
| `DIGEST_TOP_WEAK_SOURCE_MIN_IMPORTANCE` | 8 (11 turns the exception off) |
| `DIGEST_MAX_PER_OUTLET` | 2 |
| `DIGEST_MIN_JUDGED_SHARE` | 0.5: fall back below half judged |
| `DIGEST_REPEAT_EFFORT` | `medium` (`low`, `medium`, `high`) |

## Outlets

A Hacker News item's URL is the article itself, so a story linked from HN
names its publisher, from the link's domain: "Reuters (via HN)", "The
Guardian (via HN)".
- The map of domains is `PUBLISHERS` in `supabase/functions/_shared/newsroom/source-names.ts`: Reuters,
  AP, the FT, Bloomberg, the Guardian, the NYT, the WSJ, the BBC, the
  Washington Post, CNBC, Business Insider, The Information, Axios, Politico,
  404 Media, The Register, The Verge, Ars Technica, WIRED, TechCrunch, MIT
  Technology Review, Scientific American and a few more.
- A link to a lab's own site names the lab, from `LAB_PUBLISHERS` in the same
  file: "OpenAI (via HN)", "Google DeepMind (via HN)". Where the lab has a
  direct source, the name is that source's, so `blog.google` is "Google AI"
  and `about.fb.com` is "Meta AI". Labs without a direct source include
  Mistral, Cohere, Microsoft AI, Apple, Amazon and Tencent (`DEC-021`).
- An unknown domain shows bare: "quantamagazine.org (via HN)".
- HN text posts stay "Hacker News", and Show HN projects stay "Show HN".
- A publisher or lab that also carried the story directly (The Verge's feed
  and The Verge via HN; OpenAI's news and openai.com via HN) is listed once.
- A lab's site via HN only changes how the outlet is named. The ranking
  (`rankingOutlet`) counts it as before:
  - not a strong source, for the weak-source rule;
  - as its own domain, for the per-outlet cap;
  - as a second outlet, for the "most widely carried" tiebreak.

  Whether it should count as the lab is an open owner decision (`DEC-021`).

## Why-lines that describe coverage

The rubric forbids them, but the editor still writes some ("…matches the
existing OpenAI test-hacking coverage", "…a video explainer on a speech
already covered"). `supabase/functions/_shared/newsroom/why.ts` checks each shown story's why-line
against patterns taken from the stored why-lines of Oct 12–21:
- "coverage";
- "already/widely/elsewhere … covered";
- "existing … story/entry/item";
- "same … as the";
- "matches the";
- "follow-up to";
- "continues/follows the earlier";
- "explainer";
- "reported by";
- "duplicate";
- "known story";
- "another outlet/angle";
- "recap";
- "this item/article".

When one trips, the digest uses another item's why-line from the same story
that passes. If none passes, it shows the headline alone. Either way it is
logged. Of 1,465 stored why-lines, 80 trip it, 44 of them at importance 4+.

## Fallback

When less than `DIGEST_MIN_JUDGED_SHARE` of the window is judged, or the editor
columns can't be read, the digest:
- uses the old ranking (`buildSlottedDisplay`, unchanged, over the 500
  highest-scored items, as before);
- logs a warning (a GitHub annotation on Actions);
- prints the fallback footer.

The links are the same safe masked links as in the editor digest.

The fallback alone has an optional AI summary: two or three sentences above
the sections, from the window's 30 highest-scored titles, the pool the old
ranking slots from (`src/digest/summary.ts`).
- **The editor's client and model.** `createAnthropicClient` (federation on
  Actions, then `ANTHROPIC_API_KEY`, then none) and `EDITOR_MODEL`
  (`claude-haiku-5-5`). The digest job already has `id-token: write` and the
  federation variables, for the repeat check.
- **Small:** effort `low` and a 1,024-token cap. Adaptive thinking counts
  against the cap, so it isn't 200 as before. Then a 30-second timeout and one
  retry.
- **Titles are data.** As in the editor and the repeat check, the instruction
  is the system prompt and says so, and each title is a JSON string inside
  `<items>` with `<` escaped, so a crafted title can't steer the summary.
- **At most 800 characters.** The intro goes into the first Discord message
  whole, and escaping can double it, so a longer answer is left out rather
  than break the send.
- **Never blocks the digest.** An error, a cut-off answer, a refusal or an
  empty one leaves the summary out, with a warning (an annotation on Actions).
  Without credentials there is no summary.

Until PR #13 it called Haiku 4.5 over raw `fetch` with `ANTHROPIC_API_KEY`
only, so once that secret was deleted it was left out without a word.

The editor digest can't fail on the editor's account: if the editor job
failed, the window is mostly unjudged and the fallback applies.

## Layouts: `DIGEST_LAYOUT`

Two Discord layouts. The default is `plain`.

- **`plain`**: a regular message.
  - Bold section headers and numbered Top stories, each a masked-link headline,
    an indented why-line and an outlets line.
  - Then one-line lists.
  - The footer is Discord subtext.
  - With every URL in full, a typical day is two messages of about
    1,700–1,800 characters each, split between sections.
- **`embeds`**: one webhook message, with the date as its text and an embed per
  section (the section name is the embed title).
  - Each story is a masked link plus why-line in the embed description.
  - The ranking line is the last embed's footer.
  - A typical day fits one message (about 3,000 of Discord's 6,000 characters).

To switch, set the repository variable **`DIGEST_LAYOUT`** to `embeds`
(Settings → Secrets and variables → Actions → Variables → New repository
variable). Delete it, or set it to `plain`, to switch back. The next morning's
digest uses it, and `.env` works the same way locally.

### Links and safety

- **Clickable links without preview cards.** Discord links are masked,
  `[Headline](<https://…>)`. The angle brackets stop preview cards. Plain
  messages also set Discord's `SUPPRESS_EMBEDS` flag. Embeds never preview links.
- **Feed text is escaped field by field**, where it is inserted (`escapeDiscord`
  in `src/digest/render.ts`): headlines, why-lines, outlet names and the
  fallback's summary.
  - A title can't create links (`[`, `]`, `://`), spoilers, emphasis, code or
    `<…>` mentions and timestamps.
  - A word joiner after `@` defuses `@everyone`.
  - Our own bold headers, masked links and subtext are added around the
    escaped text, so they stay intact.
  - URLs are linked only if they are http(s), with `( ) < >` and spaces
    percent-encoded.
- **Never mentions.** Every payload sets `allowed_mentions: { parse: [] }`.
- **Never splits a story.** Messages are packed whole stories at a time: 2,000
  characters per plain message; 4,096 per embed description, 6,000 and 10
  embeds per message.

**Slack, Telegram and iMessage** get a plain-text rendering, with each full
`https://` URL on its own line. They keep their own safety handling: Slack sends
with `mrkdwn: false` and escapes `& < >`; Telegram sends plain text with a word
joiner after `@`. They split at blank lines, which never fall inside a story.

## Previewing

```bash
npm run digest -- --preview --date 2026-10-16                  # plain layout (or DIGEST_LAYOUT)
npm run digest -- --preview --date 2026-10-16 --layout embeds  # the embeds payload, as JSON
npm run digest -- --preview --date 2026-10-16 --text           # plus the Slack/Telegram text
npm run digest -- --preview --date 2026-10-16 --history        # plus the 7-day history it checked against
npm run digest -- --preview --date 2026-10-16 --no-repeat-check  # the key rule, no repeat-check calls (see below)
```

The preview builds the digest for the 9:00 AM ET window ending on that date,
from stored judgments, and prints what would be sent. It reads with
`SUPABASE_ANON_KEY` and **never sends and never writes `digest_state`**.

Two differences from the real run, both because the anon key can't read
`digest_state`:
- It uses the nominal window (9:00 the day before to 9:00 that day).
- It replays the 7 mornings before the date, oldest first, to rebuild the
  story history, running the repeat check on each in memory with the local
  `ANTHROPIC_API_KEY` (about $0.015 for the eight calls). With
  `--no-repeat-check`, or without a key, every morning uses the key rule. The
  old per-machine keys expired; put a fresh one in `.env` for model-backed
  previews ([`docs/editor.md`](editor.md#local-machines)).

  A replayed morning that falls back to the old ranking (before Oct 10, 2026,
  when nothing was judged yet) also asks for the fallback summary with that
  key, even with `--no-repeat-check`. That's a fraction of a cent, and it's
  never printed.

  The replayed history is what the new digest would have shown, not what was
  actually sent. The model's answers vary a little between runs.

`npm run digest -- --dry-run` builds the real next digest (from
`last_digest_at` to now) and prints it without sending. It needs the service
key.

**Never trigger an extra real digest to test.** A real send moves
`last_digest_at`, which shrinks the next morning's window.

## Files

| File | What it does |
|---|---|
| `src/digest/generate.ts` | `npm run digest`: CLI, adapters, credentials for the repeat check and the summary |
| `src/digest/summary.ts` | The fallback's optional AI summary, with the editor's client and model |
| `src/digest/run.ts` | One run: window, build, deliver, record. Preview and dry run never deliver or record |
| `src/digest/build.ts` | Window items to the digest document: editor sections, fallback, footer, "Update:" label |
| `src/digest/repeats.ts` | Story history, the repeat check, the key rule, merging and cutting updates |
| `supabase/functions/_shared/newsroom/why.ts` | The why-line guard (shared with the MCP server) |
| `src/digest/render.ts` | Discord (plain, embeds) and plain-text renderings; escaping; limits |
| `src/digest/store.ts` | Supabase reads and the `digest_state` write |
| `src/digest/config.ts` | Adapter credentials; layout and thresholds from the environment |
| `supabase/functions/_shared/newsroom/stories.ts` | Stories, representative item, ranking, sections; shared with the MCP server and `preview:editor` (Node imports it via `src/editor/select.ts`) |
| `supabase/functions/_shared/newsroom/source-names.ts` | Display names for every source, publishers and labs by domain, source classes; shared with the MCP server |
| `src/digest/digest.test.ts` | `npm run test:digest`, in CI |
