/**
 * HTML scraper collector — extracts news items from rendered web pages.
 * Uses cheerio for HTML parsing, with a site-specific scraper per source ID.
 *
 * A source can list `extraUrls` in sources.yaml; each page is parsed by the
 * same scraper and the results are merged by URL.
 */

import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { createLogger } from '../utils/logger.js';
import { filterRecentItems } from '../utils/date-filter.js';
import { fetchText } from '../utils/http.js';
import { collapseText } from '../utils/normalize.js';
import type { NewsItem, SourceConfig } from './types.js';

const log = createLogger('scraper');

/** A parsed DOM node, as cheerio's own functions take it (domhandler isn't a direct dependency). */
type AnyNode = Parameters<typeof cheerio.contains>[1];

interface SiteScraper {
  /** Parse one listing page into items. */
  parse: (html: string, source: SourceConfig, pageUrl: string) => NewsItem[];
  /** Optionally fill in details from each item's own page (runs only for recent items). */
  enrich?: (item: NewsItem) => Promise<void>;
}

/**
 * Site-specific scraping logic keyed by source ID.
 */
const SCRAPERS: Record<string, SiteScraper> = {
  anthropic_blog: { parse: scrapeAnthropicListing, enrich: enrichAnthropicItem },
  anthropic_changelog: { parse: scrapeAnthropicChangelog },
  xai_blog: { parse: scrapeXAINews },
};

const ENRICH_CONCURRENCY = 4;

/** A page shorter than this is too small to judge: an error stub or a redirect page. */
const MIN_LISTING_CHARS = 1_000;

/**
 * The warning for a listing page that loaded but gave no posts, which almost
 * always means its layout changed. Anthropic's did around 2026-10-19, and the
 * scraper found nothing for four weeks without a word
 * (docs/TROUBLESHOOTING.md). None when the page gave posts or is too small
 * to judge.
 */
export function emptyListingWarning(sourceName: string, pageUrl: string, html: string, found: number): string | undefined {
  if (found > 0 || html.length < MIN_LISTING_CHARS) return undefined;
  return `${sourceName}: ${pageUrl} loaded (${html.length} characters) but no posts were found on it. ` +
    'The page layout may have changed; check its scraper in src/collectors/scraper.ts.';
}

/** A GitHub Actions annotation when running there, a plain warning otherwise. Never fails the run. */
function annotate(message: string) {
  if (process.env.GITHUB_ACTIONS) console.log(`::warning title=Scraper::${message}`);
  else log.warn(message);
}

export async function collectHTMLScrape(source: SourceConfig): Promise<NewsItem[]> {
  const scraper = SCRAPERS[source.id];
  if (!scraper) {
    log.warn(`No scraper defined for source: ${source.id}`);
    return [];
  }

  const pages = [source.url, ...(source.extraUrls ?? [])];
  const byUrl = new Map<string, NewsItem>();
  let pagesOk = 0;

  for (const pageUrl of pages) {
    log.info(`Scraping HTML: ${source.name} (${pageUrl})`);
    try {
      const html = await fetchText(pageUrl, { headers: { Accept: 'text/html' }, timeoutMs: 30_000 });
      pagesOk++;
      const parsed = scraper.parse(html, source, pageUrl);
      const warning = emptyListingWarning(source.name, pageUrl, html, parsed.length);
      if (warning) annotate(warning);
      for (const item of parsed) {
        const seen = byUrl.get(item.url);
        if (!seen) byUrl.set(item.url, item);
        else if (!seen.summary && item.summary) seen.summary = item.summary;
      }
    } catch (err) {
      log.error(`Failed to scrape ${source.name} (${pageUrl})`, (err as Error).message);
    }
  }
  if (pagesOk === 0) return [];

  const maxItems = source.maxItems ?? 20;
  const result = [...byUrl.values()]
    .sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''))
    .slice(0, maxItems);

  const recent = scraper.enrich ? await enrichRecent(result, scraper.enrich) : filterRecentItems(result);

  log.info(`Collected ${recent.length} items from ${source.name} (${result.length - recent.length} filtered by date)`);
  return recent;
}

/**
 * A listing date is a calendar day, parsed as midnight UTC. The real publish
 * time is some time that day where the publisher is: in US Pacific time, up to
 * 32 hours after midnight UTC. Two days covers it.
 */
