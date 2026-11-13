/**
 * The fallback digest's optional AI summary: two or three sentences at the
 * top of a digest built with the old ranking (build.ts), on a morning when the
 * editor's judgments are missing. One small call with the editor's client and
 * credentials (src/editor/client.ts: federation on GitHub Actions, then
 * ANTHROPIC_API_KEY, then none) and the editor's model (EDITOR_MODEL).
 *
 * Any failure skips the summary, with a warning: it never stops the digest.
 * Without credentials there is no summary, as before.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { NewsItem } from '../collectors/types.js';
import { authMode, AUTH_DESCRIPTIONS, createAnthropicClient, type AuthMode } from '../editor/client.js';
import { DEFAULT_MODEL } from '../editor/config.js';

/**
 * Two or three sentences are about 100 tokens, but Haiku 5.5's adaptive
 * thinking spends output tokens too (docs/TROUBLESHOOTING.md: the repeat check
 * once ran out at 4,000), so the cap leaves room for it. A capped call costs
 * at most about $0.0005.
 */
export const SUMMARY_MAX_TOKENS = 1024;
/** The editor's default effort: summarizing a list of titles needs little thought. */
export const SUMMARY_EFFORT = 'low';
/** One quick try: the summary is optional, and the digest job has 5 minutes. */
export const SUMMARY_TIMEOUT_MS = 30_000;
export const SUMMARY_MAX_RETRIES = 1;
/** The old ranking's top items it reads, as before. */
export const SUMMARY_ITEMS = 30;
/**
 * The longest summary kept. The intro goes in the first Discord message whole
 * (render.ts doesn't split a block), and escaping can double its length, so
 * 800 characters plus the header stay under Discord's 2,000. Two or three
 * sentences are about 300–500; the old 200-token cap allowed about as much.
 */
export const SUMMARY_MAX_CHARS = 800;

export type Summarize = (items: NewsItem[]) => Promise<string | undefined>;
type Env = Record<string, string | undefined>;
type Warn = (message: string) => void;
/** Just the part of the SDK client the summary uses, so tests can pass a fake. */
export type MessagesClient = Pick<Anthropic, 'messages'>;

/** The prompt, unchanged from the raw-fetch version this replaces. */
export function summaryPrompt(items: NewsItem[]): string {
  const titles = items
    .slice(0, SUMMARY_ITEMS)
    .map((i) => `- [${i.source}] ${i.title}`)
    .join('\n');
  return 'You are an AI news analyst. Given these top AI news items from the last 24 hours, write a 2-3 sentence ' +
    'executive summary of the most important developments. Be specific about company names and what happened. ' +
    `No preamble.\n\n${titles}`;
}

/** The summary call: its text, or undefined and a warning on any failure. */
export function apiSummarizer(client: MessagesClient, model: string, warn: Warn): Summarize {
  return async (items) => {
    try {
      const res = await client.messages.create(
        {
          model,
          max_tokens: SUMMARY_MAX_TOKENS,
          messages: [{ role: 'user', content: summaryPrompt(items) }],
          output_config: { effort: SUMMARY_EFFORT },
        },
        { timeout: SUMMARY_TIMEOUT_MS, maxRetries: SUMMARY_MAX_RETRIES },
      );
      // max_tokens would mean a sentence cut off; refusal, nothing to show
      if (res.stop_reason !== 'end_turn') {
        warn(`AI summary skipped: the model stopped with ${res.stop_reason}`);
        return undefined;
      }
      const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
      if (!text) {
        warn('AI summary skipped: the response had no text');
        return undefined;
      }
      if (text.length > SUMMARY_MAX_CHARS) {
        warn(`AI summary skipped: ${text.length} characters, over the ${SUMMARY_MAX_CHARS} a Discord message's intro can take`);
        return undefined;
      }
      return text;
    } catch (err) {
      warn(`AI summary skipped: ${(err as Error).message}`);
      return undefined;
    }
  };
}

export interface SummarySetup {
  /** Undefined without credentials: the fallback digest then has no summary. */
  summarize?: Summarize;
  model: string;
  auth: string;
}

/** The summary with the editor's credentials and model, as the environment allows. */
export function summarizerFromEnv(
  env: Env,
  warn: Warn,
  createClient: (mode: AuthMode, env: Env) => MessagesClient = createAnthropicClient,
): SummarySetup {
  const model = env.EDITOR_MODEL?.trim() || DEFAULT_MODEL;
  const mode = authMode(env);
  if (mode === 'none') return { model, auth: AUTH_DESCRIPTIONS.none };
  try {
    return { summarize: apiSummarizer(createClient(mode, env), model, warn), model, auth: AUTH_DESCRIPTIONS[mode] };
  } catch (err) {
    warn(`AI summary unavailable: ${(err as Error).message}`);
    return { model, auth: AUTH_DESCRIPTIONS[mode] };
  }
}
