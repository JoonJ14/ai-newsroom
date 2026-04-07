/**
 * HuggingFace collector.
 * - daily_papers: HuggingFace daily papers API.
 * - trending_spaces: HuggingFace trending spaces API.
 */

import { createLogger } from '../utils/logger.js';
import { filterRecentItems } from '../utils/date-filter.js';
import type { NewsItem, SourceConfig } from './types.js';

const log = createLogger('huggingface');

interface HFPaper {
  paper: {
    id: string;
    title: string;
    summary?: string;
    authors?: { name: string }[];
    publishedAt?: string;
  };
  numLikes?: number;
}

interface HFSpace {
  id: string;        // e.g. "user/space-name"
  cardData?: {
    title?: string;
    short_description?: string;
  };
  author?: string;
  likes?: number;
  trendingScore?: number;
  lastModified?: string;
  sdk?: string;
}

/**
 * Collect daily papers from HuggingFace API.
 */
export async function collectHFDailyPapers(source: SourceConfig): Promise<NewsItem[]> {
  log.info(`Fetching HuggingFace daily papers: ${source.name}`);

  try {
    const res = await fetch(source.url, {
      headers: {
        'User-Agent': 'ai-newsroom/0.1',
        Accept: 'application/json',
      },
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

    const papers = (await res.json()) as HFPaper[];
    const now = new Date().toISOString();
    const maxItems = source.maxItems ?? 20;

    const items: NewsItem[] = papers
      .slice(0, maxItems)
      .map((entry) => {
        const p = entry.paper;
        return {
          title: p.title,
          url: `https://huggingface.co/papers/${p.id}`,
          source: source.id,
          sourceCategory: source.category,
          score: entry.numLikes ?? 0,
          summary: p.summary?.slice(0, 500),
          authors: p.authors?.map((a) => a.name).join(', '),
          tags: source.tags,
          fetchedAt: now,
          publishedAt: p.publishedAt,
          metadata: {
            arxivId: p.id,
            likes: entry.numLikes ?? 0,
          },
        };
      });

    const recent = filterRecentItems(items);
    log.info(`Collected ${recent.length} papers from ${source.name} (${items.length - recent.length} filtered by date)`);
    return recent;
  } catch (err) {
    log.error(`Failed to fetch HF daily papers for ${source.name}`, (err as Error).message);
    return [];
  }
}

/**
 * Collect trending spaces from HuggingFace API.
 */
export async function collectHFTrendingSpaces(source: SourceConfig): Promise<NewsItem[]> {
  log.info(`Fetching HuggingFace trending spaces: ${source.name}`);

  try {
    const res = await fetch(source.url, {
      headers: {
        'User-Agent': 'ai-newsroom/0.1',
        Accept: 'application/json',
      },
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

    const spaces = (await res.json()) as HFSpace[];
    const now = new Date().toISOString();
    const maxItems = source.maxItems ?? 20;

    const items: NewsItem[] = spaces
      .slice(0, maxItems)
      .map((space) => {
        const title = space.cardData?.title ?? space.id.split('/').pop() ?? space.id;

        return {
          title,
          url: `https://huggingface.co/spaces/${space.id}`,
          source: source.id,
          sourceCategory: source.category,
          score: space.likes ?? 0,
          summary: space.cardData?.short_description,
          authors: space.author ?? space.id.split('/')[0],
          tags: source.tags,
          fetchedAt: now,
          publishedAt: space.lastModified,
          metadata: {
            spaceId: space.id,
            sdk: space.sdk,
            trendingScore: space.trendingScore,
            likes: space.likes ?? 0,
          },
        };
      });

    const recent = filterRecentItems(items);
    log.info(`Collected ${recent.length} spaces from ${source.name} (${items.length - recent.length} filtered by date)`);
    return recent;
  } catch (err) {
    log.error(`Failed to fetch HF trending spaces for ${source.name}`, (err as Error).message);
    return [];
  }
}
