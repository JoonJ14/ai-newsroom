/**
 * The Claude API side of the editor: which credential to use, and one call
 * that judges one batch.
 *
 * Credentials, first match wins:
 * 1. Workload identity federation on GitHub Actions. The federation IDs are set
 *    and the job may request an OIDC token (`permissions: id-token: write`).
 *    A fresh GitHub token is requested for every exchange, so a long run never
 *    presents an expired one (GitHub's tokens last about five minutes).
 * 2. Federation from a token file or value (`ANTHROPIC_IDENTITY_TOKEN_FILE`),
 *    resolved by the SDK itself. For other CI systems.
 * 3. `ANTHROPIC_API_KEY`: local runs from `.env`, and the GitHub fallback until
 *    the federation wizard is done.
 *
 * No secret is logged; only the mode is.
 */

import Anthropic from '@anthropic-ai/sdk';
import { oidcFederationProvider } from '@anthropic-ai/sdk/lib/credentials/oidc-federation';
import { RESPONSE_SCHEMA } from './judgment.js';
import type { PromptParts } from './prompt.js';

export type AuthMode = 'federation-github' | 'federation-env' | 'api-key' | 'none';

type Env = Record<string, string | undefined>;
const has = (env: Env, name: string) => Boolean(env[name]?.trim());

export function authMode(env: Env = process.env): AuthMode {
  const federation = has(env, 'ANTHROPIC_FEDERATION_RULE_ID') && has(env, 'ANTHROPIC_ORGANIZATION_ID');
  if (federation && has(env, 'ACTIONS_ID_TOKEN_REQUEST_URL') && has(env, 'ACTIONS_ID_TOKEN_REQUEST_TOKEN')) {
    return 'federation-github';
  }
  if (federation && (has(env, 'ANTHROPIC_IDENTITY_TOKEN_FILE') || has(env, 'ANTHROPIC_IDENTITY_TOKEN'))) {
    return 'federation-env';
  }
  if (has(env, 'ANTHROPIC_API_KEY')) return 'api-key';
  return 'none';
}

export const AUTH_DESCRIPTIONS: Record<AuthMode, string> = {
  'federation-github': 'workload identity federation (GitHub OIDC token)',
  'federation-env': 'workload identity federation (token from environment)',
  'api-key': 'ANTHROPIC_API_KEY',
  none: 'no credentials',
};

/** The audience the federation rule expects in GitHub's token. */
const FEDERATION_AUDIENCE = 'https://api.anthropic.com';
const BASE_URL = 'https://api.anthropic.com';

/** Ask the Actions runtime for a fresh OIDC token (what `core.getIDToken` does). */
async function githubIdToken(env: Env): Promise<string> {
  const url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL!);
  url.searchParams.set('audience', env.ANTHROPIC_FEDERATION_AUDIENCE?.trim() || FEDERATION_AUDIENCE);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`GitHub OIDC token request failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { value?: string };
  if (!body.value) throw new Error('GitHub OIDC token response has no value');
  return body.value;
}

export function createAnthropicClient(mode: AuthMode, env: Env = process.env): Anthropic {
  const opt = (name: string) => env[name]?.trim() || undefined;
  switch (mode) {
    case 'federation-github':
      return new Anthropic({
        apiKey: null,
        authToken: null,
        credentials: oidcFederationProvider({
          identityTokenProvider: () => githubIdToken(env),
          federationRuleId: opt('ANTHROPIC_FEDERATION_RULE_ID')!,
          organizationId: opt('ANTHROPIC_ORGANIZATION_ID')!,
          serviceAccountId: opt('ANTHROPIC_SERVICE_ACCOUNT_ID'),
          workspaceId: opt('ANTHROPIC_WORKSPACE_ID'),
          baseURL: BASE_URL,
          fetch: globalThis.fetch,
        }),
      });
    case 'federation-env':
      // apiKey/authToken would outrank federation; the SDK reads the rest from env
      return new Anthropic({ apiKey: null, authToken: null });
    case 'api-key':
      return new Anthropic({ apiKey: opt('ANTHROPIC_API_KEY')! });
    case 'none':
      throw new Error('No Anthropic credentials: set ANTHROPIC_API_KEY or the federation variables');
  }
}

export interface ModelSettings {
  model: string;
  effort: 'low' | 'medium' | 'high';
  /** Unset by default: Claude Haiku 5.5 rejects any temperature but 1 (HTTP 400). */
  temperature?: number;
  maxTokens: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

export function addUsage(total: Usage, u: Usage) {
  total.inputTokens += u.inputTokens;
  total.outputTokens += u.outputTokens;
  total.cacheReadTokens += u.cacheReadTokens;
  total.cacheWriteTokens += u.cacheWriteTokens;
}

/** $/MTok for models this project has used; anything else is logged in tokens only. */
const PRICES: Record<string, { input: number; output: number }> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

export function estimateCostUsd(model: string, u: Usage): number | null {
  const p = PRICES[model];
  if (!p) return null;
  return (
    (u.inputTokens * p.input + u.cacheReadTokens * p.input * 0.1 + u.cacheWriteTokens * p.input * 1.25 +
      u.outputTokens * p.output) / 1e6
  );
}

export interface BatchResponse {
  /** The parsed JSON body, or undefined if the response was not usable. */
  parsed?: unknown;
  /** Why the response was not usable. */
  failure?: string;
  /** True when a smaller batch might succeed (output cut off, or declined). */
  retrySmaller?: boolean;
  usage: Usage;
}

/** The judging call, injectable so the run loop can be tested without the network. */
export type JudgeCall = (prompt: PromptParts) => Promise<BatchResponse>;

export function apiJudgeCall(client: Anthropic, settings: ModelSettings): JudgeCall {
  return async (prompt) => {
    const res = await client.messages.create({
      model: settings.model,
      max_tokens: settings.maxTokens,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      output_config: {
        effort: settings.effort,
        format: { type: 'json_schema', schema: RESPONSE_SCHEMA as unknown as Record<string, unknown> },
      },
      ...(settings.temperature !== undefined ? { temperature: settings.temperature } : {}),
    });

    const usage: Usage = {
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
      cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
    };

    if (res.stop_reason === 'refusal') return { failure: 'model declined the batch', retrySmaller: true, usage };
    if (res.stop_reason === 'max_tokens') return { failure: 'output hit max_tokens', retrySmaller: true, usage };

    const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    try {
      return { parsed: JSON.parse(text), usage };
    } catch {
      return { failure: `response is not JSON: ${text.slice(0, 120)}`, usage };
    }
  };
}
