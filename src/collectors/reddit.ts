/**
 * Reddit collector — fetches from public Reddit JSON API.
 */

import { createLogger } from '../utils/logger.js';
import { filterRecentItems } from '../utils/date-filter.js';
import type { NewsItem, SourceConfig } from './types.js';

const log = createLogger('reddit');

interface RedditPost {
  data: {
    title: string;
    url: string;
    permalink: string;
    selftext?: string;
    author: string;
    score: number;
    created_utc: number;
    is_self: boolean;
    num_comments: number;
    subreddit: string;
  };
}

interface RedditListing {
  data: {
    children: RedditPost[];
  };
}

export async function collectReddit(source: SourceConfig): Promise<NewsItem[]> {
  log.info(`Fetching Reddit: ${source.name} (${source.url})`);

  try {
    const res = await fetch(source.url, {
      headers: {
        'User-Agent': 'ai-newsroom:0.1 (by /u/ai-newsroom-bot)',
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }

    const listing = (await res.json()) as RedditListing;
    const now = new Date().toISOString();
    const maxItems = source.maxItems ?? 20;

    const items: NewsItem[] = listing.data.children
      .slice(0, maxItems)
      .map((post) => {
        const d = post.data;
        // For self posts, link to the Reddit thread; for link posts, use the external URL
        const itemUrl = d.is_self
          ? `https://www.reddit.com${d.permalink}`
          : d.url;

        return {
          title: d.title,
          url: itemUrl,
          source: source.id,
          sourceCategory: source.category,
          score: d.score,
          summary: d.selftext?.slice(0, 500) || undefined,
          authors: `u/${d.author}`,
          tags: source.tags,
          fetchedAt: now,
          publishedAt: new Date(d.created_utc * 1000).toISOString(),
          metadata: {
            subreddit: d.subreddit,
            numComments: d.num_comments,
            redditPermalink: `https://www.reddit.com${d.permalink}`,
          },
        };
      });

    const recent = filterRecentItems(items);
    log.info(`Collected ${recent.length} items from ${source.name} (${items.length - recent.length} filtered by date)`);
    return recent;
  } catch (err) {
    log.error(`Failed to fetch Reddit for ${source.name}`, (err as Error).message);
    return [];
  }
}
