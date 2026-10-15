/**
 * Collector orchestrator.
 * Loads sources.yaml, dispatches to the correct collector, upserts to Supabase, cleans up old items.
 *
 * Usage:
 *   npm run collect                     # Run all enabled sources
 *   npm run collect -- --source reddit_claudeai  # Run a single source
 */

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYAML } from 'yaml';
import { createLogger } from '../utils/logger.js';
import { upsertNewsItems, deleteOldItems } from '../utils/supabase.js';
import { collectRSS } from './rss.js';
import { collectReddit } from './reddit.js';
import { collectHackerNews, collectHackerNewsAlgolia } from './hackernews.js';
import { collectGitHubReleases, collectGitHubTrending } from './github.js';
import { collectHFDailyPapers, collectHFTrendingSpaces } from './huggingface.js';
import { collectHTMLScrape } from './scraper.js';
import { computeRelevanceScore } from '../utils/scoring.js';
import { deduplicateItems } from '../utils/dedup.js';
import { filterRecentItems } from '../utils/date-filter.js';
import { isAIRelevant } from '../utils/relevance-filter.js';
import { fetchJson } from '../utils/http.js';
import { normalizeItem } from '../utils/normalize.js';
import type { NewsItem, SourceConfig, SourcesConfig } from './types.js';

const log = createLogger('orchestrator');

/**
 * The Actions job has 10 minutes in all. Each request has a deadline, but in a
 * broad outage every source could run to its deadline one after another, and
 * the job would be killed before anything was stored. Once this budget is
 * spent, the remaining sources are skipped and what was collected is stored.
 */
const COLLECTION_BUDGET_MS = 5 * 60_000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function loadSources(): SourceConfig[] {
  const configPath = resolve(__dirname, '../../config/sources.yaml');
  const raw = readFileSync(configPath, 'utf-8');
  const config: SourcesConfig = parseYAML(raw);
  return config.sources;
}

/**
 * Dispatch a single source to its collector.
 */
async function collectSource(source: SourceConfig): Promise<NewsItem[]> {
  switch (source.type) {
    case 'rss':
      return collectRSS(source);

    case 'reddit':
      return collectReddit(source);

    case 'hackernews':
      return collectHackerNews(source);

    case 'hackernews_algolia':
      return collectHackerNewsAlgolia(source);

    case 'github_releases':
      return collectGitHubReleases(source);

    case 'github_trending':
      return collectGitHubTrending(source);

    case 'json_api':
      // Route json_api sources to the right collector based on source id
      if (source.id.startsWith('hf_daily_papers') || source.url.includes('daily_papers')) {
        return collectHFDailyPapers(source);
      }
      if (source.id.startsWith('hf_trending_spaces') || source.url.includes('/spaces')) {
        return collectHFTrendingSpaces(source);
      }
      if (source.url.includes('dev.to')) {
        return collectDevTo(source);
      }
      log.warn(`No handler for json_api source: ${source.id}`);
      return [];

    case 'html_scrape':
      return collectHTMLScrape(source);

    default:
      log.warn(`Unknown collector type "${source.type}" for source ${source.id}`);
      return [];
  }
}

/**
 * Dev.to API collector (json_api type).
 */
async function collectDevTo(source: SourceConfig): Promise<NewsItem[]> {
  log.info(`Fetching Dev.to: ${source.name}`);

  try {
    const articles = await fetchJson<Array<{
      title: string;
      url: string;
      description?: string;
      user?: { username: string };
      public_reactions_count?: number;
      published_at?: string;
      tag_list?: string[];
    }>>(source.url);

    const now = new Date().toISOString();
    const maxItems = source.maxItems ?? 15;

    const items: NewsItem[] = articles.slice(0, maxItems).map((a) => ({
      title: a.title,
      url: a.url,
      source: source.id,
      sourceCategory: source.category,
      score: a.public_reactions_count ?? 0,
      summary: a.description?.slice(0, 500),
      authors: a.user?.username,
      tags: source.tags,
      fetchedAt: now,
      publishedAt: a.published_at,
      // `score` is replaced by the relevance score before storage
      metadata: { reactions: a.public_reactions_count ?? 0 },
    }));

    const recent = filterRecentItems(items);
    log.info(`Collected ${recent.length} items from ${source.name} (${items.length - recent.length} filtered by date)`);
    return recent;
  } catch (err) {
    log.error(`Failed to fetch Dev.to for ${source.name}`, (err as Error).message);
    return [];
  }
}

/**
 * Main entry point — run all (or a single) collector, upsert results, cleanup.
 */
