/**
 * Supabase client — upsert news items and cleanup old entries.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from './logger.js';
import { CARRIED_SIGNALS, mergeCoverage, type Coverage } from './dedup.js';
import type { NewsItem } from '../collectors/types.js';

const log = createLogger('supabase');

let client: SupabaseClient | null = null;

function getSupabaseClient(): SupabaseClient {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;

  if (!url || !key) {
    throw new Error(
      'Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables',
    );
  }

  client = createClient(url, key);
  return client;
}

const rowKey = (url: string, source: string) => `${source}\n${url}`;

/**
 * A PostgREST `in` list with every value quoted and escaped. supabase-js's
 * `.in()` quotes only values containing `,()` and escapes nothing, so a feed
 * URL with a `"` or `\` would break the whole request.
 */
export function postgrestInList(values: string[]): string {
  return `(${values.map((v) => `"${v.replace(/[\\"]/g, '\\$&')}"`).join(',')})`;
}

/** PostgREST's `db-max-rows`: a larger result is cut to this, with no error. */
const MAX_ROWS = 1000;

/**
 * The stored metadata of the rows these items will overwrite, keyed by
 * (url, source). Looked up by URL in chunks to keep the request line short.
 * Throws rather than return a partial map, since a missing entry means that
 * row's metadata is overwritten.
 */
async function loadStoredMetadata(
  sb: SupabaseClient,
  items: NewsItem[],
): Promise<Map<string, Record<string, unknown>>> {
  const stored = new Map<string, Record<string, unknown>>();
  const urls = [...new Set(items.map((i) => i.url))];
  const sources = [...new Set(items.map((i) => i.source))];
  const CHUNK = 40;

  for (let i = 0; i < urls.length; i += CHUNK) {
    const { data, error } = await sb
      .from('news_items')
      .select('url, source, metadata')
      .filter('url', 'in', postgrestInList(urls.slice(i, i + CHUNK)))
      .filter('source', 'in', postgrestInList(sources));
    if (error) throw new Error(error.message);
    if ((data?.length ?? 0) >= MAX_ROWS) throw new Error(`metadata lookup hit the ${MAX_ROWS}-row cap`);
    for (const row of data ?? []) stored.set(rowKey(row.url, row.source), row.metadata ?? {});
  }
  return stored;
}

/**
 * An upsert replaces `metadata` wholesale, and each run sees an item's other
 * copies only while they are still in their own feeds. Keep what earlier runs
 * recorded: the union of `coveredBy`, and any carried signal (e.g. HN points
 * on a press article) this run no longer has.
 */
export function mergeStoredMetadata(item: NewsItem, stored: Record<string, unknown> | undefined) {
  const meta: Record<string, unknown> = { ...item.metadata };
  if (!stored) return meta;

  for (const key of CARRIED_SIGNALS) {
    if (meta[key] === undefined && stored[key] !== undefined) meta[key] = stored[key];
  }
  const storedCoverage = Array.isArray(stored.coveredBy) ? (stored.coveredBy as Coverage[]) : [];
  const coverage = mergeCoverage(
    { source: item.source, url: item.url },
    storedCoverage,
    Array.isArray(meta.coveredBy) ? (meta.coveredBy as Coverage[]) : [],
  );
  if (coverage.length > 0) meta.coveredBy = coverage;
  return meta;
}

/**
 * The columns a collection run writes. An upsert updates only the columns it
 * sends, so anything left out here is never touched on an existing row:
 * fetched_at (kept from the first insert) and every `editor_*` column (written
 * once by the AI editor, src/editor/). Listing the columns, rather than
 * spreading the item, is what keeps it that way.
 */
export function toUpsertRow(item: NewsItem, stored: Record<string, unknown> | undefined) {
  return {
    title: item.title,
    url: item.url,
    source: item.source,
    source_category: item.sourceCategory,
    score: item.score,
    summary: item.summary ?? null,
    authors: item.authors ?? null,
    tags: item.tags,
    published_at: item.publishedAt ?? null,
    metadata: mergeStoredMetadata(item, stored),
  };
}

/**
 * Upsert news items into the news_items table.
 * Uses (url, source) composite unique constraint.
 *
 * fetched_at is omitted from the upsert payload so:
 * - New rows get fetched_at = DEFAULT NOW() from the DB
 * - Existing rows preserve their original fetched_at
 * This prevents old items from appearing "new" on every collection run.
 *
 * metadata is merged with the stored row's (see mergeStoredMetadata). If the
 * stored metadata can't be read, existing rows are left as they are for this
 * run and only new items are inserted: overwriting them would erase the
 * coverage earlier runs recorded.
 */
export async function upsertNewsItems(items: NewsItem[]): Promise<number> {
  if (items.length === 0) return 0;

  const sb = getSupabaseClient();

  let stored: Map<string, Record<string, unknown>> | undefined;
  try {
    stored = await loadStoredMetadata(sb, items);
  } catch (err) {
    log.warn(`Could not read stored metadata, so only new items are added this run: ${(err as Error).message}`);
  }

  const rows = items.map((item) => toUpsertRow(item, stored?.get(rowKey(item.url, item.source))));

  const BATCH_SIZE = 500;
  let upserted = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { data, error } = await sb
      .from('news_items')
      .upsert(batch, { onConflict: 'url,source', ignoreDuplicates: !stored })
      .select('id');

    if (error) {
      failed += batch.length;
      log.error(`Upsert batch failed (offset ${i}, ${batch.length} items lost)`, error.message);
    } else {
      // Rows written; when only inserting, existing rows are skipped and not returned
      upserted += data?.length ?? 0;
    }
  }

  log.info(`Upserted ${upserted} items`);
  // After every batch has been tried, so one bad batch doesn't cost the others
  if (failed > 0) throw new Error(`${failed} of ${rows.length} items were not stored`);
  return upserted;
}

/**
 * Delete news items older than the given number of days.
 */
export async function deleteOldItems(days: number = 7): Promise<number> {
  const sb = getSupabaseClient();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await sb
    .from('news_items')
    .delete()
    .lt('fetched_at', cutoff)
    .select('id');

  if (error) {
    throw new Error(`Cleanup failed: ${error.message}`);
  }

  const deleted = data?.length ?? 0;
  log.info(`Deleted ${deleted} items older than ${days} days`);
  return deleted;
}
