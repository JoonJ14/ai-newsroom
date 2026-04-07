/**
 * Date filtering — skip items older than 7 days.
 * If publishedAt is missing, keep the item (assume recent).
 */

import type { NewsItem } from '../collectors/types.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export function filterRecentItems(items: NewsItem[]): NewsItem[] {
  const cutoff = Date.now() - SEVEN_DAYS_MS;

  return items.filter((item) => {
    if (!item.publishedAt) return true; // no date = assume recent
    const pubTime = new Date(item.publishedAt).getTime();
    return !isNaN(pubTime) && pubTime >= cutoff;
  });
}
