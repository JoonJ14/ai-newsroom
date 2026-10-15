/**
 * Date filtering — skip items older than 7 days.
 * If publishedAt is missing, keep the item (assume recent).
 */

import type { NewsItem } from '../collectors/types.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * `slackMs` widens the window. Scrapers that only know a calendar date use it
 * to pick which items are worth reading for an exact time (src/collectors/scraper.ts).
 */
export function filterRecentItems(items: NewsItem[], slackMs = 0): NewsItem[] {
  const cutoff = Date.now() - SEVEN_DAYS_MS - slackMs;

  return items.filter((item) => {
    if (!item.publishedAt) return true; // no date = assume recent
    const pubTime = new Date(item.publishedAt).getTime();
    return !isNaN(pubTime) && pubTime >= cutoff;
  });
}
