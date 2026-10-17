/**
 * Preview: what the old digest picked for a window, next to what the AI
 * editor would pick. Read-only: nothing is written and nothing is sent.
 *
 * Usage:
 *   npm run preview:editor -- --date 2026-10-08              # stored judgments
 *   npm run preview:editor -- --date 2026-10-08 --dry-run    # judge in memory now
 *   npm run preview:editor -- --window 2026-10-07T13:00Z,2026-10-08T13:00Z
 *   … --all                                                   # also list every judgment
 *
 * Reads with SUPABASE_ANON_KEY (public read). --dry-run calls the Claude API
 * with the local ANTHROPIC_API_KEY, using the current config/editor-rubric.md,
 * so it is the way to try a rubric change before it judges anything for real.
 *
 * The old digest is replayed with buildSlottedDisplay unchanged, its clock set
 * to the end of the window. It sees the scores stored now, which later collect
 * runs may have rewritten, so it approximates what was actually sent.
 */

import 'dotenv/config';
import { buildSlottedDisplay, formatSlottedDisplayAsText } from '../utils/slots.js';
import { digestSlotOptions } from '../digest/slot-options.js';
import { apiJudgeCall, authMode, AUTH_DESCRIPTIONS, createAnthropicClient, estimateCostUsd } from './client.js';
import { editorCaps, modelSettings } from './config.js';
import {
  fetchItems, fetchKnownStories, loadSources, MissingEditorColumnsError, readClient, type StoredItem,
} from './db.js';
import { loadRubric, sourceNameMap } from './prompt.js';
import { runEditor } from './run.js';
import {
  buildEditorView, groupStories, missedByOldDigest, rankStories, type JudgedItem, type Story,
} from './select.js';
import { digestWindow, formatNy, parseWindow, type TimeWindow } from './window.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The digest's query: `order by score desc limit 500` (src/digest/generate.ts). */
const DIGEST_POOL = 500;

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Run `fn` with Date.now() frozen at `at`: buildSlottedDisplay measures recency from it. */
function withClock<T>(at: Date, fn: () => T): T {
  const real = Date.now;
  Date.now = () => at.getTime();
  try {
    return fn();
  } finally {
    Date.now = real;
  }
}

function rule(title: string) {
  console.log(`\n${'━'.repeat(72)}\n${title}\n${'━'.repeat(72)}`);
}

function printStories(title: string, stories: Story[]) {
  console.log(`\n${title}`);
  if (stories.length === 0) {
    console.log('  (none)');
    return;
  }
  stories.forEach((s, i) => {
    const j = s.lead.judgment;
    const tags = [j.type, j.audience === 'builder' ? 'builder' : '', s.followup ? 'follow-up' : ''].filter(Boolean);
    console.log(`  ${i + 1}. [${s.importance}] ${j.headline}  (${tags.join(', ')})`);
    if (j.why) console.log(`     ${j.why}`);
    console.log(`     Covered by: ${s.outlets.join(', ')}`);
    console.log(`     ${s.lead.url}`);
  });
}

