/**
 * HTML scraper collector — extracts news items from rendered web pages.
 * Uses cheerio for HTML parsing. Each source can define custom selectors
 * via metadata, or fall back to site-specific scrapers defined here.
 */

import * as cheerio from 'cheerio';
import { createLogger } from '../utils/logger.js';
import { filterRecentItems } from '../utils/date-filter.js';
import type { NewsItem, SourceConfig } from './types.js';

const log = createLogger('scraper');

/**
 * Site-specific scraping logic keyed by source ID.
 */
const SCRAPERS: Record<string, (html: string, source: SourceConfig) => NewsItem[]> = {
  anthropic_blog: scrapeAnthropicNews,
};

export async function collectHTMLScrape(source: SourceConfig): Promise<NewsItem[]> {
  log.info(`Scraping HTML: ${source.name} (${source.url})`);

  try {
    const res = await fetch(source.url, {
      headers: {
        'User-Agent': 'ai-newsroom/0.1 (+https://github.com/joonj14/ai-newsroom)',
        Accept: 'text/html',
      },
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

    const html = await res.text();
    const scraper = SCRAPERS[source.id];

    if (!scraper) {
      log.warn(`No scraper defined for source: ${source.id}`);
      return [];
    }

    const items = scraper(html, source);
    const maxItems = source.maxItems ?? 20;
    const result = items.slice(0, maxItems);

    const recent = filterRecentItems(result);
    log.info(`Collected ${recent.length} items from ${source.name} (${result.length - recent.length} filtered by date)`);
    return recent;
  } catch (err) {
    log.error(`Failed to scrape ${source.name}`, (err as Error).message);
    return [];
  }
}

/**
 * Scrape Anthropic's /news page.
 */
function scrapeAnthropicNews(html: string, source: SourceConfig): NewsItem[] {
  const $ = cheerio.load(html);
  const now = new Date().toISOString();
  const items: NewsItem[] = [];

  // Featured grid items (top section)
  $('a[href^="/news/"]').each((_i, el) => {
    const $el = $(el);
    const href = $el.attr('href');
    if (!href) return;

    const title =
      $el.find('h4').first().text().trim() ||
      $el.find('.PublicationList-module-scss-module__KxYrHG__title').text().trim();
    if (!title) return;

    const url = `https://www.anthropic.com${href}`;

    // Avoid duplicates
    if (items.some((item) => item.url === url)) return;

    const summary = $el.find('p').first().text().trim() || undefined;
    const dateText =
      $el.find('time').first().text().trim();
    const publishedAt = dateText ? safeISODate(dateText) : undefined;
    const category =
      $el.find('.caption.bold').first().text().trim() ||
      $el.find('.PublicationList-module-scss-module__KxYrHG__subject').text().trim() ||
      undefined;

    items.push({
      title,
      url,
      source: source.id,
      sourceCategory: source.category,
      score: 0,
      summary,
      tags: source.tags,
      fetchedAt: now,
      publishedAt,
      metadata: { category },
    });
  });

  return items;
}

function safeISODate(input: string): string | undefined {
  const d = new Date(input);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}