async function main() {
  const startTime = Date.now();
  log.info('Starting collection run');

  // Parse --source flag
  const sourceArg = process.argv.find((_, i, arr) => arr[i - 1] === '--source');

  const allSources = loadSources();
  let sources: SourceConfig[];

  if (sourceArg) {
    const match = allSources.find((s) => s.id === sourceArg);
    if (!match) {
      log.error(`Source "${sourceArg}" not found in sources.yaml`);
      log.info(`Available sources: ${allSources.map((s) => s.id).join(', ')}`);
      process.exit(1);
    }
    sources = [match];
    log.info(`Running single source: ${sourceArg}`);
  } else {
    sources = allSources.filter((s) => s.enabled);
    log.info(`Running ${sources.length} enabled sources (${allSources.length} total)`);
  }

  // Collect from all sources, one at a time to be polite to APIs
  const allItems: NewsItem[] = [];
  const results: { source: string; count: number; error?: string }[] = [];

  for (const source of sources) {
    if (Date.now() - startTime >= COLLECTION_BUDGET_MS) {
      const msg = 'skipped, collection time budget used up';
      log.error(`Source ${source.id} ${msg}`);
      results.push({ source: source.id, count: 0, error: msg });
      continue;
    }
    try {
      // Entities, whitespace and tracking parameters, for every collector.
      // These collectors read pages with cheerio, which has already decoded the
      // text. Feed text is decoded again on purpose: feeds such as The Verge's
      // encode entities twice, so titles still carry "&#8217;" after XML
      // parsing. A literal entity in a feed title looks the same and is rarer.
      const decoded = source.type === 'html_scrape' || source.type === 'github_trending';
      const items = (await collectSource(source)).map((item) => normalizeItem(item, { decoded }));
      allItems.push(...items);
      results.push({ source: source.id, count: items.length });
    } catch (err) {
      const msg = (err as Error).message;
      log.error(`Source ${source.id} failed completely`, msg);
      results.push({ source: source.id, count: 0, error: msg });
    }
  }

  log.info(`Collection complete: ${allItems.length} total items from ${sources.length} sources`);

  // Print per-source summary
  for (const r of results) {
    const status = r.error
      ? `FAILED: ${r.error}`
      : r.count === 0
        ? '0 items (check logs for errors)'
        : `${r.count} items`;
    log.info(`  ${r.source}: ${status}`);
  }

  // AI relevance filtering (only for sources without skipRelevanceFilter)
  const sourceMap = new Map(allSources.map((s) => [s.id, s]));
  const relevanceFiltered: NewsItem[] = [];
  const filterStats = new Map<string, { before: number; after: number }>();

  for (const item of allItems) {
    const src = sourceMap.get(item.source);
    if (!filterStats.has(item.source)) {
      filterStats.set(item.source, { before: 0, after: 0 });
    }
    const stats = filterStats.get(item.source)!;
    stats.before++;

    if (src?.skipRelevanceFilter || isAIRelevant(item)) {
      relevanceFiltered.push(item);
      stats.after++;
    }
  }

  // Log relevance filtering stats per source
  let totalFiltered = 0;
  for (const [sourceId, stats] of filterStats) {
    const removed = stats.before - stats.after;
    if (removed > 0) {
      log.info(`  Relevance filter: ${sourceId} — removed ${removed}/${stats.before} non-AI items`);
      totalFiltered += removed;
    }
  }
  log.info(`Relevance filtering: ${allItems.length} -> ${relevanceFiltered.length} (${totalFiltered} non-AI items removed)`);

  // Compute relevance scores
  for (const item of relevanceFiltered) {
    const src = sourceMap.get(item.source);
    if (src) {
      const relevanceScore = computeRelevanceScore(
        item,
        src.type,
        src.category,
        src.id,
        src.sourceTier,
        src.scoreFloor,
      );
      item.score = relevanceScore;
      item.metadata = { ...item.metadata, relevanceScore };
    }
  }
  log.info(`Computed relevance scores for ${relevanceFiltered.length} items`);

  // Deduplicate
  const beforeDedup = relevanceFiltered.length;
  const dedupedItems = deduplicateItems(relevanceFiltered);
  log.info(`After dedup: ${dedupedItems.length} items (${beforeDedup - dedupedItems.length} duplicates removed)`);

  // Show top 15 by relevance score
  const top15 = [...dedupedItems]
    .sort((a, b) => (b.metadata?.relevanceScore as number ?? 0) - (a.metadata?.relevanceScore as number ?? 0))
    .slice(0, 15);
  log.info('Top 15 items by relevance:');
  for (const item of top15) {
    log.info(`  [${item.metadata?.relevanceScore}] ${item.source}: ${item.title}`);
  }

  // Upsert to Supabase
  if (dedupedItems.length > 0) {
    try {
      const upserted = await upsertNewsItems(dedupedItems);
      log.info(`Upserted ${upserted} items to database`);
    } catch (err) {
      log.error('Failed to upsert items to database', (err as Error).message);
      // Fail the Actions run: lost items must not pass as a green run
      process.exitCode = 1;
    }
  }

  // Cleanup old items
  try {
    const deleted = await deleteOldItems(90);
    log.info(`Cleanup: removed ${deleted} items older than 90 days`);
  } catch (err) {
    log.error('Cleanup failed', (err as Error).message);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log.info(`Done in ${elapsed}s`);
}

main()
  .then(() => {
    // Backstop only. Every HTTP response is read or cancelled (src/utils/http.ts),
    // so nothing should keep the process alive after "Done". If something does,
    // say what it is and exit, rather than hold the Actions job open until its
    // timeout. unref() lets a clean run exit without waiting for this timer.
    setTimeout(() => {
      log.warn(`Still running 15s after Done. Open resources: ${process.getActiveResourcesInfo().join(', ')}. Exiting.`);
      process.exit(); // keeps process.exitCode, set if the upsert failed
    }, 15_000).unref();
  })
  .catch((err) => {
    log.error('Fatal error', err);
    process.exit(1);
  });