function histogram(items: JudgedItem[]): string {
  const counts = new Map<number, number>();
  for (const i of items) counts.set(i.judgment.importance, (counts.get(i.judgment.importance) ?? 0) + 1);
  return [10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((n) => `${n}:${counts.get(n) ?? 0}`).join('  ');
}

async function judgeInMemory(items: StoredItem[], window: TimeWindow): Promise<JudgedItem[]> {
  const mode = authMode();
  if (mode === 'none') throw new Error('--dry-run needs ANTHROPIC_API_KEY in .env');
  const settings = modelSettings();
  const rubric = loadRubric();
  const caps = { ...editorCaps(), maxItems: items.length };

  // Context as the scheduled run would have had it: stories judged in the week before the window
  let known: Awaited<ReturnType<typeof fetchKnownStories>> = [];
  try {
    known = await fetchKnownStories(readClient(), new Date(window.from.getTime() - 7 * DAY_MS), window.from);
  } catch (err) {
    if (!(err instanceof MissingEditorColumnsError)) throw err;
    console.log('Migration 004 not applied: no stored stories to offer as context.');
  }

  console.log(
    `Dry run: judging ${items.length} item(s) with ${settings.model} (effort ${settings.effort}), ` +
      `rubric ${rubric.version}, auth: ${AUTH_DESCRIPTIONS[mode]}; nothing is stored.`,
  );
  const result = await runEditor({
    // Oldest first, as scheduled runs would have met them, so keys are named before their follow-ups
    items: [...items].reverse(),
    knownStories: known,
    rubric,
    sourceNames: sourceNameMap(loadSources()),
    caps,
    call: apiJudgeCall(createAnthropicClient(mode), settings),
    now: window.to,
  });

  const u = result.usage;
  const cost = estimateCostUsd(settings.model, u);
  console.log(
    `Judged ${result.judgments.length}/${items.length} in ${result.calls} call(s): ` +
      `${u.inputTokens} input + ${u.cacheReadTokens} cache-read + ${u.cacheWriteTokens} cache-write, ` +
      `${u.outputTokens} output${cost !== null ? ` (~$${cost.toFixed(4)})` : ''}; ` +
      `${result.rejected} rejected, ${result.missingItems} left out, ${result.failedItems} failed`,
  );

  const byId = new Map(items.map((i) => [i.id, i]));
  return result.judgments.map(({ id, ...judgment }) => ({ ...byId.get(id)!, judgment }));
}

async function main() {
  const date = argValue('--date');
  const windowArg = argValue('--window');
  if (!date && !windowArg) throw new Error('Pass --date YYYY-MM-DD or --window START,END');
  const window = windowArg ? parseWindow(windowArg) : digestWindow(date!);
  const dryRun = process.argv.includes('--dry-run');

  const sources = loadSources();
  const sourceNames = sourceNameMap(sources);
  const items = await fetchItems(readClient(), window.from, window.to);

  rule(`Preview: ${formatNy(window.from)} → ${formatNy(window.to)}${dryRun ? '  (dry run)' : ''}`);
  console.log(`${items.length} item(s) collected in the window.`);
  if (items.length === 0) return;

  // 1. The old digest
  const pool = [...items].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, DIGEST_POOL);
  const display = withClock(window.to, () => buildSlottedDisplay(pool, digestSlotOptions(sources)));
  rule('1. What the old digest logic picked (buildSlottedDisplay, unchanged)');
  console.log('Scores are as stored now; later collect runs rewrite them, so this approximates what was sent.\n');
  console.log(formatSlottedDisplayAsText(display));

  // 2. The editor's view
  const judged: JudgedItem[] = dryRun
    ? await judgeInMemory(items, window)
    : items.flatMap((i) => (i.judgment ? [{ ...i, judgment: i.judgment }] : []));

  rule(`2. The editor's view`);
  if (!dryRun) {
    const versions = [...new Set(items.flatMap((i) => (i.judgment ? [`${i.judgment.model} / ${i.judgment.version}`] : [])))];
    console.log(`${judged.length} of ${items.length} item(s) judged${versions.length ? ` (${versions.join('; ')})` : ''}.`);
    if (judged.length === 0) {
      console.log('Nothing judged in this window yet: run the backfill, or use --dry-run.');
      return;
    }
  }
  console.log(`Importance: ${histogram(judged)}`);

  const stories = groupStories(judged, sourceNames);
  const view = buildEditorView(stories);
  console.log(`${stories.length} stories.`);
  printStories('Top stories', view.top);
  printStories('Also notable', view.alsoNotable);
  printStories('For builders', view.builders);
  printStories('Notable papers', view.papers);

  if (process.argv.includes('--all')) {
    rule('Every judgment, by story (--all)');
    for (const s of rankStories(stories)) {
      for (const i of s.items) {
        const j = i.judgment;
        console.log(
          `  [${j.importance}] ${j.type.padEnd(17)} ${j.audience.padEnd(7)} ${s.key.padEnd(40)} ` +
            `${sourceNames.get(i.source) ?? i.source}: ${i.title.slice(0, 90)}`,
        );
      }
    }
  }

  // 3. What the old digest missed
  rule('3. Rated 7+ by the editor, not shown by the old digest');
  const shown = display.sections.flatMap((s) => s.items);
  printStories('Missed', missedByOldDigest(stories, shown));
  console.log('');
}

main().catch((err) => {
  console.error(`preview failed: ${(err as Error).message}`);
  process.exit(1);
});
