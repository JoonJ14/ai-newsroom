/**
 * From a window's items to the digest document. Normally the editor's: stories
 * built from the stored judgments (src/editor/select.ts). When most of the
 * window is unjudged, or the judgments can't be read, the old ranking
 * (buildSlottedDisplay, unchanged) with a footer that says so. No I/O but the
 * optional summary call, which the caller passes in.
 */

import type { NewsItem, SourceConfig } from '../collectors/types.js';
import type { StoredItem } from '../editor/db.js';
import {
  buildSections, groupStories, type DigestSections, type JudgedItem, type SourceDirectory, type Story,
} from '../editor/select.js';
import { withClock } from '../editor/window.js';
import { buildSlottedDisplay, type SlottedDisplay } from '../utils/slots.js';
import { sourceDisplayName } from '../utils/source-names.js';
import type { DigestSettings } from './config.js';
import type { DigestDocument, DigestEntry, DigestSection } from './render.js';
import { digestSlotOptions } from './slot-options.js';

/** The old digest's query: `order by score desc limit 500`. The fallback keeps it. */
export const FALLBACK_POOL = 500;

export const FOOTER_FALLBACK = 'AI editor unavailable today — basic ranking';
export const EMPTY_INTRO = '📭 No new AI news since the last digest. Quiet day!';

export function editorFooter(judged: number, unjudged: number): string {
  const extra = unjudged > 0 ? ` (+${unjudged} item${unjudged === 1 ? '' : 's'} not yet rated)` : '';
  return `Ranked by the AI editor · ${judged} item${judged === 1 ? '' : 's'} reviewed${extra}`;
}

/** Story keys per section, stored in digest_state as last_digest_story_keys. */
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
  /** Story keys that led the previous digest. */
  ledBefore: ReadonlySet<string>;
  /** The fallback's optional AI summary (generate.ts: Claude, if a key is set). */
  summarize?: (items: NewsItem[]) => Promise<string | undefined>;
}

export interface DigestPlan {
  doc: DigestDocument;
  mode: 'editor' | 'fallback' | 'empty';
  /** Why the fallback was used. */
  reason?: string;
  shown: ShownStories;
  total: number;
  judged: number;
  unjudged: number;
  /** Keys left out because they led the previous digest with nothing new. */
  repeats: string[];
}

const judgedOnly = (items: StoredItem[]): JudgedItem[] =>
  items.flatMap((i) => (i.judgment ? [{ ...i, judgment: i.judgment }] : []));

function storyEntry(s: Story): DigestEntry {
  return { headline: s.lead.judgment.headline, url: s.lead.url, why: s.lead.judgment.why, outlets: s.outlets };
}

export function editorSections(sections: DigestSections, settings: DigestSettings): DigestSection[] {
  return [
    {
      title: 'Top stories', icon: '📰', style: 'stories', entries: sections.top.map(storyEntry),
      // Not "nothing was rated 6+": a paper or a builder story may have been, and be shown below
      empty: 'No top stories today.',
    },
    { title: 'Also notable', icon: '📌', style: 'list', entries: sections.alsoNotable.map(storyEntry) },
    { title: 'For builders', icon: '🛠️', style: 'list', entries: sections.builders.map(storyEntry) },
    { title: 'Paper of note', icon: '📄', style: 'story', entries: sections.paper.map(storyEntry) },
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
      outlets: [sourceDisplayName(item.source)],
    })),
  }));
}

export async function buildDigest(input: DigestInput): Promise<DigestPlan> {
  const { items, now, settings } = input;
  const judged = input.editorColumns ? judgedOnly(items) : [];
  const counts = { total: items.length, judged: judged.length, unjudged: items.length - judged.length };

  if (items.length === 0) {
    return {
      doc: { date: now, intro: EMPTY_INTRO, sections: [], footer: editorFooter(0, 0) },
      mode: 'empty', shown: NO_STORIES, repeats: [], ...counts,
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
      mode: 'fallback', reason, shown: NO_STORIES, repeats: [], ...counts,
    };
  }

  const sections = buildSections(groupStories(judged, input.dir), input.dir, {
    rules: settings.rules, ledBefore: input.ledBefore,
  });
  const keys = (list: Story[]) => list.map((s) => s.key);
  return {
    doc: { date: now, sections: editorSections(sections, settings), footer: editorFooter(counts.judged, counts.unjudged) },
    mode: 'editor',
    shown: {
      top: keys(sections.top), alsoNotable: keys(sections.alsoNotable),
      builders: keys(sections.builders), paper: keys(sections.paper),
    },
    repeats: keys(sections.repeats),
    ...counts,
  };
}
