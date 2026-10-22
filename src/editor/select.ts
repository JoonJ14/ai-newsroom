/**
 * Stories from the editor's judgments: group judged items by story key, pick
 * the item that represents each story, rank the stories and fill the digest's
 * sections. Pure functions, no I/O. The digest (src/digest/) and the editor
 * preview (`npm run preview:editor`) both use them, so they show the same
 * picks.
 */

import type { NewsItem, SourceConfig } from '../collectors/types.js';
import type { Coverage } from '../utils/dedup.js';
import { itemOutlet, knownPublisher, sourceDisplayName } from '../utils/source-names.js';
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
  /** The item that represents the story: its headline, why-line and link. */
  lead: JudgedItem;
  /** Lead first, then the rest in the same order of preference. */
  items: JudgedItem[];
  /** The highest importance among its items. */
  importance: number;
  /** Display names of every outlet that carried it: its rows' sources and their coveredBy. */
  outlets: string[];
  /** One of its items is a genuine new development on an earlier story. */
  followup: boolean;
  /** The lead's outlet for per-outlet caps: the publisher, so "Reuters (via HN)" counts as Reuters. */
  leadOutlet: string;
  /**
   * Carried by at least one source a reader can trust to lead the digest: an
   * official lab, a wire service, the tier-1/2 press, or an HN link to a known
   * publisher. Counts the copies in coveredBy too.
   */
  strongSource: boolean;
  /** Set when the story continues one already shown (src/digest/repeats.ts). */
  update?: StoryUpdate;
}

export interface StoryUpdate {
  /** The history entry's key it continues. */
  continues: string;
  /** What is new, in a few words; logged. */
  newFact: string;
  /** A small tweak rather than a real development: never a top story. */
  minor: boolean;
}

/** Sources whose items are papers. */
export const PAPER_SOURCES = new Set(['arxiv_cs_ai', 'arxiv_cs_lg', 'arxiv_cs_cv', 'hf_daily_papers']);

/**
 * Wire services and the financial press, often linked from Hacker News. An
 * HN item's url is the article itself (the thread is in metadata.hnLink), so
 * the link a reader gets is the article's.
 */
export const WIRE_DOMAINS = ['reuters.com', 'apnews.com', 'ft.com', 'bloomberg.com'];

/** What the digest knows about sources: their display names and which are the established press. */
export interface SourceDirectory {
  name: (source: string) => string;
  isPress: (source: string) => boolean;
}

/** Tier-1/2 press: `industry_news` sources with sourceTier 1 or 2 in sources.yaml. */
export function sourceDirectory(sources: SourceConfig[]): SourceDirectory {
  const press = new Set(
    sources.filter((s) => s.category === 'industry_news' && (s.sourceTier ?? 3) <= 2).map((s) => s.id),
  );
  return { name: sourceDisplayName, isPress: (id) => press.has(id) };
}

/** Preference for the item that represents a story, best first. */
export type SourceClass = 'official' | 'wire' | 'press' | 'other';
const CLASS_RANK: Record<SourceClass, number> = { official: 0, wire: 1, press: 2, other: 3 };

function hostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function isWireUrl(url: string): boolean {
  const host = hostname(url);
  return WIRE_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

export function sourceClass(item: NewsItem, dir: SourceDirectory): SourceClass {
  if (OFFICIAL_LAB_SOURCES.has(item.source)) return 'official';
  if (isWireUrl(item.url)) return 'wire';
  if (dir.isPress(item.source)) return 'press';
  return 'other';
}

const time = (i: NewsItem) => i.publishedAt ?? i.fetchedAt ?? '';

const byImportanceThenEarliest = (a: JudgedItem, b: JudgedItem) =>
  b.judgment.importance - a.judgment.importance || time(a).localeCompare(time(b)) || a.id.localeCompare(b.id);

/**
 * Order of preference for representing a story: a lab's own post, then a wire
 * service, then the established press, then anything else; ties by the item's
 * importance, then the earliest published.
 *
 * Only items that were judged as this story's main event can represent it:
 * importance within one point of the story's best, and the story's audience,
 * which is `general` if any of those items is. A partner's post about someone
 * else's launch (NVIDIA's "run Muse Spark Open on GB300", a builder item on a
 * general story) is an official lab post, but it isn't the story.
 */
export function orderForLead(items: JudgedItem[], dir: SourceDirectory): JudgedItem[] {
  const top = Math.max(...items.map((i) => i.judgment.importance));
  const near = (i: JudgedItem) => i.judgment.importance >= top - 1;
  const audience: Audience = items.some((i) => near(i) && i.judgment.audience === 'general') ? 'general' : 'builder';
  const eligible = (i: JudgedItem) => near(i) && i.judgment.audience === audience;
  const rank = (i: JudgedItem) => CLASS_RANK[sourceClass(i, dir)];
  return [...items].sort(
    (a, b) => Number(eligible(b)) - Number(eligible(a)) || rank(a) - rank(b) || byImportanceThenEarliest(a, b),
  );
}

function coverageOf(item: NewsItem): Coverage[] {
  return Array.isArray(item.metadata?.coveredBy) ? (item.metadata!.coveredBy as Coverage[]) : [];
}

/** Every copy of a story: its rows, and the copies dedup folded into them. */
function copiesOf(items: JudgedItem[]): { source: string; url: string }[] {
  return items.flatMap((i) => [{ source: i.source, url: i.url }, ...coverageOf(i).map((c) => ({ source: c.source, url: c.url ?? '' }))]);
}

/**
 * Outlet names in order of preference, once each. An HN link names its
 * publisher ("The Guardian (via HN)"), and is dropped when that publisher
 * also carried the story directly.
 */
export function storyOutlets(items: JudgedItem[]): string[] {
  const copies = copiesOf(items).map((c) => itemOutlet(c.source, c.url));
  const direct = new Set(copies.filter((c) => !c.viaHN).map((c) => c.publisher));
  const names: string[] = [];
  for (const c of copies) {
    if (c.viaHN && direct.has(c.publisher)) continue;
    if (!names.includes(c.name)) names.push(c.name);
  }
  return names;
}

/** A copy from a source that can lead the digest (see Story.strongSource). */
export function isStrongCopy(copy: { source: string; url: string }, dir: SourceDirectory): boolean {
  if (OFFICIAL_LAB_SOURCES.has(copy.source) || isWireUrl(copy.url) || dir.isPress(copy.source)) return true;
  return itemOutlet(copy.source, copy.url).viaHN && knownPublisher(copy.url) !== undefined;
}

export function makeStory(key: string, items: JudgedItem[], dir: SourceDirectory, update?: StoryUpdate): Story {
  const sorted = orderForLead(items, dir);
  return {
    key,
    lead: sorted[0],
    items: sorted,
    importance: Math.max(...sorted.map((i) => i.judgment.importance)),
    outlets: storyOutlets(sorted),
    followup: sorted.some((i) => i.judgment.followup),
    leadOutlet: itemOutlet(sorted[0].source, sorted[0].url).publisher,
    strongSource: copiesOf(sorted).some((c) => isStrongCopy(c, dir)),
    ...(update ? { update } : {}),
  };
}

export function groupStories(items: JudgedItem[], dir: SourceDirectory): Story[] {
  const groups = new Map<string, JudgedItem[]>();
  for (const item of items) {
    const list = groups.get(item.judgment.storyKey) ?? [];
    list.push(item);
    groups.set(item.judgment.storyKey, list);
  }
  return [...groups.entries()].map(([key, list]) => makeStory(key, list, dir));
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

/**
 * A paper: led by an arXiv or HF Papers item, so only papers carried it, and
 * it goes in Paper of note alone. A paper the press or a lab also covered is
 * usually led by that coverage (paper sources are in the last class) and is news:
 * it competes for Top stories like any other story. Deliberate, not a leak:
 * "research that changes what's possible" belongs in the main briefing.
 */
const isPaper = (s: Story) => PAPER_SOURCES.has(s.lead.source);
const isGeneral = (s: Story) => s.lead.judgment.audience === 'general';

export interface SectionRules {
  topLimit: number;
  topMinImportance: number;
  /** Builder stories join Top stories only at this importance, and only when general ones run short. */
  topBuilderMinImportance: number;
  notableLimit: number;
  notableMinImportance: number;
  builderLimit: number;
  builderMinImportance: number;
  paperLimit: number;
  paperMinImportance: number;
  /** A story with no strong source (Story.strongSource) can be a top story only at this importance. */
  weakSourceTopMinImportance: number;
  /** Stories per section with the same lead outlet. */
  maxPerOutlet: number;
}

export const DEFAULT_RULES: SectionRules = {
  topLimit: 5,
  topMinImportance: 6,
  topBuilderMinImportance: 7,
  notableLimit: 5,
  notableMinImportance: 4,
  builderLimit: 3,
  builderMinImportance: 4,
  paperLimit: 1,
  // The rubric: only genuinely notable papers score above 5, one or two a week
  paperMinImportance: 6,
  weakSourceTopMinImportance: 8,
  maxPerOutlet: 2,
};

export interface DigestSections {
  top: Story[];
  alsoNotable: Story[];
  builders: Story[];
  paper: Story[];
}

/** The lowest importance any section takes: stories below it can't appear anywhere. */
export function minShownImportance(rules: SectionRules): number {
  return Math.min(rules.topMinImportance, rules.notableMinImportance, rules.builderMinImportance, rules.paperMinImportance);
}

/** Whether a story may be a top story: important enough, from a source that can lead, and not a small tweak. */
export function topEligible(s: Story, rules: SectionRules): boolean {
  if (s.update?.minor) return false;
  return s.strongSource || s.importance >= rules.weakSourceTopMinImportance;
}

/**
 * The digest's sections, each story in at most one. A quiet day shows fewer
 * stories, never filler: every section has a minimum importance. Within a
 * section, at most `maxPerOutlet` stories share a lead outlet; one over the
 * cap, or kept out of Top stories, can still go to a later section it
 * qualifies for, never into one it doesn't.
 *
 * Repeats are dealt with before this (src/digest/repeats.ts): `stories` are
 * the ones still to show, updates already cut down to their new items.
 */
export function buildSections(
  stories: Story[],
  { rules = DEFAULT_RULES }: { rules?: SectionRules } = {},
): DigestSections {
  const ranked = rankStories(stories);
  const shown = new Set<Story>();
  const take = (list: Story[], limit: number, perOutlet = new Map<string, number>()) => {
    const picked: Story[] = [];
    for (const s of list) {
      if (picked.length >= limit) break;
      if (shown.has(s)) continue;
      const n = perOutlet.get(s.leadOutlet) ?? 0;
      if (n >= rules.maxPerOutlet) continue;
      perOutlet.set(s.leadOutlet, n + 1);
      picked.push(s);
      shown.add(s);
    }
    return picked;
  };

  const news = ranked.filter((s) => !isPaper(s));
  const topOutlets = new Map<string, number>();
  const topGeneral = take(
    news.filter((s) => isGeneral(s) && s.importance >= rules.topMinImportance && topEligible(s, rules)),
    rules.topLimit, topOutlets,
  );
  const topBuilder = take(
    news.filter((s) => !isGeneral(s) && s.importance >= Math.max(rules.topMinImportance, rules.topBuilderMinImportance) &&
      topEligible(s, rules)),
    rules.topLimit - topGeneral.length, topOutlets,
  );
  const top = rankStories([...topGeneral, ...topBuilder]);
  const alsoNotable = take(news.filter((s) => isGeneral(s) && s.importance >= rules.notableMinImportance), rules.notableLimit);
  const builders = take(news.filter((s) => !isGeneral(s) && s.importance >= rules.builderMinImportance), rules.builderLimit);
  const paper = take(
    ranked.filter((s) => (isPaper(s) || s.lead.judgment.type === 'research') && s.importance >= rules.paperMinImportance),
    rules.paperLimit,
  );
  return { top, alsoNotable, builders, paper };
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
