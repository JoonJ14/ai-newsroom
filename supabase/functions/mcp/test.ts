/**
 * MCP Server manual harness: runs the real tool handlers against real
 * Supabase data, in Node, and prints each tool's text. Reads only.
 *
 * Usage: npx tsx supabase/functions/mcp/test.ts
 *
 * Reads with SUPABASE_ANON_KEY (public read), or SUPABASE_SERVICE_KEY if
 * that is what is set. The handlers are imported, not copied: a local copy
 * goes stale (this file once reported 6 tools after the server had 8).
 */

import 'dotenv/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { TOOLS } from './_shared/tools.ts';
import {
  handleCheckStatus, handleGetNewSince, handleGetSourceUpdates, handleGetTopPicks, handleGetTrending, handleSearch,
} from './_shared/handlers.ts';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL and SUPABASE_ANON_KEY (or SUPABASE_SERVICE_KEY)');
  process.exit(1);
}

// The handlers take the Deno build's client type; the Node client has the same API
const sb = createClient(SUPABASE_URL, SUPABASE_KEY) as unknown as Parameters<typeof handleCheckStatus>[0] & SupabaseClient;

function rule(title: string) {
  console.log(`\n${'━'.repeat(60)}\n${title}\n${'━'.repeat(60)}`);
}

async function run(title: string, fn: () => Promise<{ text: string }>) {
  rule(title);
  const started = Date.now();
  const res = await fn();
  console.log(res.text);
  console.log(`\n(${Date.now() - started} ms)`);
}

async function main() {
  console.log('AI Newsroom MCP Server — Tool Tests');
  console.log(`Testing against: ${SUPABASE_URL}`);

  rule('tools/list');
  for (const t of TOOLS) console.log(`  ${t.name}: ${Object.keys((t.inputSchema.properties ?? {}) as object).join(', ') || '(no parameters)'}`);

  await run('get_top_picks (last 24 hours)', () => handleGetTopPicks(sb, {}));
  await run('get_trending (min_importance 7)', () => handleGetTrending(sb, { min_importance: 7, limit: 10 }));
  await run('search "anthropic"', () => handleSearch(sb, { query: 'anthropic', limit: 10 }));
  await run('get_new_since (12 hours)', () => handleGetNewSince(sb, { since: new Date(Date.now() - 12 * 3600_000).toISOString(), limit: 10 }));
  await run('get_source_updates techcrunch_ai', () => handleGetSourceUpdates(sb, { source: 'techcrunch_ai', limit: 5 }));
  await run('check_status', () => handleCheckStatus(sb));

  console.log('\n✅ All tests complete.');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
