/**
 * Deduplication for news items.
 * Two items are duplicates if:
 * - URLs match (ignoring scheme, `www.` and a trailing slash), OR
 * - they come from different sources and title similarity > 0.8 (Jaccard
 *   similarity on word sets). Within one source, distinct URLs are distinct
 *   items: changelog entries such as "…in the Australia region" and "…in the
 *   Canada region" are 0.83 alike.
 *
 * Matches are transitive: a copy that matches one story by URL and another by
 * title joins them into one.
 *
 * One row is still stored per story: the higher-scored copy. It records the
 * other copies in `metadata.coveredBy` and keeps their engagement signals (an
 * HN thread's points on a press article, a paper's HF upvotes on its arXiv
 * row), so how widely a story was carried is not lost.
 */

import { createLogger } from './logger.js';
import type { NewsItem } from '../collectors/types.js';

const log = createLogger('dedup');

export interface Coverage {
  source: string;
  url: string;
}

/** An HN thread's fields, carried together onto the row that absorbs it. */
const HN_SIGNALS = ['hnId', 'hnLink', 'hnPoints', 'commentCount'] as const;

/**
 * Metadata that survives from absorbed copies, and that an upsert keeps from
 * the stored row when a later run no longer sees the other copy
 * (src/utils/supabase.ts).
 */
export const CARRIED_SIGNALS: readonly string[] = [...HN_SIGNALS, 'upvotes'];

/**
 * Comparison key for "same link". The query is kept: an HN text post's only
 * identity is `item?id=…`, and each release-notes bullet differs only in its
 * query. Stripping it merged unrelated items. The fragment is dropped (an HN
 * link to `story#comments` is the same story), unless it is an app route
 * (`#/…`, `#!…`). Tracking parameters are already gone (src/utils/normalize.ts).
 */
export function urlKey(url: string): string {
  try {
    const u = new URL(url);
    const host = u.host.toLowerCase().replace(/^www\./, '');
    const route = /^#[/!]/.test(u.hash) ? u.hash : '';
    return `${host}${u.pathname.replace(/\/+$/, '')}${u.search}${route}`;
  } catch {
    return url.replace(/\/+$/, '');
  }
}

/**
 * Extract word set from a title for Jaccard similarity.
 */
function titleWords(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 0),
  );
}

/**
 * Jaccard similarity between two word sets: |A ∩ B| / |A ∪ B|
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function coverageOf(item: NewsItem): Coverage[] {
  const list = item.metadata?.coveredBy;
  return Array.isArray(list) ? (list as Coverage[]) : [];
}

/** Union of coverage lists, without duplicates and without the row itself. */
export function mergeCoverage(self: Coverage, ...lists: Coverage[][]): Coverage[] {
  const merged = new Map<string, Coverage>();
  for (const c of lists.flat()) {
    if (c.source === self.source && c.url === self.url) continue;
    merged.set(`${c.source}\n${c.url}`, { source: c.source, url: c.url });
  }
  return [...merged.values()];
}

/** An item's own HN thread, if it has one. */
function hnThread(item: NewsItem): Record<string, unknown> | undefined {
  const meta = item.metadata ?? {};
  if (typeof meta.hnPoints !== 'number') return undefined;
  return Object.fromEntries(HN_SIGNALS.map((key) => [key, meta[key]]));
}

/** One story: the copy that will be stored, and what identifies its other copies. */
interface Cluster {
  survivor: NewsItem;
  /** Every copy's source, URL key and title words: a later copy matching any of them matches */
  members: { source: string; key: string; words: Set<string> }[];
  /** The biggest HN thread among the copies */
  hn?: Record<string, unknown>;
}

/**
 * Whether two stories can be one. Not if that would put two different URLs
 * from one source together: within a source, those are different items, and
 * each is its own `(url, source)` row. Without this, a press copy whose title
 * matched two similar changelog entries would join them.
 */
function compatible(a: Cluster, b: Cluster): boolean {
  return !a.members.some((m) => b.members.some((n) => m.source === n.source && m.key !== n.key));
}

