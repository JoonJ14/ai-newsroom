/**
 * The editor's run loop, shared by `npm run editor` (which stores each batch's
 * judgments as it goes) and the preview's --dry-run (which keeps them in
 * memory). No database or network access of its own: the judging call and the
 * batch callback are passed in.
 *
 * Caps bound what one run can spend: items considered, API calls made, and
 * input tokens used (checked before each call, so a run can exceed it by at
 * most one batch). Whatever a run leaves unjudged is picked up by the next one.
 */

import { createLogger } from '../utils/logger.js';
import type { NewsItem } from '../collectors/types.js';
import { addUsage, emptyUsage, type JudgeCall, type Usage } from './client.js';
import { validateJudgments, type Judgment } from './judgment.js';
import { buildItemInput, buildPrompt, selectKnownStories, type KnownStory, type Rubric } from './prompt.js';

const log = createLogger('editor');

export interface EditorCaps {
  /** Items judged per run, newest first. */
  maxItems: number;
  /** API calls per run, retries of a split batch included. */
  maxCalls: number;
  /** Input tokens per run (uncached + cache reads + cache writes). */
  maxInputTokens: number;
  batchSize: number;
  /** Known stories offered as context. */
  contextStories: number;
}

export interface RunInput {
  /** Items with a row id, newest first. */
  items: (NewsItem & { id: string })[];
  knownStories: KnownStory[];
  rubric: Rubric;
  sourceNames: Map<string, string>;
  caps: EditorCaps;
  call: JudgeCall;
  now: Date;
  /** Called with each batch's valid judgments, e.g. to store them. */
  onBatch?: (judgments: Judgment[]) => Promise<void>;
}

export interface RunResult {
  judgments: Judgment[];
  calls: number;
  usage: Usage;
  rejected: number;
  /** Items in a batch that failed outright (API error, unusable response). */
  failedItems: number;
  /** Items not attempted because a cap was reached. */
  skippedItems: number;
  /** Items the model left out of its answer. */
  missingItems: number;
  stoppedBy?: 'maxCalls' | 'maxInputTokens';
}

const inputTotal = (u: Usage) => u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** A newly named story, offered to later batches in the same run. */
function storyOf(j: Judgment, item: NewsItem): KnownStory {
  return {
    key: j.storyKey,
    headline: j.headline,
    importance: j.importance,
    lastSeen: item.publishedAt ?? item.fetchedAt ?? '',
  };
}

export async function runEditor(input: RunInput): Promise<RunResult> {
  const { caps, call, rubric, sourceNames, now } = input;
  const items = input.items.slice(0, caps.maxItems);
  const knownAtStart = selectKnownStories(input.knownStories, caps.contextStories);
  const knownKeys = new Set(input.knownStories.map((s) => s.key));
  const namedThisRun: KnownStory[] = [];
  const byId = new Map(items.map((i) => [i.id, i]));

  const result: RunResult = {
    judgments: [], calls: 0, usage: emptyUsage(), rejected: 0, failedItems: 0,
    skippedItems: input.items.length - items.length, missingItems: 0,
  };

  const capReached = (): RunResult['stoppedBy'] => {
    if (result.calls >= caps.maxCalls) return 'maxCalls';
    if (inputTotal(result.usage) >= caps.maxInputTokens) return 'maxInputTokens';
    return undefined;
  };

  // A batch that was cut off or declined is split once and retried as halves:
  // the next run would otherwise form the same batch and fail the same way.
  const queue = chunk(items, caps.batchSize).map((batch) => ({ batch, splittable: true }));

  while (queue.length > 0) {
    const stop = capReached();
    if (stop) {
      result.stoppedBy = stop;
      result.skippedItems += queue.reduce((n, q) => n + q.batch.length, 0);
      break;
    }
    const { batch, splittable } = queue.shift()!;

    const refs = new Map<string, string>();
    const inputs = batch.map((item, i) => {
      const ref = `i${i + 1}`;
      refs.set(ref, item.id);
      return buildItemInput(ref, item, sourceNames);
    });
    const prompt = buildPrompt(rubric, knownAtStart, selectKnownStories(namedThisRun, caps.contextStories), inputs, now);

    result.calls++;
    let response;
    try {
      response = await call(prompt);
    } catch (err) {
      log.warn(`Batch of ${batch.length} failed: ${(err as Error).message}`);
      result.failedItems += batch.length;
      continue;
    }
    addUsage(result.usage, response.usage);

    if (response.parsed === undefined) {
      if (response.retrySmaller && splittable && batch.length > 1) {
        log.warn(`Batch of ${batch.length}: ${response.failure}; retrying as two halves`);
        const half = Math.ceil(batch.length / 2);
        queue.unshift({ batch: batch.slice(half), splittable: false }, { batch: batch.slice(0, half), splittable: false });
      } else {
        log.warn(`Batch of ${batch.length} not judged: ${response.failure}`);
        result.failedItems += batch.length;
      }
      continue;
    }

    const { judgments, rejected, missing } = validateJudgments(response.parsed, refs);
    for (const line of rejected) log.warn(`Rejected judgment: ${line}`);
    if (missing.length > 0) log.warn(`${missing.length} item(s) left out of the answer; retried next run`);
    result.rejected += rejected.length;
    result.missingItems += missing.length;

    for (const j of judgments) {
      if (knownKeys.has(j.storyKey)) continue;
      knownKeys.add(j.storyKey);
      namedThisRun.push(storyOf(j, byId.get(j.id)!));
    }
    result.judgments.push(...judgments);
    if (judgments.length > 0 && input.onBatch) await input.onBatch(judgments);

    log.info(
      `Batch ${result.calls}: ${judgments.length}/${batch.length} judged ` +
        `(${response.usage.inputTokens} in + ${response.usage.cacheReadTokens} cached, ${response.usage.outputTokens} out)`,
    );
  }

  return result;
}
