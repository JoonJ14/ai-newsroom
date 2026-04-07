/**
 * Deduplication for news items.
 * Two items are duplicates if:
 * - URLs match (after stripping trailing slashes and query params), OR
 * - Title similarity > 0.8 (Jaccard similarity on word sets)
 */

import { createLogger } from './logger.js';
import type { NewsItem } from '../collectors/types.js';

const log = createLogger('dedup');

/**
 * Normalize a URL for comparison: strip trailing slash and query params.
 */
function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return (u.origin + u.pathname).replace(/\/+$/, '');
  } catch {
    return url.replace(/\?.*$/, '').replace(/\/+$/, '');
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

/**
 * Deduplicate items. When duplicates are found, keep the one with the higher score.
 */
export function deduplicateItems(items: NewsItem[]): NewsItem[] {
  if (items.length === 0) return [];

  // Index by normalized URL for fast lookup
  const urlMap = new Map<string, number>(); // normalized URL -> index in result
  const result: NewsItem[] = [];

  // Pre-compute word sets for title comparison
  const wordSets: Set<string>[] = [];

  for (const item of items) {
    const normUrl = normalizeUrl(item.url);

    // Check URL duplicate
    const existingUrlIdx = urlMap.get(normUrl);
    if (existingUrlIdx !== undefined) {
      // Keep the higher-scoring one
      if (item.score > result[existingUrlIdx].score) {
        result[existingUrlIdx] = item;
      }
      continue;
    }

    // Check title similarity against existing items
    const itemWords = titleWords(item.title);
    let isDup = false;

    for (let i = 0; i < result.length; i++) {
      if (jaccardSimilarity(itemWords, wordSets[i]) > 0.8) {
        // Keep the higher-scoring one
        if (item.score > result[i].score) {
          urlMap.delete(normalizeUrl(result[i].url));
          urlMap.set(normUrl, i);
          wordSets[i] = itemWords;
          result[i] = item;
        }
        isDup = true;
        break;
      }
    }

    if (!isDup) {
      urlMap.set(normUrl, result.length);
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