/**
 * Deduplicate items. Copies of one story are grouped by URL or title. The
 * highest-scored copy is kept; it records the others in `coveredBy`, takes
 * HF upvotes it lacks and, unless it is an HN row itself, the story's biggest
 * HN thread.
 *
 * Items are one run's fresh collector output (src/collectors/index.ts), so an
 * item's HN fields are its own thread. What earlier runs carried is merged
 * at upsert (mergeStoredMetadata in src/utils/supabase.ts).
 */
export function deduplicateItems(items: NewsItem[]): NewsItem[] {
  if (items.length === 0) return [];

  /** Fold `dropped` into `survivor`: coverage, plus upvotes it lacks. HN comes last. */
  const absorb = (survivor: NewsItem, dropped: NewsItem) => {
    const meta: Record<string, unknown> = { ...survivor.metadata };
    const droppedMeta = dropped.metadata ?? {};
    if (meta.upvotes === undefined && droppedMeta.upvotes !== undefined) {
      meta.upvotes = droppedMeta.upvotes;
    }
    meta.coveredBy = mergeCoverage(
      { source: survivor.source, url: survivor.url },
      coverageOf(survivor),
      [{ source: dropped.source, url: dropped.url }],
      coverageOf(dropped),
    );
    survivor.metadata = meta;
  };

  /** One story from two; `b`'s survivor wins only on a higher score. */
  const join = (a: Cluster, b: Cluster): Cluster => {
    const [winner, loser] = b.survivor.score > a.survivor.score ? [b, a] : [a, b];
    absorb(winner.survivor, loser.survivor);
    const hn = !a.hn || (b.hn && (b.hn.hnPoints as number) > (a.hn.hnPoints as number)) ? b.hn : a.hn;
    return { survivor: winner.survivor, members: [...a.members, ...b.members], hn };
  };

  const single = (item: NewsItem): Cluster => ({
    survivor: item,
    members: [{ source: item.source, key: urlKey(item.url), words: titleWords(item.title) }],
    hn: hnThread(item),
  });

  // 1. One copy per (url, source) first. That pair is a row's identity: two
  //    copies of one row in an upsert batch would fail the whole batch.
  const rows: Cluster[] = [];
  const rowIndex = new Map<string, number>();
  for (const item of items) {
    const id = `${item.source}\n${item.url}`;
    const i = rowIndex.get(id);
    if (i === undefined) {
      rowIndex.set(id, rows.length);
      rows.push(single(item));
    } else {
      rows[i] = join(rows[i], single(item));
    }
  }

  /**
   * Join units into stories. A unit matches a story sharing a URL key or, if
   * `byTitle`, one with another source's similar title, and can match
   * several: they are one story, where compatible. The first match wins
   * score ties.
   */
  const group = (units: Cluster[], byTitle: boolean): Cluster[] => {
    const clusters: (Cluster | undefined)[] = []; // undefined once joined into another
    for (const unit of units) {
      const hits: number[] = [];
      clusters.forEach((c, i) => {
        if (!c) return;
        const match = c.members.some((m) =>
          unit.members.some((u) =>
            u.key === m.key || (byTitle && u.source !== m.source && jaccardSimilarity(u.words, m.words) > 0.8)));
        if (match) hits.push(i);
      });

      let merged = unit;
      let index: number | undefined;
      for (const i of hits) {
        const c = clusters[i]!;
        if (!compatible(c, merged)) continue;
        if (index === undefined) {
          merged = join(c, merged);
          index = i;
        } else {
          merged = join(merged, c);
          clusters[i] = undefined;
        }
      }
      if (index === undefined) clusters.push(merged);
      else clusters[index] = merged;
    }
    return clusters.filter((c): c is Cluster => c !== undefined);
  };

  // 2. Rows into stories: every URL match first, then titles. A similar title
  //    taken first could claim a copy whose exact URL belongs to another story.
  const stories = group(group(rows, false), true);

  const result: NewsItem[] = [];
  for (const c of stories) {
    // An HN row's own thread stays; any other row takes the story's biggest
    if (c.hn && !hnThread(c.survivor)) c.survivor.metadata = { ...c.survivor.metadata, ...c.hn };
    result.push(c.survivor);
  }

  const removed = items.length - result.length;
  if (removed > 0) {
    log.info(`Deduplication: removed ${removed} duplicates (${items.length} -> ${result.length})`);
  }

  return result;
}
