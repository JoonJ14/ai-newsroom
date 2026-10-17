/**
 * Discord webhook adapter. Sends the digest in the chosen layout (render.ts):
 * `plain` as regular messages, `embeds` as one embed per section. Feed text
 * is escaped field by field when it is rendered, so this sends the payloads
 * as they are.
 */

import { createLogger } from '../../utils/logger.js';
import type { DigestLayout } from '../config.js';
import { discordPayloads, type DigestDocument, type DiscordPayload } from '../render.js';

const log = createLogger('discord');

export async function postDiscordPayloads(webhookUrl: string, payloads: DiscordPayload[]): Promise<void> {
  for (let i = 0; i < payloads.length; i++) {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Every payload carries allowed_mentions: { parse: [] }: a feed title
      // never pings @everyone, a role or a user
      body: JSON.stringify(payloads[i]),
    });

    if (!res.ok) {
      throw new Error(`Discord webhook failed: HTTP ${res.status} ${res.statusText}`);
    }

    // Small delay between messages to avoid rate limiting
    if (i < payloads.length - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

export async function sendDiscordDigest(doc: DigestDocument, layout: DigestLayout): Promise<void> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) throw new Error('DISCORD_WEBHOOK_URL not set');

  const payloads = discordPayloads(doc, layout);
  log.info(`Sending digest to Discord (${layout} layout, ${payloads.length} message(s))`);
  await postDiscordPayloads(webhookUrl, payloads);
  log.info('Discord digest sent successfully');
}
