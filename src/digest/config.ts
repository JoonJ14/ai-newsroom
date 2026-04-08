/**
 * Digest configuration loader.
 * Reads the digest section from sources.yaml and validates adapter credentials.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYAML } from 'yaml';
import type { DigestConfig, SourcesConfig } from '../collectors/types.js';

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
