# The daily digest

Step 3 of the ranking rebuild. The digest posts to Discord at 9:00 AM New York
time, and is built from the AI editor's judgments ([`docs/editor.md`](editor.md)):
stories rather than items, ranked by importance, with a plain headline and a
line on why each matters. When the judgments are missing, it falls back to the
old ranking and says so in the footer.

## How a digest is made

```
Supabase Cron ─▶ digest.yml ─▶ editor job ──▶ digest job ─▶ npm run digest
                                 │               │
                                 │               ├─ items with fetched_at after digest_state.last_digest_at
                                 │               ├─ judged items grouped into stories (editor_story_key)
                                 │               ├─ sections, thresholds, no repeat of yesterday's top stories
                                 │               ├─ under 50% judged, or judgments unreadable: old ranking
                                 │               ├─ Discord: plain or embeds layout
                                 │               └─ digest_state: last_digest_at, last_digest_story_keys
                                 └─ npm run editor: judges anything still unjudged
```

- **The editor runs first.** `digest.yml` runs `npm run editor` as its own job
  before the digest, with the same auth as `collect.yml` (federation variables,
  falling back to the `ANTHROPIC_API_KEY` secret; `id-token: write` on that job
  only). It covers a late or failed 8:30 collect-and-editor run. The step and
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

Judged items are grouped by `editor_story_key` (`src/editor/select.ts`). For
each story:

- **Importance**: the highest importance among its items.
- **Outlets**: every item's source and its `metadata.coveredBy` sources, once
  each, by display name.
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

**Yesterday's top stories don't come back.** The digest stores the story keys it
showed in `digest_state` (`last_digest_story_keys`, JSON by section). A story
whose key was in the previous Top stories is left out, unless one of its newer
items is a follow-up (`editor_followup`). Then it can appear again, represented
by its follow-up items.

## Sections

| Section | Shows | Rule (default) |
|---|---|---|
| **Top stories** | Up to 5: linked headline, why-line, outlets | `general` stories at importance 6+, by importance then outlet count. `builder` stories join only at 7+, and only when general ones run short |
| **Also notable** | Up to 5, one linked line each | the next `general` stories at 4+ |
| **For builders** | Up to 3, one linked line each | `builder` stories at 4+ not already shown |
| **Paper of note** | 0 or 1 | a `research` story (or an arXiv / HF Papers one) at 6+. Usually empty: the rubric expects one or two a week |

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
| `DIGEST_MIN_JUDGED_SHARE` | 0.5: fall back below half judged |

## Fallback

When less than `DIGEST_MIN_JUDGED_SHARE` of the window is judged, or the editor
columns can't be read, the digest:
- uses the old ranking (`buildSlottedDisplay`, unchanged, over the 500
  highest-scored items, as before);
- logs a warning (a GitHub annotation on Actions);
- prints the fallback footer.

The links are the same safe masked links as in the editor digest. The optional
AI summary (Haiku 4.5, only if `ANTHROPIC_API_KEY` is set for the digest job,
which `digest.yml` doesn't do) is used only here.

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
```

The preview builds the digest for the 9:00 AM ET window ending on that date,
from stored judgments, and prints what would be sent. It reads with
`SUPABASE_ANON_KEY` and **never sends and never writes `digest_state`**.

Two differences from the real run, both because the anon key can't read
`digest_state`:
- It uses the nominal window (9:00 the day before to 9:00 that day).
- It replays the three mornings before the date (`PREVIEW_LOOKBACK_DAYS`),
  oldest first, each with the morning before it as its repeat state, to work
  out which stories led the day before. A story in the news for longer than
  that may be treated differently than the real chain of digests did.

`npm run digest -- --dry-run` builds the real next digest (from
`last_digest_at` to now) and prints it without sending. It needs the service
key.

**Never trigger an extra real digest to test.** A real send moves
`last_digest_at`, which shrinks the next morning's window.

## Files

| File | What it does |
|---|---|
| `src/digest/generate.ts` | `npm run digest`: CLI, adapters, the fallback's AI summary |
| `src/digest/run.ts` | One run: window, build, deliver, record. Preview and dry run never deliver or record |
| `src/digest/build.ts` | Window items to the digest document: editor sections, fallback, footer |
| `src/digest/render.ts` | Discord (plain, embeds) and plain-text renderings; escaping; limits |
| `src/digest/store.ts` | Supabase reads and the `digest_state` write |
| `src/digest/config.ts` | Adapter credentials; layout and thresholds from the environment |
| `src/editor/select.ts` | Stories, representative item, ranking, sections (shared with `preview:editor`) |
| `src/utils/source-names.ts` | Display names for every source; dependency-free so the MCP can adopt it in step 4 |
| `src/digest/digest.test.ts` | `npm run test:digest`, in CI |
