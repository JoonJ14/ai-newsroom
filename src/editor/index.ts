/**
 * The AI editor: judge each recently collected item once and store the
 * judgment in its row's `editor_*` columns. Nothing reads them yet; step 3 of
 * the ranking rebuild switches the digest over.
 *
 * Usage:
 *   npm run editor                 # judge unjudged items from the last 7 days
 *   npm run editor -- --days 3     # a shorter look-back
 *
 * Runs after collection in collect.yml, and on demand from editor-backfill.yml.
 * A failure here never affects collection: the workflow job is allowed to fail,
 * and unjudged items are retried on the next run. With no Anthropic credentials
 * at all, it logs a warning and exits 0. See docs/editor.md.
 */

import 'dotenv/config';
import { appendFileSync } from 'node:fs';
import { createLogger } from '../utils/logger.js';
import { apiJudgeCall, authMode, AUTH_DESCRIPTIONS, createAnthropicClient, estimateCostUsd } from './client.js';
import { DEFAULT_DAYS, editorCaps, modelSettings } from './config.js';
import { fetchKnownStories, fetchUnjudged, loadSources, serviceClient, writeJudgments } from './db.js';
import { loadRubric, sourceNameMap } from './prompt.js';
import { runEditor } from './run.js';

const log = createLogger('editor');
const DAY_MS = 24 * 60 * 60 * 1000;

/** A GitHub Actions annotation when running there, a plain warning otherwise. */
function annotate(message: string) {
  if (process.env.GITHUB_ACTIONS) console.log(`::warning title=AI editor::${message}`);
  else log.warn(message);
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const started = Date.now();
  const days = Number(argValue('--days') ?? DEFAULT_DAYS);
  if (!Number.isFinite(days) || days <= 0) throw new Error('--days must be a positive number');

  const caps = editorCaps();
  const settings = modelSettings();
  const rubric = loadRubric();

  const mode = authMode();
  if (mode === 'none') {
    annotate('No Anthropic credentials (federation variables or ANTHROPIC_API_KEY); editor skipped.');
    return 0;
  }

  log.info(
    `Model ${settings.model} (effort ${settings.effort}), rubric ${rubric.version}, auth: ${AUTH_DESCRIPTIONS[mode]}`,
  );
  log.info(
    `Caps: ${caps.maxItems} items, ${caps.maxCalls} calls, ${caps.maxInputTokens} input tokens, ` +
      `batches of ${caps.batchSize}`,
  );

  const sb = serviceClient();
  const now = new Date();
  const from = new Date(now.getTime() - days * DAY_MS);
  const items = await fetchUnjudged(sb, from, now);
  log.info(`${items.length} unjudged item(s) fetched in the last ${days} day(s)`);
  if (items.length === 0) return 0;

  // Context: everything judged in the past 7 days, whatever this run's look-back
  const knownStories = await fetchKnownStories(sb, new Date(now.getTime() - DEFAULT_DAYS * DAY_MS), now);
  log.info(`${new Set(knownStories.map((s) => s.key)).size} known story key(s) as context`);

  const client = createAnthropicClient(mode);
  const judgedAt = now.toISOString();
  const writes = { written: 0, skipped: 0, failed: 0 };

  const result = await runEditor({
    items,
    knownStories,
    rubric,
    sourceNames: sourceNameMap(loadSources()),
    caps,
    call: apiJudgeCall(client, settings),
    now,
    onBatch: async (judgments) => {
      const w = await writeJudgments(sb, judgments, settings.model, rubric.version, judgedAt);
      writes.written += w.written;
      writes.skipped += w.skipped;
      writes.failed += w.failed;
    },
  });

  const u = result.usage;
  const cost = estimateCostUsd(settings.model, u);
  const tokens =
    `${u.inputTokens} input + ${u.cacheReadTokens} cache-read + ${u.cacheWriteTokens} cache-write, ` +
    `${u.outputTokens} output${cost !== null ? ` (~$${cost.toFixed(4)})` : ''}`;
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  log.info(
    `Done in ${elapsed}s: ${result.judgments.length} judged, ${writes.written} stored, ` +
      `${writes.skipped} already judged, ${writes.failed} write errors; ${result.rejected} rejected, ` +
      `${result.missingItems} left out, ${result.failedItems} in failed batches, ${result.skippedItems} over the caps`,
  );
  log.info(`Tokens: ${result.calls} call(s), ${tokens}`);
  if (result.stoppedBy) annotate(`Stopped at the ${result.stoppedBy} cap; ${result.skippedItems} item(s) wait for the next run.`);
  if (result.failedItems > 0) annotate(`${result.failedItems} item(s) were in batches that failed; retried next run.`);
  if (writes.failed > 0) annotate(`${writes.failed} judgment(s) could not be stored; retried next run.`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      [
        '### AI editor',
        '',
        '| | |',
        '|---|---|',
        `| Model | \`${settings.model}\`, rubric \`${rubric.version}\` |`,
        `| Auth | ${AUTH_DESCRIPTIONS[mode]} |`,
        `| Unjudged found | ${items.length} |`,
        `| Judged / stored | ${result.judgments.length} / ${writes.written} |`,
        `| Rejected / left out / failed / over caps | ${result.rejected} / ${result.missingItems} / ${result.failedItems} / ${result.skippedItems} |`,
        `| Calls | ${result.calls} |`,
        `| Tokens | ${tokens} |`,
        '',
      ].join('\n'),
    );
  }

  // Fail the step (not the workflow: the job may fail) only when nothing got through
  const nothingStored = result.calls > 0 && writes.written === 0 && writes.skipped === 0;
  return nothingStored ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    log.error('Editor failed', (err as Error).message);
    process.exit(1);
  });