const LISTING_DATE_SLACK_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * Enrich, then apply the 7-day filter to the exact times enrichment found.
 * Filtering on the listing date first would drop an article from seven days
 * ago that is still inside the window by its real time. Items that can't be
 * read, or have no exact time, keep the listing date and are filtered on it.
 */
export async function enrichRecent(items: NewsItem[], enrich: (item: NewsItem) => Promise<void>): Promise<NewsItem[]> {
  const candidates = filterRecentItems(items, LISTING_DATE_SLACK_MS);
  for (let i = 0; i < candidates.length; i += ENRICH_CONCURRENCY) {
    await Promise.all(
      candidates.slice(i, i + ENRICH_CONCURRENCY).map((item) =>
        enrich(item).catch((err) => log.warn(`Could not read ${item.url}: ${(err as Error).message}`)),
      ),
    );
  }
  return filterRecentItems(candidates);
}

/**
 * Scrape Anthropic's /news or /research page.
 *
 * A post is a card with a date (`<time>`, "Nov 9, 2026"), a title and a link.
 * The markup has changed under us before, so cards are found from their
 * dates rather than from one expected shape:
 *
 * - **Since about 2026-10-19:** each card is an `<article>`. Its `<header>`
 *   holds a category link ("Announcements") and the `<time>`. The title is
 *   in a separate link wrapping the heading, and the image has a link of its
 *   own. No link contains the date.
 * - **Before:** each card was one `<a>` wrapping the date, the title (a
 *   heading, or a `…__title` span in the dated list) and the summary.
 *
 * From each `<time>`, walk up to the nearest element that also holds a title.
 * Give up if that element holds more than one date, which makes it a list of
 * cards rather than one card. The URL is the link wrapping the title (or the
 * card's own link, or failing those its first other link), never the category
 * link beside the date.
 *
 * Model and product launches sit at top-level paths such as
 * /claude-fable-and-mythos-5-2, so any dated card linking into anthropic.com
 * is collected, not only /news/ links. Undated cards (navigation, team links,
 * undated features) are skipped: they would look brand new on every run. The
 * featured card repeats an item from the list; the copies merge by URL.
 */
export function scrapeAnthropicListing(html: string, source: SourceConfig, pageUrl: string): NewsItem[] {
  const $ = cheerio.load(html);
  const now = new Date().toISOString();
  const byUrl = new Map<string, NewsItem>();
  const root = $('main').length ? $('main') : $('body');

  root.find('time').each((_i, timeEl) => {
    const $time = $(timeEl);
    const publishedAt = parseDayDate($time.text());
    if (!publishedAt) return;

    const card = cardOf($, $time);
    if (!card) return;
    const { $card, $title } = card;
    // The date's own line: category label(s) and the date. Never the URL or the summary.
    const meta = timeEl.parent;
    const outsideMeta = (el: AnyNode) => !meta || (el !== meta && !$.contains(meta, el));

    const href =
      $title.closest('a[href]').attr('href') ??
      $card.closest('a[href]').attr('href') ??
      $card.find('a[href]').filter((_j, a) => outsideMeta(a)).first().attr('href');
    if (!href) return;
    let url: URL;
    try {
      url = new URL(href, pageUrl);
    } catch {
      return;
    }
    if (!/(^|\.)anthropic\.com$/.test(url.hostname)) return;

    const title = collapseText($title.text());
    if (!title) return;

    const summary =
      collapseText($card.find('p').filter((_j, el) => outsideMeta(el) && collapseText($(el).text()) !== '').first().text()) ||
      undefined;
    const label = meta
      ? collapseText($(meta).find('a, span').filter((_j, el) => !$(el).is('time') && collapseText($(el).text()) !== '').first().text())
      : '';
    // Skips the site's own unfilled template placeholders, such as "[TeamName]"
    const category = label && !/^\[.*\]$/.test(label) ? label : undefined;

    const seen = byUrl.get(url.href);
    if (seen) {
      if (!seen.summary && summary) seen.summary = summary;
      return;
    }

    byUrl.set(url.href, {
      title,
      url: url.href,
      source: source.id,
      sourceCategory: source.category,
      score: 0,
      summary,
      tags: source.tags,
      fetchedAt: now,
      publishedAt,
      metadata: category ? { category } : undefined,
    });
  });

  return [...byUrl.values()];
}

