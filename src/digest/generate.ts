/**
 * Digest generator — the main entry point for daily AI news briefings.
 *
 * Usage:
 *   npm run digest                                   # build, send, record in digest_state
 *   npm run digest -- --dry-run                      # the real window, printed, nothing sent or stored
 *   npm run digest -- --preview --date 2026-10-16    # a past 9:00 AM ET window, read-only
 *   … --layout plain|embeds                          # override DIGEST_LAYOUT
 *   … --text                                         # also print the Slack/Telegram/iMessage rendering
 *
 * The digest is built from the AI editor's stored judgments (docs/digest.md).
 * digest.yml runs the editor first, so the window is judged; if most of it
 * still isn't, the old ranking is used and the footer says so.
 *
 * --preview reads with SUPABASE_ANON_KEY and never sends or writes. --dry-run
 * needs the service key, to read digest_state.
 */

import 'dotenv/config';
import { appendFileSync } from 'node:fs';
import { createLogger } from '../utils/logger.js';
import type { NewsItem } from '../collectors/types.js';
import { loadSources, readClient, serviceClient } from '../editor/db.js';
import { sourceDirectory } from '../editor/select.js';
import { formatNy } from '../editor/window.js';
import { DIGEST_LAYOUTS, digestSettings, loadDigestConfig, type DigestLayout } from './config.js';
import { discordPayloads, renderText, type DigestDocument } from './render.js';
import { runDigest, type RunMode, type RunResult } from './run.js';
import { supabaseStore } from './store.js';
import { sendDiscordDigest } from './adapters/discord.js';
import { sendTelegramDigest } from './adapters/telegram.js';
import { sendSlackDigest } from './adapters/slack.js';
import { sendIMessageDigest } from './adapters/imessage.js';

const log = createLogger('digest');

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** A GitHub Actions annotation when running there, a plain warning otherwise. */
function annotate(message: string) {
  if (process.env.GITHUB_ACTIONS) console.log(`::warning title=Digest::${message}`);
  else log.warn(message);
}

/** Only the fallback (the old ranking) uses this, and only with ANTHROPIC_API_KEY set. */
async function generateAISummary(items: NewsItem[]): Promise<string | undefined> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return undefined;

  log.info('Generating AI summary via Claude API...');

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

async function sendToAdapter(adapter: string, doc: DigestDocument, layout: DigestLayout) {
  switch (adapter) {
    case 'discord':
      return sendDiscordDigest(doc, layout);
    case 'telegram':
      return sendTelegramDigest(renderText(doc));
    case 'slack':
      return sendSlackDigest(renderText(doc));
    case 'imessage':
      return sendIMessageDigest(renderText(doc));
    default:
      throw new Error(`Unknown adapter: ${adapter}`);
  }
}

function printDigest(result: RunResult, layout: DigestLayout, withText: boolean) {
  const rule = (title: string) => console.log(`\n${'━'.repeat(72)}\n${title}\n${'━'.repeat(72)}`);
  rule(
    `Digest for ${formatNy(result.window.to)} · window ${formatNy(result.window.from)} → ${formatNy(result.window.to)}\n` +
      `${result.mode === 'editor' ? 'AI editor' : result.mode}: ${result.judged}/${result.total} judged` +
      (result.repeats.length ? ` · left out as repeats: ${result.repeats.join(', ')}` : '') +
      (result.ledBefore.length ? `\nPrevious top stories: ${result.ledBefore.join(', ')}` : ''),
  );
  const payloads = discordPayloads(result.doc, layout);
  if (layout === 'plain') {
    payloads.forEach((p, i) => {
      console.log(`\n── Discord message ${i + 1} of ${payloads.length} (${p.content!.length} characters) ──\n`);
      console.log(p.content);
    });
  } else {
    payloads.forEach((p, i) => {
      const chars = (p.embeds ?? []).reduce((n, e) => n + e.title.length + e.description.length + (e.footer?.text.length ?? 0), 0);
      console.log(`\n── Discord message ${i + 1} of ${payloads.length}: ${p.embeds?.length ?? 0} embeds, ${chars} characters ──\n`);
      console.log(JSON.stringify(p, null, 2));
    });
  }
  if (withText) {
    rule('Plain-text rendering (Slack, Telegram, iMessage)');
    console.log(renderText(result.doc));
  }
}

async function main() {
  const preview = process.argv.includes('--preview');
  const dryRun = process.argv.includes('--dry-run');
  const mode: RunMode = preview ? 'preview' : dryRun ? 'dry-run' : 'send';
  const startTime = Date.now();

  const settings = digestSettings();
  const layoutArg = argValue('--layout');
  if (layoutArg && !(DIGEST_LAYOUTS as string[]).includes(layoutArg)) throw new Error('--layout must be plain or embeds');
  const layout = (layoutArg as DigestLayout | undefined) ?? settings.layout;
  for (const w of settings.warnings) annotate(w);

  const date = argValue('--date');
  if (preview && !date) throw new Error('--preview needs --date YYYY-MM-DD');

  log.info(`Starting digest (${mode}, ${layout} layout)`);

  // Validates the adapter's credentials; previews and dry runs send nothing
  const adapter = mode === 'send' ? loadDigestConfig().adapter : 'discord';
  const sources = loadSources();

  const result = await runDigest({
    mode,
    store: preview ? supabaseStore(readClient(), { readOnly: true }) : supabaseStore(serviceClient()),
    now: new Date(),
    date,
    settings,
    layout,
    sources,
    dir: sourceDirectory(sources),
    deliver: (doc, l) => sendToAdapter(adapter, doc, l),
    summarize: generateAISummary,
  });

  log.info(
    `Window ${result.window.from.toISOString()} → ${result.window.to.toISOString()}: ${result.total} items, ` +
      `${result.judged} judged, ${result.unjudged} not yet rated`,
  );
  if (result.mode === 'fallback') annotate(`AI editor unavailable, basic ranking used: ${result.reason}.`);
  if (result.repeats.length) log.info(`Left out, led the previous digest: ${result.repeats.join(', ')}`);

  if (mode === 'send') {
    log.info(`Digest sent via ${adapter}`);
  } else {
    printDigest(result, layout, process.argv.includes('--text'));
    console.log(`\n--- ${mode === 'preview' ? 'Preview' : 'Dry run'}: nothing sent, digest_state unchanged ---`);
  }

  if (process.env.GITHUB_STEP_SUMMARY && mode === 'send') {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      [
        '### Digest',
        '',
        '| | |',
        '|---|---|',
        `| Ranking | ${result.mode === 'fallback' ? `basic (fallback): ${result.reason}` : result.mode} |`,
        `| Layout | ${layout} |`,
        `| Items | ${result.total} (${result.judged} judged, ${result.unjudged} not yet rated) |`,
        `| Top stories | ${result.shown.top.join(', ') || '—'} |`,
        `| Repeats left out | ${result.repeats.join(', ') || '—'} |`,
        '',
      ].join('\n'),
    );
  }

  log.info(`Done in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  log.error('Digest generation failed', err);
  process.exit(1);
});
