/**
 * The editor's view of a window, for the preview: group judged items into
 * stories, rank them, and pick the sections. Pure functions, no I/O.
 *
 * This is a first cut at what step 3's digest will show, so the owner can
 * compare it with what the old digest sent. The digest does not use it yet.
 */

import type { NewsItem } from '../collectors/types.js';
import type { Coverage } from '../utils/dedup.js';
import type { Audience, EditorType } from './judgment.js';
import { OFFICIAL_LAB_SOURCES } from './prompt.js';

export interface ItemJudgment {
  type: EditorType;
  importance: number;
  audience: Audience;
  headline: string;
  why: string;
  storyKey: string;
  followup: boolean;
}

export type JudgedItem = NewsItem & { id: string; judgment: ItemJudgment };

export interface Story {
  key: string;
  /** The item whose judgment represents the story. */
  lead: JudgedItem;
  items: JudgedItem[];
  importance: number;
  /** Display names of every outlet that carried it: its rows' sources and their coveredBy. */
  outlets: string[];
  /** The lead is a follow-up to an earlier story. */
  followup: boolean;
}

/** Sources whose items are papers (the "notable papers" section). */
export const PAPER_SOURCES = new Set(['arxiv_cs_ai', 'arxiv_cs_lg', 'arxiv_cs_cv', 'hf_daily_papers']);

const time = (i: NewsItem) => i.publishedAt ?? i.fetchedAt ?? '';

/**
 * Lead of a story: highest importance, then a lab's own post (the primary
 * source), then the earliest report.
 */
function leadFirst(a: JudgedItem, b: JudgedItem): number {
  return (
    b.judgment.importance - a.judgment.importance ||
    Number(OFFICIAL_LAB_SOURCES.has(b.source)) - Number(OFFICIAL_LAB_SOURCES.has(a.source)) ||
    time(a).localeCompare(time(b)) ||
    a.id.localeCompare(b.id)
  );
}

export function groupStories(items: JudgedItem[], sourceNames: Map<string, string>): Story[] {
  const groups = new Map<string, JudgedItem[]>();
  for (const item of items) {
    const list = groups.get(item.judgment.storyKey) ?? [];
    list.push(item);
    groups.set(item.judgment.storyKey, list);
  }

  const name = (id: string) => sourceNames.get(id) ?? id;
  return [...groups.entries()].map(([key, list]) => {
    const sorted = [...list].sort(leadFirst);
    const outlets: string[] = [];
    for (const item of sorted) {
      const coverage = Array.isArray(item.metadata?.coveredBy) ? (item.metadata!.coveredBy as Coverage[]) : [];
      for (const source of [item.source, ...coverage.map((c) => c.source)]) {
        if (!outlets.includes(name(source))) outlets.push(name(source));
      }
    }
    return {
      key,
      lead: sorted[0],
      items: sorted,
      importance: sorted[0].judgment.importance,
      outlets,
      followup: sorted[0].judgment.followup,
    };
  });
}

/** Most important first; then the most widely carried; then the most recent. */
export function rankStories(stories: Story[]): Story[] {
  const latest = (s: Story) => s.items.map(time).sort().at(-1) ?? '';
  return [...stories].sort(
    (a, b) =>
      b.importance - a.importance ||
      b.outlets.length - a.outlets.length ||
      latest(b).localeCompare(latest(a)) ||
      a.key.localeCompare(b.key),
  );
}

const isPaper = (s: Story) => s.lead.judgment.type === 'research' && s.items.some((i) => PAPER_SOURCES.has(i.source));

export interface ViewOptions {
  topLimit: number;
  topMinImportance: number;
  notableLimit: number;
  notableMinImportance: number;
  builderLimit: number;
  builderMinImportance: number;
  paperLimit: number;
  paperMinImportance: number;
}

export const DEFAULT_VIEW: ViewOptions = {
  topLimit: 5,
  topMinImportance: 5,
  notableLimit: 5,
  notableMinImportance: 4,
  builderLimit: 3,
  builderMinImportance: 4,
  paperLimit: 3,
  // The rubric: only genuinely notable papers score above 5
  paperMinImportance: 6,
};

export interface EditorView {
  top: Story[];
  alsoNotable: Story[];
  builders: Story[];
  papers: Story[];
}

/**
 * Sections, each story in at most one. The main list is general-audience
 * stories that aren't papers; a slow day shows fewer, not filler.
 */
export function buildEditorView(stories: Story[], opts: ViewOptions = DEFAULT_VIEW): EditorView {
  const ranked = rankStories(stories);
  const general = ranked.filter((s) => s.lead.judgment.audience === 'general' && !isPaper(s));

  const top = general.filter((s) => s.importance >= opts.topMinImportance).slice(0, opts.topLimit);
  const alsoNotable = general
    .filter((s) => !top.includes(s) && s.importance >= opts.notableMinImportance)
    .slice(0, opts.notableLimit);
  const builders = ranked
    .filter((s) => s.lead.judgment.audience === 'builder' && !isPaper(s) && s.importance >= opts.builderMinImportance)
    .slice(0, opts.builderLimit);
  const papers = ranked.filter((s) => isPaper(s) && s.importance >= opts.paperMinImportance).slice(0, opts.paperLimit);

  return { top, alsoNotable, builders, papers };
}

const rowKey = (i: { source: string; url: string }) => `${i.source}\n${i.url}`;

/**
 * Stories rated at least `minImportance` that the old digest showed no copy
 * of. `shown` are the items in the old digest's sections.
 */
export function missedByOldDigest(stories: Story[], shown: NewsItem[], minImportance = 7): Story[] {
  const shownKeys = new Set(shown.map(rowKey));
  return rankStories(stories).filter(
    (s) => s.importance >= minImportance && !s.items.some((i) => shownKeys.has(rowKey(i))),
  );
}
