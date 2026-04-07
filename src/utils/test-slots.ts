/**
 * Test script for slots-based display.
 * Fetches all items from Supabase, runs through buildSlottedDisplay, prints output.
 *
 * Usage: npx tsx src/utils/test-slots.ts
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { buildSlottedDisplay, formatSlottedDisplayAsText } from './slots.js';
import type { NewsItem, SourceCategory } from '../collectors/types.js';

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
    process.exit(1);
  }

  const sb = createClient(url, key);

  // Fetch all items, ordered by score descending
  const { data, error } = await sb
    .from('news_items')
    .select('*')
    .order('score', { ascending: false })
    .limit(500);

  if (error) {
    console.error('Failed to fetch items:', error.message);
    process.exit(1);
  }

  // Map DB rows back to NewsItem
  const items: NewsItem[] = (data ?? []).map((row) => ({
    id: row.id,
    title: row.title,
    url: row.url,
    source: row.source,
    sourceCategory: row.source_category as SourceCategory,
    score: row.score,
    summary: row.summary,
    authors: row.authors,
    tags: row.tags ?? [],
    fetchedAt: row.fetched_at,
    publishedAt: row.published_at,
    metadata: row.metadata,
  }));

  console.log(`\nFetched ${items.length} items from Supabase\n`);

  // Build slotted display
  const display = buildSlottedDisplay(items);
  const output = formatSlottedDisplayAsText(display);

  console.log(output);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
