/**
 * HuggingFace collector.
 * - daily_papers: HuggingFace daily papers API.
 * - trending_spaces: HuggingFace trending spaces API.
 */

import { createLogger } from '../utils/logger.js';
import { filterRecentItems } from '../utils/date-filter.js';
import { fetchJson } from '../utils/http.js';
import type { NewsItem, SourceConfig } from './types.js';

const log = createLogger('huggingface');

/**
 * One entry of /api/daily_papers. Engagement sits on `paper` (`upvotes`);
 * there is no `numLikes` field, which the collector used to read, so every
 * paper was stored with 0 likes.
 */
interface HFPaper {
  paper: {
    id: string;
    title: string;
    summary?: string;
    authors?: { name: string }[];
    publishedAt?: string;
    upvotes?: number;
    githubRepo?: string;
    githubStars?: number;
    projectPage?: string;
    submittedOnDailyAt?: string;
  };
  numComments?: number;
  organization?: { name?: string; fullname?: string };
}

/**
 * One entry of /api/spaces. The plain listing returns only `_id, id, likes,
 * trendingScore, createdAt, sdk, tags, private`. `author`, `cardData` and
 * `lastModified` appear only when the URL asks for them with
 * `expand[]=author&expand[]=cardData&expand[]=lastModified`.
 */
interface HFSpace {
  id: string;        // e.g. "user/space-name"
  likes?: number;
  trendingScore?: number;
  createdAt?: string;
  sdk?: string;
  author?: string;
  cardData?: {
    title?: string;
    short_description?: string;
  };
}

/**
 * Collect daily papers from HuggingFace API.
 */
export async function collectHFDailyPapers(source: SourceConfig): Promise<NewsItem[]> {
  log.info(`Fetching HuggingFace daily papers: ${source.name}`);

  try {
    const papers = await fetchJson<HFPaper[]>(source.url);
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
          score: p.upvotes ?? 0,
          summary: p.summary?.slice(0, 500),
          authors: p.authors?.map((a) => a.name).join(', '),
          tags: source.tags,
          fetchedAt: now,
          publishedAt: p.publishedAt,
          metadata: {
            arxivId: p.id,
            upvotes: p.upvotes ?? 0,
            numComments: entry.numComments ?? 0,
            githubRepo: p.githubRepo,
            githubStars: p.githubStars,
            projectPage: p.projectPage,
            organization: entry.organization?.fullname ?? entry.organization?.name,
            submittedOnDailyAt: p.submittedOnDailyAt,
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
    const spaces = await fetchJson<HFSpace[]>(source.url);
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
          // When the Space was created. With no date at all the 7-day filter
          // let every Space through, and recency scored it as brand new on
          // every run. `lastModified` (when expanded) moves on every commit, so
          // it would make old Spaces look new too.
          publishedAt: space.createdAt,
          metadata: {
            spaceId: space.id,
            sdk: space.sdk,
            trendingScore: space.trendingScore,
            likes: space.likes ?? 0,
            createdAt: space.createdAt,
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