const HEADINGS = 'h1, h2, h3, h4, h5, h6';
/** Titles that aren't headings: the old dated list's `…__title` spans, and the like. */
const TITLE_CLASSES = '[class*="__title"], [class*="Title"], [class*="-title"]';
/** How far above a date its card can start. The deepest seen is 3. */
const MAX_CARD_DEPTH = 8;

/** The card a `<time>` belongs to, and its title element; none if it isn't a single card's date. */
function cardOf($: cheerio.CheerioAPI, $time: cheerio.Cheerio<AnyNode>) {
  let $c = $time.parent();
  for (let depth = 0; depth < MAX_CARD_DEPTH && $c.length && !$c.is('main, body'); depth++, $c = $c.parent()) {
    if ($c.find('time').length > 1) return undefined;
    const $heading = $c.find(HEADINGS).first();
    const $title = $heading.length ? $heading : $c.find(TITLE_CLASSES).first();
    if ($title.length) return { $card: $c, $title };
  }
  return undefined;
}

/** The site-wide fallback some article pages carry instead of their own description. */
const ANTHROPIC_GENERIC_DESCRIPTION = /^Anthropic is an AI safety and research company\b/;

/**
 * Read an Anthropic article page for its description and exact publish time.
 * The listing gives only a calendar date and, for list items, no summary.
 * Summary, in order: the page's own meta description, the listing card's
 * text, the article's first paragraph. Model pages such as /claude-haiku-5-5
 * have no `article:published_time`, so they keep the listing's date.
 */
async function enrichAnthropicItem(item: NewsItem): Promise<void> {
  readAnthropicArticle(item, await fetchText(item.url, { headers: { Accept: 'text/html' }, timeoutMs: 15_000 }));
}

/** The parsing half of enrichAnthropicItem, given the article page's HTML. */
export function readAnthropicArticle(item: NewsItem, html: string): void {
  const $ = cheerio.load(html);

  const metaDescription = collapseText($('meta[name="description"]').attr('content') ?? '');
  const firstParagraph = $('main p[class*="reading-column"]')
    .map((_i, p) => collapseText($(p).text()))
    .get()
    .find((text) => text.length > 40);
  const summary =
    metaDescription && !ANTHROPIC_GENERIC_DESCRIPTION.test(metaDescription)
      ? metaDescription
      : item.summary ?? firstParagraph;
  if (summary) item.summary = summary.slice(0, 500);

  const published = safeISODate($('meta[property="article:published_time"]').attr('content') ?? '');
  if (published) item.publishedAt = published;
}

/**
 * Scrape the Claude Platform release notes
 * (platform.claude.com/docs/en/release-notes/overview).
 *
 * Each day is an `<h3 id="october-7-2026">` followed by a list, and each
 * bullet becomes its own item: one day can hold a model launch next to SDK
 * fixes (Oct 7, 2026 had eight bullets, one of them Claude Haiku 5.5).
 *
 * A bullet has no anchor of its own. Its URL is the page plus `?day=<day>`,
 * `&entry=<slug>` and `#<day>`, so the link opens at that day. The day is in
 * the query too because dedup ignores fragments (src/utils/dedup.ts), and the
 * same opening words on two days are two entries. The entry is a slug of the
 * bullet's first eight words, so an edit further into the text keeps the row's
 * identity. If another bullet that day starts with the same eight words, both
 * get a hash of their full text added: a numbered suffix would follow the
 * bullets' order, and a bullet added above would take an older one's row.
 * When a collision first appears, the older bullet moves to its hashed entry
 * once, leaving one stale row; an edit to a colliding bullet does the same.
 * Both need two bullets on one day sharing eight opening words, which is rare.
 */
