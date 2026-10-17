/**
 * Editor settings from the environment. Every one has a default, so nothing
 * needs to be set for the scheduled run; the backfill workflow raises the caps.
 */

import type { ModelSettings } from './client.js';
import type { EditorCaps } from './run.js';

type Env = Record<string, string | undefined>;

export const DEFAULT_MODEL = 'claude-haiku-5-5';

/** Days back from now that the editor looks for unjudged items. */
export const DEFAULT_DAYS = 7;

function intVar(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}, got "${raw}"`);
  }
  return n;
}

export function editorCaps(env: Env = process.env): EditorCaps {
  return {
    // A weekday is ~123 items; one scheduled run sees about a quarter of that
    maxItems: intVar(env, 'EDITOR_MAX_ITEMS', 300, 1, 5000),
    maxCalls: intVar(env, 'EDITOR_MAX_CALLS', 20, 1, 500),
    maxInputTokens: intVar(env, 'EDITOR_MAX_INPUT_TOKENS', 600_000, 1000, 50_000_000),
    batchSize: intVar(env, 'EDITOR_BATCH_SIZE', 25, 1, 60),
    contextStories: intVar(env, 'EDITOR_CONTEXT_STORIES', 250, 0, 2000),
  };
}

export function modelSettings(env: Env = process.env): ModelSettings {
  const effort = env.EDITOR_EFFORT?.trim() || 'low';
  if (effort !== 'low' && effort !== 'medium' && effort !== 'high') {
    throw new Error(`EDITOR_EFFORT must be low, medium or high, got "${effort}"`);
  }
  const temp = env.EDITOR_TEMPERATURE?.trim();
  const temperature = temp ? Number(temp) : undefined;
  if (temperature !== undefined && !(temperature >= 0 && temperature <= 1)) {
    throw new Error(`EDITOR_TEMPERATURE must be from 0 to 1, got "${temp}"`);
  }
  return {
    model: env.EDITOR_MODEL?.trim() || DEFAULT_MODEL,
    effort,
    temperature,
    maxTokens: intVar(env, 'EDITOR_MAX_OUTPUT_TOKENS', 16_000, 1000, 64_000),
  };
}
