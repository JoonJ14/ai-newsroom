/**
 * Supabase client — upsert news items and cleanup old entries.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from './logger.js';
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

/**
 * Upsert news items into the news_items table.
 * Uses (url, source) composite unique constraint for conflict resolution.
 */
export async function upsertNewsItems(items: NewsItem[]): Promise<number> {
  if (items.length === 0) return 0;

  const sb = getSupabaseClient();

  // Map from camelCase to snake_case DB columns
  const rows = items.map((item) => ({
    title: item.title,
    url: item.url,
    source: item.source,
    source_category: item.sourceCategory,
    score: item.score,
    summary: item.summary ?? null,
    authors: item.authors ?? null,
    tags: item.tags,
    fetched_at: item.fetchedAt,
    published_at: item.publishedAt ?? null,
    metadata: item.metadata ?? {},
  }));

  // Upsert in batches of 500
  const BATCH_SIZE = 500;
  let upserted = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error, count } = await sb
      .from('news_items')
      .upsert(batch, { onConflict: 'url,source', ignoreDuplicates: false })
      .select('id');

    if (error) {
      log.error(`Upsert batch failed (offset ${i}, ${batch.length} items lost)`, error.message);
    } else {
      upserted += count ?? batch.length;
    }
  }

  log.info(`Upserted ${upserted} items`);
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
