/**
 * Deduplication for news items.
 * Two items are duplicates if:
 * - URLs match (ignoring scheme, `www.` and a trailing slash), OR
 * - Title similarity > 0.8 (Jaccard similarity on word sets)
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
 * Comparison key for "same link". The query and fragment are kept: an HN text
 * post's only identity is `item?id=…`, and each release-notes bullet differs
 * only in its query. Stripping them merged unrelated items. Tracking
 * parameters are already gone (src/utils/normalize.ts).
 */
export function urlKey(url: string): string {
  try {
    const u = new URL(url);
    const host = u.host.toLowerCase().replace(/^www\./, '');
    return `${host}${u.pathname.replace(/\/+$/, '')}${u.search}${u.hash}`;
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

/**
 * Deduplicate items. When duplicates are found, keep the one with the higher
 * score and record the other in its `coveredBy`.
 */
export function deduplicateItems(items: NewsItem[]): NewsItem[] {
  if (items.length === 0) return [];

  // Index by URL key for fast lookup
  const urlMap = new Map<string, number>(); // URL key -> index in result
  const result: NewsItem[] = [];

  // Pre-compute word sets for title comparison
  const wordSets: Set<string>[] = [];

  // Survivors whose HN fields came from an absorbed copy, not their own source
  const carriedHN = new WeakSet<NewsItem>();

  /** Fold `dropped` into `survivor`: coverage, plus any signal it lacks. */
  const absorb = (survivor: NewsItem, dropped: NewsItem): NewsItem => {
    const meta: Record<string, unknown> = { ...survivor.metadata };
    const droppedMeta = dropped.metadata ?? {};

    const droppedPoints = droppedMeta.hnPoints;
    if (
      typeof droppedPoints === 'number' &&
      (meta.hnPoints === undefined ||
        (carriedHN.has(survivor) && droppedPoints > (meta.hnPoints as number)))
    ) {
      for (const key of HN_SIGNALS) meta[key] = droppedMeta[key];
      carriedHN.add(survivor);
    }
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
    return survivor;
  };

  /** Keep the higher-scoring copy at `index`, absorbing the other. */
  const merge = (index: number, item: NewsItem, itemWords: Set<string>) => {
    const existing = result[index];
    // Both URLs keep pointing at the merged row, so a third copy of either matches.
    urlMap.set(urlKey(item.url), index);
    if (item.score > existing.score) {
      wordSets[index] = itemWords;
      result[index] = absorb(item, existing);
    } else {
      absorb(existing, item);
    }
  };

  for (const item of items) {
    const key = urlKey(item.url);
    const itemWords = titleWords(item.title);

    // Check URL duplicate
    const existingUrlIdx = urlMap.get(key);
    if (existingUrlIdx !== undefined) {
      merge(existingUrlIdx, item, itemWords);
      continue;
    }

    // Check title similarity against existing items
    let isDup = false;

    for (let i = 0; i < result.length; i++) {
      if (jaccardSimilarity(itemWords, wordSets[i]) > 0.8) {
        merge(i, item, itemWords);
        isDup = true;
        break;
      }
    }

    if (!isDup) {
      urlMap.set(key, result.length);
      wordSets.push(itemWords);
      result.push(item);
    }
  }

  const removed = items.length - result.length;
  if (removed > 0) {
    log.info(`Deduplication: removed ${removed} duplicates (${items.length} -> ${result.length})`);
  }

  return result;
}