export function scrapeAnthropicChangelog(html: string, source: SourceConfig, pageUrl: string): NewsItem[] {
  const $ = cheerio.load(html);
  const now = new Date().toISOString();
  const base = pageUrl.replace(/[?#].*$/, '');
  const items: NewsItem[] = [];

  $('h3[id]').each((_i, heading) => {
    const dayId = $(heading).attr('id')!;
    const m = /^([a-z]+)-(\d{1,2})-(\d{4})$/.exec(dayId);
    if (!m) return;
    const publishedAt = parseDayDate(`${m[1]} ${m[2]}, ${m[3]}`);
    if (!publishedAt) return;

    const bullets: string[] = [];
    $(heading)
      .nextUntil('h1, h2, h3')
      .filter('ul, ol')
      .children('li')
      .each((_j, li) => {
        // .text() runs block elements together ("model.Nested detail")
        $(li).find('p, div, ul, ol, li, br').before(' ').after(' ');
        const text = collapseText($(li).text());
        if (text.length >= 10) bullets.push(text);
      });

    const slugCounts = new Map<string, number>();
    for (const text of bullets) slugCounts.set(slugify(text), (slugCounts.get(slugify(text)) ?? 0) + 1);

    const slugsToday = new Set<string>();
    for (const text of bullets) {
      let slug = slugify(text);
      if (slugCounts.get(slug)! > 1) slug = `${slug}-${createHash('sha256').update(text).digest('hex').slice(0, 8)}`;
      // Only identical bullets are still equal, and those are interchangeable
      for (let n = 2, first = slug; slugsToday.has(slug); n++) slug = `${first}-${n}`;
      slugsToday.add(slug);

      items.push({
        title: firstSentence(text, 160),
        url: `${base}?day=${dayId}&entry=${slug}#${dayId}`,
        source: source.id,
        sourceCategory: source.category,
        score: 0,
        summary: text.slice(0, 500),
        tags: source.tags,
        fetchedAt: now,
        publishedAt,
      });
    }
  });

  return items;
}

/**
 * Scrape xAI news page at x.ai/news
 */
function scrapeXAINews(html: string, source: SourceConfig): NewsItem[] {
  const $ = cheerio.load(html);
  const now = new Date().toISOString();
  const items: NewsItem[] = [];
  const MAX_ITEMS = 5;

  $('a[href*="/news/"]').each((_i, el) => {
    if (items.length >= MAX_ITEMS) return false;
    const $el = $(el);
    const href = $el.attr('href');
    if (!href || href === '/news' || href === '/news/') return;

    const title =
      $el.find('h2, h3, h4, p').first().text().trim() ||
      $el.attr('aria-label')?.trim() ||
      $el.text().trim().split('\n')[0]?.trim();
    if (!title || title.length < 10) return;

    const url = href.startsWith('http') ? href : `https://x.ai${href}`;
    if (items.some((item) => item.url === url)) return;

    const dateText =
      $el.find('time').first().attr('datetime') ||
      $el.find('time').first().text().trim();
    const publishedAt = dateText ? safeISODate(dateText) : undefined;

    items.push({
      title,
      url,
      source: source.id,
      sourceCategory: source.category,
      score: 0,
      tags: source.tags,
      fetchedAt: now,
      publishedAt,
    });
  });

  return items;
}

function safeISODate(input: string): string | undefined {
  const d = new Date(input);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * "Oct 7, 2026" / "October 7, 2026" → midnight UTC that day. Parsed by hand
 * because `new Date("Oct 7, 2026")` uses the machine's local time zone.
 */
export function parseDayDate(text: string): string | undefined {
  const m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(text.trim());
  if (!m) return undefined;
  const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
  const day = Number(m[2]);
  if (month < 0) return undefined;
  const d = new Date(Date.UTC(Number(m[3]), month, day));
  return d.getUTCDate() === day ? d.toISOString() : undefined;
}

/** The first sentence of `text`, cut at a word boundary if longer than `max`. */
function firstSentence(text: string, max: number): string {
  const sentence = /^(.+?[.!?])(?=\s+[A-Z(`"“]|$)/.exec(text)?.[1] ?? text;
  const chars = Array.from(sentence); // code points, so an emoji is never split
  if (chars.length <= max) return sentence;
  const cut = chars.slice(0, max - 1).join(''); // room for the ellipsis
  const space = cut.lastIndexOf(' ');
  return `${space > 0 ? cut.slice(0, space) : cut}…`;
}

/** Lowercase slug of the first eight words. */
function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/['’]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(' ')
      .slice(0, 8)
      .join('-') || 'entry'
  );
}
