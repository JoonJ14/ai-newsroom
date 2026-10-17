/**
 * Telegram bot adapter.
 * Sends the plain-text rendering, split at story boundaries to fit 4096 characters.
 */

import { createLogger } from '../../utils/logger.js';
import { splitText } from '../render.js';

const log = createLogger('telegram');

export async function sendTelegramDigest(message: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error('TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set');

  const chunks = splitText(message, 4096);
  log.info(`Sending digest to Telegram (${chunks.length} message(s))`);

  for (let i = 0; i < chunks.length; i++) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Plain text, no parse_mode: the text rendering has no markup, and titles are
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
