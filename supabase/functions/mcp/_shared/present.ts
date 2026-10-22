/**
 * What the MCP tools return, built from stored items with the shared story
 * code (supabase/functions/_shared/newsroom/): the same grouping,
 * representative item, outlets, why-line guard, weak-source rule, per-outlet
 * caps, ranking and sections as the morning digest. Pure functions, no I/O,
 * so the Node test suite exercises them directly.
 *
 * The digest's repeat memory (story_history, the repeat check) is not used
 * here: the MCP is stateless and answers for any window.
 */

import type { StoredItem } from '../../_shared/newsroom/rows.ts';
import { buildSlottedDisplay, getRelevanceScore, type SlotOptions } from '../../_shared/newsroom/slots.ts';
import { sourceDisplayName } from '../../_shared/newsroom/source-names.ts';
import {
  buildSections, DEFAULT_MIN_JUDGED_SHARE, DEFAULT_RULES, groupStories, makeStory, rankStories, SECTION_TITLES, sourceDirectory,
  storyOutlets, type DigestSections, type JudgedItem, type SectionRules, type Story,
} from '../../_shared/newsroom/stories.ts';
import { AUDIENCES, EDITOR_TYPES, type Audience, type EditorType } from '../../_shared/newsroom/types.ts';
import { chooseWhy } from '../../_shared/newsroom/why.ts';

const DIR = sourceDirectory();

/**
 * One news story as a tool returns it. The first block is the representative
 * item, under the field names the tools have always used; the second is the
 * AI editor's judgment, null for an item not judged yet.
 */
export interface NewsEntry {
  title: string;
  url: string;
  source: string;
  sourceId: string;
  category: string;
  score: number;
  summary: string | null;
  authors: string | null;
  publishedAt: string | null;
  fetchedAt: string;

  headline: string | null;
  why: string | null;
  importance: number | null;
  type: EditorType | null;
  audience: Audience | null;
  story_key: string | null;
  followup: boolean | null;
  /** Every outlet that carried it, HN links as "Publisher (via HN)". */
  outlets: string[];
  published_at: string | null;
  /** Rows grouped into this story. */
  copies: number;
}

function base(lead: StoredItem) {
  return {
    title: lead.title,
    url: lead.url,
    source: sourceDisplayName(lead.source),
    sourceId: lead.source,
    category: lead.sourceCategory,
    score: getRelevanceScore(lead),
    summary: lead.summary ?? null,
    authors: lead.authors ?? null,
    publishedAt: lead.publishedAt ?? null,
    fetchedAt: lead.fetchedAt,
  };
}

export function storyEntry(s: Story): NewsEntry {
  const lead = s.lead as StoredItem & JudgedItem;
  return {
    ...base(lead),
    headline: lead.judgment.headline,
    why: chooseWhy(s).why ?? null,
    importance: s.importance,
    type: lead.judgment.type,
    audience: lead.judgment.audience,
    story_key: s.key,
    followup: s.followup,
    outlets: s.outlets,
    published_at: lead.publishedAt ?? null,
    copies: s.items.length,
  };
}

/** One item on its own: its judgment if it has one, else the unjudged shape. */
export function itemEntry(item: StoredItem): NewsEntry {
  if (!item.judgment) return unjudgedEntry(item);
  const judged = { ...item, judgment: item.judgment } as StoredItem & JudgedItem;
  return storyEntry(makeStory(item.judgment.storyKey, [judged], DIR));
}

export function unjudgedEntry(item: StoredItem): NewsEntry {
  return {
    ...base(item),
    headline: null, why: null, importance: null, type: null, audience: null, story_key: null, followup: null,
    outlets: storyOutlets([item]),
    published_at: item.publishedAt ?? null,
    copies: 1,
  };
}

// ─── parameters ──────────────────────────────────────────────────

/** A caller error: index.ts answers these with -32602, not -32603. */
export class InvalidParameter extends Error {
  constructor(message: string) {
    super(`Invalid parameter: ${message}`);
  }
}

export interface EditorFilters {
  minImportance?: number;
  type?: EditorType;
  audience?: Audience;
}

