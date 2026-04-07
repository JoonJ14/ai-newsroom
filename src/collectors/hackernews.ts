/**
 * Hacker News collector.
 * - hackernews: Fetch top story IDs, then fetch each story detail.
 * - hackernews_algolia: Search via Algolia API (e.g. Show HN).
 */

import { createLogger } from '../utils/logger.js';
import { filterRecentItems } from '../utils/date-filter.js';
import type { NewsItem, SourceConfig } from './types.js';

const log = createLogger('hackernews');

const HN_ITEM_URL = 'https://hacker-news.firebaseio.com/v0/item';

interface HNItem {
  id: number;
  title?: string;
  url?: string;
  by?: string;
  score?: number;
  time?: number;
  type?: string;
  descendants?: number;
  text?: string;
}

interface AlgoliaHit {
  title: string;
  url: string | null;
  objectID: string;
  author: string;
  points: number | null;
  created_at: string;
  story_text?: string | null;
  num_comments: number | null;
}

interface AlgoliaResponse {
  hits: AlgoliaHit[];
}

/**
 * Standard HN collector — top stories from Firebase API.
 */
export async function collectHackerNews(source: SourceConfig): Promise<NewsItem[]> {
  log.info(`Fetching HN top stories: ${source.name}`);

  try {
    const res = await fetch(source.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const ids = (await res.json()) as number[];
    const maxItems = source.maxItems ?? 30;
    const topIds = ids.slice(0, maxItems);

    // Fetch story details in parallel (batched to avoid overwhelming the API)
    const BATCH_SIZE = 10;
    const stories: HNItem[] = [];

    for (let i = 0; i < topIds.length; i += BATCH_SIZE) {
      const batch = topIds.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (id) => {
          try {
            const r = await fetch(`${HN_ITEM_URL}/${id}.json`);
            return r.ok ? ((await r.json()) as HNItem) : null;
          } catch {
            return null;
          }
        }),
      );
      stories.push(...results.filter((s): s is HNItem => s !== null));
    }

    const now = new Date().toISOString();

    const items: NewsItem[] = stories
      .filter((s) => s.title && s.type === 'story')
      .map((s) => ({
        title: s.title!,
        url: s.url ?? `https://news.ycombinator.com/item?id=${s.id}`,
        source: source.id,
        sourceCategory: source.category,
        score: s.score ?? 0,
        summary: s.text?.slice(0, 500) || undefined,
        authors: s.by,
        tags: source.tags,
        fetchedAt: now,
        publishedAt: s.time ? new Date(s.time * 1000).toISOString() : undefined,
        metadata: {
          hnId: s.id,
          commentCount: s.descendants ?? 0,
          hnLink: `https://news.ycombinator.com/item?id=${s.id}`,
        },
      }));

    const recent = filterRecentItems(items);
    log.info(`Collected ${recent.length} HN stories from ${source.name} (${items.length - recent.length} filtered by date)`);
    return recent;
  } catch (err) {
    log.error(`Failed to fetch HN for ${source.name}`, (err as Error).message);
    return [];
  }
}

/**
 * HN Algolia collector — for search-based queries like Show HN.
 */
export async function collectHackerNewsAlgolia(source: SourceConfig): Promise<NewsItem[]> {
  log.info(`Fetching HN Algolia: ${source.name}`);

  try {
    // Replace NOW_MINUS_*H placeholders with actual timestamps
    const oneDayAgo = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
    const twoDaysAgo = Math.floor((Date.now() - 48 * 60 * 60 * 1000) / 1000);
    const url = source.url
      .replace('NOW_MINUS_24H', String(oneDayAgo))
      .replace('NOW_MINUS_48H', String(twoDaysAgo));

    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = (await res.json()) as AlgoliaResponse;
    const now = new Date().toISOString();

    const maxItems = source.maxItems ?? 30;

    const items: NewsItem[] = data.hits.slice(0, maxItems).map((hit) => ({
      title: hit.title,
      url: hit.url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`,
      source: source.id,
      sourceCategory: source.category,
      score: hit.points ?? 0,
      summary: hit.story_text?.slice(0, 500) || undefined,
      authors: hit.author,
      tags: source.tags,
      fetchedAt: now,
      publishedAt: hit.created_at,
      metadata: {
        hnId: hit.objectID,
        commentCount: hit.num_comments ?? 0,
        hnLink: `https://news.ycombinator.com/item?id=${hit.objectID}`,
      },
    }));

    const recent = filterRecentItems(items);
    log.info(`Collected ${recent.length} Algolia items from ${source.name} (${items.length - recent.length} filtered by date)`);
    return recent;
  } catch (err) {
    log.error(`Failed to fetch HN Algolia for ${source.name}`, (err as Error).message);
    return [];
  }
}
