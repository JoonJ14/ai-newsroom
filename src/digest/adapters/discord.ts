/**
 * Discord webhook adapter.
 * Splits messages at section boundaries to respect 2000 char limit.
 */

import { createLogger } from '../../utils/logger.js';

const log = createLogger('discord');

function splitAtSections(message: string, maxLen: number): string[] {
  const sections = message.split(/\n(?=📢|🔥|📄|📰|───────────────────)/);
  const chunks: string[] = [];
  let current = '';

  for (const section of sections) {
    if (current.length + section.length + 1 > maxLen && current.length > 0) {
      chunks.push(current.trimEnd());
      current = '';
    }
    current += (current ? '\n' : '') + section;
  }
  if (current) chunks.push(current.trimEnd());

  return chunks;
}

export async function sendDiscordDigest(message: string): Promise<void> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) throw new Error('DISCORD_WEBHOOK_URL not set');

  const chunks = splitAtSections(message, 2000);
  log.info(`Sending digest to Discord (${chunks.length} message(s))`);

  for (let i = 0; i < chunks.length; i++) {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: chunks[i] }),
    });

    if (!res.ok) {
      throw new Error(`Discord webhook failed: HTTP ${res.status} ${res.statusText}`);
    }

    // Small delay between messages to avoid rate limiting
    if (i < chunks.length - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  log.info('Discord digest sent successfully');
}