export function parseFilters(params: Record<string, unknown>): EditorFilters {
  const out: EditorFilters = {};
  if (params.min_importance !== undefined && params.min_importance !== null) {
    const n = Number(params.min_importance);
    if (!Number.isInteger(n) || n < 1 || n > 10) throw new InvalidParameter('min_importance must be an integer from 1 to 10');
    out.minImportance = n;
  }
  if (params.type !== undefined && params.type !== null) {
    if (!(EDITOR_TYPES as readonly unknown[]).includes(params.type)) {
      throw new InvalidParameter(`type must be one of ${EDITOR_TYPES.join(', ')}`);
    }
    out.type = params.type as EditorType;
  }
  if (params.audience !== undefined && params.audience !== null) {
    if (!(AUDIENCES as readonly unknown[]).includes(params.audience)) {
      throw new InvalidParameter(`audience must be one of ${AUDIENCES.join(', ')}`);
    }
    out.audience = params.audience as Audience;
  }
  return out;
}

const hasFilters = (f: EditorFilters) => f.minImportance !== undefined || f.type !== undefined || f.audience !== undefined;

/** A count parameter: as before, anything unusable means the default. */
export function parseLimit(value: unknown, fallback: number, max = 200): number {
  const n = Number(value);
  return value === undefined || value === null || !Number.isFinite(n) || n < 1 ? fallback : Math.min(Math.floor(n), max);
}

export function parseSince(value: unknown, name = 'since'): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const t = typeof value === 'string' ? Date.parse(value) : NaN;
  if (Number.isNaN(t)) throw new InvalidParameter(`${name} must be an ISO 8601 timestamp, e.g. "2026-10-21T00:00:00Z"`);
  return new Date(t).toISOString();
}

// ─── lists ───────────────────────────────────────────────────────

const judgedOnly = (items: StoredItem[]) =>
  items.flatMap((i) => (i.judgment ? [{ ...i, judgment: i.judgment } as StoredItem & JudgedItem] : []));

function passes(s: Story, f: EditorFilters): boolean {
  return (f.minImportance === undefined || s.importance >= f.minImportance) &&
    (f.type === undefined || s.lead.judgment.type === f.type) &&
    (f.audience === undefined || s.lead.judgment.audience === f.audience);
}

/**
 * A list tool's answer: judged items grouped into stories (copies listed in
 * `outlets`), ranked as the digest ranks them: importance, then how widely
 * carried, then recency. Unjudged items follow, one entry each, by the old
 * score. With an editor filter, unjudged items are left out: they have no
 * importance, type or audience to match.
 */
export function rankEntries(items: StoredItem[], filters: EditorFilters = {}): NewsEntry[] {
  const stories = rankStories(groupStories(judgedOnly(items), DIR)).filter((s) => passes(s, filters));
  const unjudged = hasFilters(filters)
    ? []
    : items.filter((i) => !i.judgment).sort((a, b) => getRelevanceScore(b) - getRelevanceScore(a) || a.id.localeCompare(b.id));
  return [...stories.map(storyEntry), ...unjudged.map(unjudgedEntry)];
}

export function entryLine(e: NewsEntry, n: number): string {
  const head = e.importance !== null ? `[${e.importance}] ${e.headline}` : `[unrated] ${e.title}`;
  const lines = [`${n}. ${head} — ${e.outlets.join(', ') || e.source}`];
  if (e.why) lines.push(`   ${e.why}`);
  lines.push(`   ${e.url}`);
  return lines.join('\n');
}

export const entriesText = (entries: NewsEntry[]) => entries.map((e, i) => entryLine(e, i + 1)).join('\n');

// ─── get_top_picks ───────────────────────────────────────────────

export interface TopPicksSection {
  id: keyof DigestSections | string;
  label: string;
  emoji: string;
  items: NewsEntry[];
}

export interface TopPicks {
  /** `editor`: the digest's sections. `fallback`: most of the window is unjudged, so the old score order. */
  mode: 'editor' | 'fallback';
  sections: TopPicksSection[];
  total: number;
  judged: number;
  note?: string;
}

export interface TopPicksOptions {
  rules?: SectionRules;
  /** showAll: no section or per-outlet limits (thresholds still apply). */
  showAll?: boolean;
  /** The legacy per-section limits, for the old ranking when it is used. */
  legacy?: SlotOptions;
  editorColumns?: boolean;
  minJudgedShare?: number;
}

const ALL = { topLimit: Infinity, notableLimit: Infinity, builderLimit: Infinity, paperLimit: Infinity, maxPerOutlet: Infinity };

/** The old ranking's pool: the digest's fallback reads the 500 highest-scored items. */
const FALLBACK_POOL = 500;

/**
 * showAll in the old ranking: no section or per-source limit. The top story
 * stays one item, and the sections after it skip what it took, so nothing is
 * left out by it.
 */
