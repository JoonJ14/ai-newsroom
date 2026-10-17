/**
 * Digest configuration: the delivery adapter and its credentials (the digest
 * section of sources.yaml), and the editor digest's layout and thresholds
 * (environment variables, docs/digest.md).
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYAML } from 'yaml';
import type { DigestConfig, SourcesConfig } from '../collectors/types.js';
import { DEFAULT_RULES, type SectionRules } from '../editor/select.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function loadDigestConfig(): DigestConfig {
  const configPath = resolve(__dirname, '../../config/sources.yaml');
  const raw = readFileSync(configPath, 'utf-8');
  const config: SourcesConfig = parseYAML(raw);

  const digest = config.digest;
  const adapter = (process.env.DIGEST_ADAPTER as DigestConfig['adapter']) ?? digest.adapter;
  digest.adapter = adapter;

  // Validate adapter credentials
  switch (adapter) {
    case 'discord':
      if (!process.env.DISCORD_WEBHOOK_URL) {
        throw new Error(
          'Discord adapter selected but DISCORD_WEBHOOK_URL is not set. Add it to your .env file.',
        );
      }
      break;
    case 'telegram':
      if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
        throw new Error(
          'Telegram adapter selected but TELEGRAM_BOT_TOKEN and/or TELEGRAM_CHAT_ID are not set. Add them to your .env file.',
        );
      }
      break;
    case 'slack':
      if (!process.env.SLACK_WEBHOOK_URL) {
        throw new Error(
          'Slack adapter selected but SLACK_WEBHOOK_URL is not set. Add it to your .env file.',
        );
      }
      break;
    case 'imessage':
      if (!process.env.IMESSAGE_RECIPIENT) {
        throw new Error(
          'iMessage adapter selected but IMESSAGE_RECIPIENT is not set. Add it to your .env file.',
        );
      }
      if (process.platform !== 'darwin') {
        throw new Error('iMessage adapter only works on macOS.');
      }
      break;
    default:
      throw new Error(`Unknown digest adapter: ${adapter}`);
  }

  return digest;
}

// ─── The editor digest's settings ────────────────────────────────

/** `plain`: one regular message. `embeds`: one embed per section. Discord only. */
export type DigestLayout = 'plain' | 'embeds';
export const DIGEST_LAYOUTS: readonly DigestLayout[] = ['plain', 'embeds'];

export interface DigestSettings {
  layout: DigestLayout;
  rules: SectionRules;
  /** Below this share of the window judged, the digest falls back to the old ranking. */
  minJudgedShare: number;
  /** Settings that were set but unusable, and fell back to their defaults. */
  warnings: string[];
}

type Env = Record<string, string | undefined>;

/** Each threshold's variable. Unset or empty means the default (src/editor/select.ts). */
const RULE_VARS: Record<keyof SectionRules, string> = {
  topLimit: 'DIGEST_TOP_LIMIT',
  topMinImportance: 'DIGEST_TOP_MIN_IMPORTANCE',
  topBuilderMinImportance: 'DIGEST_TOP_BUILDER_MIN_IMPORTANCE',
  notableLimit: 'DIGEST_NOTABLE_LIMIT',
  notableMinImportance: 'DIGEST_NOTABLE_MIN_IMPORTANCE',
  builderLimit: 'DIGEST_BUILDERS_LIMIT',
  builderMinImportance: 'DIGEST_BUILDERS_MIN_IMPORTANCE',
  paperLimit: 'DIGEST_PAPER_LIMIT',
  paperMinImportance: 'DIGEST_PAPER_MIN_IMPORTANCE',
};

/**
 * Layout and thresholds from the environment (repository variables on
 * Actions, .env locally). A bad value never stops the digest: it is reported
 * and the default used, since a digest with default thresholds beats no digest.
 */
export function digestSettings(env: Env = process.env): DigestSettings {
  const warnings: string[] = [];

  const rawLayout = env.DIGEST_LAYOUT?.trim().toLowerCase();
  let layout: DigestLayout = 'plain';
  if (rawLayout) {
    if ((DIGEST_LAYOUTS as string[]).includes(rawLayout)) layout = rawLayout as DigestLayout;
    else warnings.push(`DIGEST_LAYOUT must be plain or embeds, got "${env.DIGEST_LAYOUT}"; using plain`);
  }

  const rules = { ...DEFAULT_RULES };
  for (const [field, name] of Object.entries(RULE_VARS) as [keyof SectionRules, string][]) {
    const raw = env[name]?.trim();
    if (!raw) continue;
    const n = Number(raw);
    const isLimit = field.endsWith('Limit');
    const [min, max] = isLimit ? [0, 10] : [1, 10];
    if (Number.isInteger(n) && n >= min && n <= max) rules[field] = n;
    else warnings.push(`${name} must be an integer from ${min} to ${max}, got "${raw}"; using ${rules[field]}`);
  }

  let minJudgedShare = 0.5;
  const rawShare = env.DIGEST_MIN_JUDGED_SHARE?.trim();
  if (rawShare) {
    const n = Number(rawShare);
    if (n >= 0 && n <= 1) minJudgedShare = n;
    else warnings.push(`DIGEST_MIN_JUDGED_SHARE must be from 0 to 1, got "${rawShare}"; using 0.5`);
  }

  return { layout, rules, minJudgedShare, warnings };
}
