/**
 * From a window's items to the digest document. Normally the editor's: stories
 * built from the stored judgments (src/editor/select.ts), checked against the
 * last 7 days of shown stories for repeats and updates (repeats.ts), with
 * why-lines that describe coverage replaced (why.ts). When most of the window
 * is unjudged, or the judgments can't be read, the old ranking
 * (buildSlottedDisplay, unchanged) with a footer that says so. No I/O but the
 * repeat check and the optional summary, which the caller passes in.
 */

import type { NewsItem, SourceConfig } from '../collectors/types.js';
import type { StoredItem } from '../editor/db.js';
import {
  buildSections, groupStories, minShownImportance, type DigestSections, type JudgedItem, type SourceDirectory, type Story,
} from '../editor/select.js';
import { withClock } from '../editor/window.js';
import { buildSlottedDisplay, type SlottedDisplay } from '../utils/slots.js';
import { itemOutlet } from '../utils/source-names.js';
import type { DigestSettings } from './config.js';
import type { DigestDocument, DigestEntry, DigestSection } from './render.js';
import {
  checkRepeats, historyEntries, nyDate, pruneHistory, type HistoryEntry, type RepeatCall, type RepeatOutcome,
} from './repeats.js';
import { digestSlotOptions } from './slot-options.js';
import { chooseWhy } from './why.js';

/** Our prefix on a story that continues one already shown, in every layout. */
export const UPDATE_PREFIX = 'Update: ';

/** The old digest's query: `order by score desc limit 500`. The fallback keeps it. */
export const FALLBACK_POOL = 500;

export const FOOTER_FALLBACK = 'AI editor unavailable today — basic ranking';
export const EMPTY_INTRO = '📭 No new AI news since the last digest. Quiet day!';

export function editorFooter(judged: number, unjudged: number): string {
  const extra = unjudged > 0 ? ` (+${unjudged} item${unjudged === 1 ? '' : 's'} not yet rated)` : '';
  return `Ranked by the AI editor · ${judged} item${judged === 1 ? '' : 's'} reviewed${extra}`;
}

/**
 * Story keys per section, stored in digest_state as last_digest_story_keys.
 * Superseded by story_history; still written so a rollback to step 3 works.
 */
export interface ShownStories {
  top: string[];
  alsoNotable: string[];
  builders: string[];
  paper: string[];
}

export const NO_STORIES: ShownStories = { top: [], alsoNotable: [], builders: [], paper: [] };

export interface DigestInput {
  /** Every item in the window, judged or not. */
  items: StoredItem[];
  /** False when the editor columns couldn't be read (migration 004 missing, or a read error). */
  editorColumns: boolean;
  /** The digest's date and the end of its window. */
  now: Date;
  sources: SourceConfig[];
  dir: SourceDirectory;
  settings: DigestSettings;
  /** Stories shown in the last 7 days, newest first (digest_state.story_history). */
  history: HistoryEntry[];
  /** The repeat check's model call; without one, the key rule is used. */
  repeatCall?: RepeatCall;
  /** The fallback's optional AI summary (generate.ts: Claude, if a key is set). */
  summarize?: (items: NewsItem[]) => Promise<string | undefined>;
}

export interface DigestPlan {
  doc: DigestDocument;
  mode: 'editor' | 'fallback' | 'empty';
  /** Why the fallback was used. */
  reason?: string;
  shown: ShownStories;
  /** The history to store: this digest's stories added, pruned to 7 days. */
  history: HistoryEntry[];
  total: number;
  judged: number;
  unjudged: number;
  /** Stories left out as repeats, with why. */
  repeats: RepeatOutcome['dropped'];
  /** The repeat check, when the editor digest ran. */
  repeatCheck?: Omit<RepeatOutcome, 'stories' | 'dropped'>;
  /** Why-lines replaced or dropped because they described coverage. */
  whyFixes: string[];
}

const judgedOnly = (items: StoredItem[]): JudgedItem[] =>
  items.flatMap((i) => (i.judgment ? [{ ...i, judgment: i.judgment }] : []));

/** A story as the reader sees it. `fixes` collects the why-lines the guard turned down. */
export function storyEntry(s: Story, fixes: string[] = []): DigestEntry {
  const { why, rejected } = chooseWhy(s);
  if (rejected.length > 0) {
    fixes.push(`${s.key}: ${why ? 'replaced' : 'dropped'} "${rejected[0]}"${why ? ` with "${why}"` : ''}`);
  }
  const headline = s.update ? `${UPDATE_PREFIX}${s.lead.judgment.headline}` : s.lead.judgment.headline;
  return { headline, url: s.lead.url, ...(why ? { why } : {}), outlets: s.outlets };
}

