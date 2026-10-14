/**
 * RSS/Atom feed collector. The feed is fetched with fetchText() and only parsed
 * by rss-parser: its own parseURL() leaves responses open (see src/utils/http.ts).
 */

import Parser from 'rss-parser';
import { createLogger } from '../utils/logger.js';
import { filterRecentItems } from '../utils/date-filter.js';
import { fetchText } from '../utils/http.js';
import type { NewsItem, SourceConfig } from './types.js';

const log = createLogger('rss');
const parser = new Parser();

function safeISODate(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const d = new Date(input);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

export async function collectRSS(source: SourceConfig): Promise<NewsItem[]> {
  log.info(`Fetching RSS: ${source.name} (${source.url})`);

  try {
    const xml = await fetchText(source.url, {
      headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
    });
    const feed = await parser.parseString(xml);
    const now = new Date().toISOString();
    const maxItems = source.maxItems ?? 30;

    const items: NewsItem[] = (feed.items ?? [])
      .slice(0, maxItems)
      .map((entry) => ({
        title: entry.title?.trim() ?? 'Untitled',
        url: entry.link ?? source.url,
        source: source.id,
        sourceCategory: source.category,
        score: 0,
        summary: entry.contentSnippet?.slice(0, 500) ?? entry.content?.slice(0, 500),
        authors: entry.creator ?? entry.author,
        tags: source.tags,
        fetchedAt: now,
        publishedAt: entry.isoDate ?? safeISODate(entry.pubDate),
      }));

    const recent = filterRecentItems(items);
    log.info(`Collected ${recent.length} items from ${source.name} (${items.length - recent.length} filtered by date)`);
    return recent;
  } catch (err) {
    log.error(`Failed to fetch RSS for ${source.name}`, (err as Error).message);
    return [];
  }
}
