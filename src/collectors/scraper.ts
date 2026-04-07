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
  anthropic_changelog: scrapeAnthropicChangelog,
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
  // Page lists newest first — cap at 5 items as a heuristic for recency
  // since date parsing from CSS class selectors is fragile
  const MAX_ITEMS = 5;

  $('a[href^="/news/"]').each((_i, el) => {
    if (items.length >= MAX_ITEMS) return false;

    const $el = $(el);
    const href = $el.attr('href');
    if (!href) return;

    const title =
      $el.find('h4').first().text().trim() ||
      $el.find('.PublicationList-module-scss-module__KxYrHG__title').text().trim() ||
      $el.find('span').filter(function() { return $(this).text().trim().length > 10; }).first().text().trim();
    if (!title) return;

    const url = `https://www.anthropic.com${href}`;

    // Avoid duplicates
    if (items.some((item) => item.url === url)) return;

    const summary = $el.find('p').first().text().trim() || undefined;
    const dateText = $el.find('time').first().text().trim();
    const publishedAt = dateText ? safeISODate(dateText) : undefined;

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
    });
  });

  return items;
}

/**
 * Scrape Anthropic's developer changelog page.
 * Each entry is a date heading followed by a ul with changelog items.
 */
function scrapeAnthropicChangelog(html: string, source: SourceConfig): NewsItem[] {
  const now = new Date().toISOString();
  const items: NewsItem[] = [];

  // Pattern: <div>Month DD, YYYY</div> followed by <ul>...</ul>
  const entryPattern = /<div>(\w+ \d{1,2}, \d{4})<\/div>.*?<ul[^>]*>(.*?)<\/ul>/gs;
  let match;

  while ((match = entryPattern.exec(html)) !== null) {
    const dateStr = match[1];
    const content = match[2];

    const publishedAt = safeISODate(dateStr);

    // Strip HTML tags to get plain text summary
    const text = content
      .replace(/<[^>]+>/g, ' ')
      .replace(/&#x27;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim();

    if (!text || text.length < 10) continue;

    // Use the first sentence as the title
    const titleEnd = text.indexOf('. ');
    const title = titleEnd > 0 && titleEnd < 120
      ? text.slice(0, titleEnd + 1)
      : text.slice(0, 120) + (text.length > 120 ? '...' : '');

    items.push({
      title: `[${dateStr}] ${title}`,
      url: `${source.url}#${dateStr.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      source: source.id,
      sourceCategory: source.category,
      score: 0,
      summary: text.slice(0, 500),
      tags: source.tags,
      fetchedAt: now,
      publishedAt,
    });
  }

  return items;
}

function safeISODate(input: string): string | undefined {
  const d = new Date(input);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}