const SLOTS_ALL: SlotOptions = {
  todayLimit: Infinity, todayMaxPerSource: Infinity, fieldLimit: Infinity, fieldMaxPerSource: Infinity,
  officialLimit: Infinity, officialMaxPerSource: Infinity, communityLimit: Infinity, communityMaxPerSource: Infinity,
  researchLimit: Infinity, researchMaxPerSource: Infinity, industryLimit: Infinity, industryMaxPerSource: Infinity,
};

/**
 * The same sections the digest would build for these items, with its default
 * thresholds; or, when less than half the window is judged, the old
 * score-ordered slots with a note saying so, as the digest falls back.
 */
export function topPicks(items: StoredItem[], opts: TopPicksOptions = {}): TopPicks {
  const judged = opts.editorColumns === false ? [] : judgedOnly(items);
  const share = items.length === 0 ? 1 : judged.length / items.length;
  if (items.length > 0 && share < (opts.minJudgedShare ?? DEFAULT_MIN_JUDGED_SHARE)) {
    const sorted = [...items].sort((a, b) => getRelevanceScore(b) - getRelevanceScore(a));
    const pool = opts.showAll ? sorted : sorted.slice(0, FALLBACK_POOL);
    const display = buildSlottedDisplay(pool, opts.showAll ? SLOTS_ALL : opts.legacy ?? {});
    // The shared slots add release entries after capping blogs, so they can run
    // past officialLimit. The digest's fallback keeps that as it is; here the
    // caller's limit holds, as it did in the MCP's own slotting before
    const officialLimit = opts.showAll ? undefined : opts.legacy?.officialLimit;
    if (officialLimit !== undefined && Number.isFinite(officialLimit)) {
      const official = display.sections.find((s) => s.label === 'Official Announcements');
      if (official) official.items = official.items.slice(0, Math.max(0, Math.floor(officialLimit)));
      display.sections = display.sections.filter((s) => s.items.length > 0);
    }
    return {
      mode: 'fallback',
      // Score order, but an item the editor did rate keeps its judgment
      sections: display.sections.map((s) => ({ id: s.label, label: s.label, emoji: '', items: (s.items as StoredItem[]).map(itemEntry) })),
      total: items.length,
      judged: judged.length,
      note: `The AI editor has rated only ${judged.length} of ${items.length} items in this window ` +
        `(${Math.round(share * 100)}%), so this uses the older score-based ranking.`,
    };
  }
  const rules = { ...(opts.rules ?? DEFAULT_RULES), ...(opts.showAll ? ALL : {}) };
  const sections = buildSections(groupStories(judged, DIR), { rules });
  const unjudged = items.length - judged.length;
  return {
    mode: 'editor',
    sections: (Object.keys(SECTION_TITLES) as (keyof typeof SECTION_TITLES)[]).map((id) => ({
      id, label: SECTION_TITLES[id].title, emoji: SECTION_TITLES[id].icon, items: sections[id].map(storyEntry),
    })),
    total: items.length,
    judged: judged.length,
    ...(unjudged > 0 ? { note: `${unjudged} item${unjudged === 1 ? '' : 's'} in this window not yet rated, so not shown.` } : {}),
  };
}

export function topPicksText(t: TopPicks, windowLabel: string): string {
  const lines = [`AI news, ${windowLabel} — ${t.mode === 'editor' ? 'ranked by the AI editor' : 'basic ranking'}`];
  if (t.note) lines.push(`(${t.note})`);
  const shown = t.sections.filter((s) => s.items.length > 0 || s.id === 'top');
  for (const s of shown) {
    lines.push('', `${s.emoji ? `${s.emoji} ` : ''}${s.label}`);
    if (s.items.length === 0) lines.push('No top stories in this window.');
    s.items.forEach((e, i) => lines.push(entryLine(e, i + 1)));
  }
  if (t.total === 0) return `No AI news collected in ${windowLabel}.`;
  return lines.join('\n');
}

// ─── check_status ────────────────────────────────────────────────

export interface EditorStatus {
  items: number;
  judged: number;
  /** judged / items, 0–1; null with no items. */
  judgedShare: number | null;
  rubricVersions: string[];
  models: string[];
}

/** The editor's coverage of a set of items (check_status: the last 24 hours). */
export function editorStatus(items: StoredItem[]): EditorStatus {
  const judged = items.filter((i) => i.judgment);
  const distinct = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => Boolean(x)))].sort();
  return {
    items: items.length,
    judged: judged.length,
    judgedShare: items.length ? Math.round((judged.length / items.length) * 1000) / 1000 : null,
    rubricVersions: distinct(judged.map((i) => i.judgment!.version)),
    models: distinct(judged.map((i) => i.judgment!.model)),
  };
}
