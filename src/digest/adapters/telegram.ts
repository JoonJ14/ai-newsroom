/**
 * Telegram bot adapter.
 * Splits messages at section boundaries to respect 4096 char limit.
 */

import { createLogger } from '../../utils/logger.js';

const log = createLogger('telegram');

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

export async function sendTelegramDigest(message: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error('TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set');

  const chunks = splitAtSections(message, 4096);
  log.info(`Sending digest to Telegram (${chunks.length} message(s))`);

  for (let i = 0; i < chunks.length; i++) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Plain text, no parse_mode: the digest has no markup, and titles are
      // decoded text from feeds, so "<model>" or "Q&A" must not be read as HTML.
      // A word joiner after "@" keeps Telegram from making a feed title's
      // "@username" a mention; it renders the same.
      body: JSON.stringify({
        chat_id: chatId,
        text: chunks[i].replace(/@(?=\w)/g, '@\u2060'),
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Telegram API failed: HTTP ${res.status} — ${body}`);
    }

    if (i < chunks.length - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  log.info('Telegram digest sent successfully');
}