export function editorSections(sections: DigestSections, fixes: string[] = []): DigestSection[] {
  const storyEntry_ = (s: Story) => storyEntry(s, fixes);
  return [
    {
      title: 'Top stories', icon: '📰', style: 'stories', entries: sections.top.map(storyEntry_),
      // Not "nothing was rated 6+": a paper or a builder story may have been, and be shown below
      empty: 'No top stories today.',
    },
    { title: 'Also notable', icon: '📌', style: 'list', entries: sections.alsoNotable.map(storyEntry_) },
    { title: 'For builders', icon: '🛠️', style: 'list', entries: sections.builders.map(storyEntry_) },
    { title: 'Paper of note', icon: '📄', style: 'story', entries: sections.paper.map(storyEntry_) },
  ];
}

const SLOT_ICONS: Record<string, string> = {
  'Top Story': '🔝',
  "Today's Highlights": '🆕',
  'Official Announcements': '📢',
  'From the Field': '📰',
  'Community Highlights': '🔥',
  'Research & Papers': '📄',
  'Industry & Tools': '⚙️',
};

/** The old ranking's sections, with the new link formatting: one linked line per item. */
export function fallbackSections(display: SlottedDisplay): DigestSection[] {
  return display.sections.map((section) => ({
    title: section.label,
    icon: SLOT_ICONS[section.label] ?? '📋',
    style: 'list' as const,
    entries: section.items.map((item) => ({
      // The old digest's cap on a title
      headline: item.title.length > 120 ? `${item.title.slice(0, 117)}...` : item.title,
      url: item.url,
      outlets: [itemOutlet(item.source, item.url).name],
    })),
  }));
}

export async function buildDigest(input: DigestInput): Promise<DigestPlan> {
  const { items, now, settings } = input;
  const today = nyDate(now);
  const judged = input.editorColumns ? judgedOnly(items) : [];
  // History kept through a fallback or an empty day, only pruned
  const counts = {
    total: items.length, judged: judged.length, unjudged: items.length - judged.length,
    history: pruneHistory(input.history, today), repeats: [], whyFixes: [],
  };

  if (items.length === 0) {
    return {
      doc: { date: now, intro: EMPTY_INTRO, sections: [], footer: editorFooter(0, 0) },
      mode: 'empty', shown: NO_STORIES, ...counts,
    };
  }

  const share = judged.length / items.length;
  if (!input.editorColumns || share < settings.minJudgedShare) {
    const reason = !input.editorColumns
      ? 'the editor columns could not be read'
      : `only ${judged.length} of ${items.length} items are judged (${Math.round(share * 100)}%, ` +
        `under ${Math.round(settings.minJudgedShare * 100)}%)`;
    const pool = [...items].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, FALLBACK_POOL);
    const display = withClock(now, () => buildSlottedDisplay(pool, digestSlotOptions(input.sources)));
    const summary = input.summarize ? await input.summarize(pool) : undefined;
    return {
      doc: { date: now, intro: summary, sections: fallbackSections(display), footer: FOOTER_FALLBACK },
      mode: 'fallback', reason, shown: NO_STORIES, ...counts,
    };
  }

  // Everything shown in the last 7 days, today's earlier send included (a second send must not repeat it)
  const earlier = counts.history;
  const { stories, dropped, ...repeatCheck } = await checkRepeats(
    groupStories(judged, input.dir), earlier, input.dir, minShownImportance(settings.rules), today, input.repeatCall,
  );
  const sections = buildSections(stories, { rules: settings.rules });
  const whyFixes: string[] = [];
  const keys = (list: Story[]) => list.map((s) => s.key);
  return {
    doc: { date: now, sections: editorSections(sections, whyFixes), footer: editorFooter(counts.judged, counts.unjudged) },
    mode: 'editor',
    shown: {
      top: keys(sections.top), alsoNotable: keys(sections.alsoNotable),
      builders: keys(sections.builders), paper: keys(sections.paper),
    },
    ...counts,
    history: pruneHistory([...historyEntries(sections, today), ...earlier], today),
    repeats: dropped,
    repeatCheck,
    whyFixes,
  };
}
