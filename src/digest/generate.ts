/**
 * Digest generator — the main entry point for daily AI news briefings.
 *
 * Usage:
 *   npm run digest              # Generate and send digest
 *   npm run digest -- --dry-run # Print to stdout without sending
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { createLogger } from '../utils/logger.js';
import { buildSlottedDisplay } from '../utils/slots.js';
import type { NewsItem, SourceCategory } from '../collectors/types.js';
import { formatDigestMessage } from './format.js';
import { loadDigestConfig } from './config.js';
import { sendDiscordDigest } from './adapters/discord.js';
import { sendTelegramDigest } from './adapters/telegram.js';
import { sendSlackDigest } from './adapters/slack.js';
import { sendIMessageDigest } from './adapters/imessage.js';

const log = createLogger('digest');
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const LAST_DIGEST_PATH = resolve(__dirname, '../../.last-digest');

function getLastDigestTime(): string {
  if (existsSync(LAST_DIGEST_PATH)) {
    const ts = readFileSync(LAST_DIGEST_PATH, 'utf-8').trim();
    if (ts) return ts;
  }
  // Default: 24 hours ago
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

function saveLastDigestTime() {
  writeFileSync(LAST_DIGEST_PATH, new Date().toISOString(), 'utf-8');
}

async function generateAISummary(items: NewsItem[]): Promise<string | undefined> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return undefined;

  log.info('Generating AI summary via Claude API...');

  // Build a compact list of titles for the prompt
  const titles = items
    .slice(0, 30)
    .map((i) => `- [${i.source}] ${i.title}`)
    .join('\n');

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [
          {
            role: 'user',
            content: `You are an AI news analyst. Given these top AI news items from the last 24 hours, write a 2-3 sentence executive summary of the most important developments. Be specific about company names and what happened. No preamble.\n\n${titles}`,
          },
        ],
      }),
    });

    if (!res.ok) {
      log.warn(`Claude API returned ${res.status}, skipping AI summary`);
      return undefined;
    }

    const data = (await res.json()) as {
      content: Array<{ type: string; text: string }>;
    };
    return data.content[0]?.text;
  } catch (err) {
    log.warn('AI summary generation failed', (err as Error).message);
    return undefined;
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const startTime = Date.now();

  log.info(`Starting digest generation${dryRun ? ' (dry run)' : ''}`);

  // Load config (skip validation in dry-run mode)
  let adapter = 'discord';
  if (!dryRun) {
    const config = loadDigestConfig();
    adapter = config.adapter;
  }

  // Connect to Supabase
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  }
  const sb = createClient(supabaseUrl, supabaseKey);

  // Fetch items since last digest
  const since = getLastDigestTime();
  log.info(`Fetching items since ${since}`);

  const { data, error } = await sb
    .from('news_items')
    .select('*')
    .gt('fetched_at', since)
    .order('score', { ascending: false })
    .limit(500);

  if (error) throw new Error(`DB query failed: ${error.message}`);

  if (!data || data.length === 0) {
    const emptyMsg = '📭 No new AI news since your last digest. Quiet day!';
    log.info(emptyMsg);

    if (dryRun) {
      console.log('\n' + emptyMsg);
    } else {
      await sendToAdapter(adapter, emptyMsg);
      saveLastDigestTime();
    }
    return;
  }

  // Map DB rows to NewsItem
  const items: NewsItem[] = data.map((row) => ({
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

  log.info(`Fetched ${items.length} items since last digest`);

  // Build slotted display with tighter caps for human-readable digest
  const display = buildSlottedDisplay(items, {
    officialLimit: 10,
    communityLimit: 4,
    researchLimit: 3,
    industryLimit: 2,
    officialMaxPerSource: 3,
    communityMaxPerSource: 2,
    researchMaxPerSource: 2,
    industryMaxPerSource: 2,
  });

  // Optional AI summary
  const summary = await generateAISummary(items);

  // Format message
  const message = formatDigestMessage(display, summary);

  if (dryRun) {
    console.log('\n' + message);
    console.log(`\n--- Dry run complete. ${items.length} items, ${message.length} chars ---`);
  } else {
    await sendToAdapter(adapter, message);
    saveLastDigestTime();
    log.info(`Digest sent via ${adapter}`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log.info(`Done in ${elapsed}s`);
}

async function sendToAdapter(adapter: string, message: string) {
  switch (adapter) {
    case 'discord':
      return sendDiscordDigest(message);
    case 'telegram':
      return sendTelegramDigest(message);
    case 'slack':
      return sendSlackDigest(message);
    case 'imessage':
      return sendIMessageDigest(message);
    default:
      throw new Error(`Unknown adapter: ${adapter}`);
  }
}

main().catch((err) => {
  log.error('Digest generation failed', err);
  process.exit(1);
});
