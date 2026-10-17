/**
 * Slack incoming webhook adapter.
 * Sends the plain-text rendering; 40,000 char limit, so splitting is rarely needed.
 */

import { createLogger } from '../../utils/logger.js';
import { splitText } from '../render.js';

const log = createLogger('slack');

export async function sendSlackDigest(message: string): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) throw new Error('SLACK_WEBHOOK_URL not set');

  // Titles come from feeds. Escape Slack's control characters so "<!channel>"
  // or "<https://x|label>" in a title is shown, not acted on
  const escaped = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const chunks = splitText(escaped, 40_000);
  log.info(`Sending digest to Slack (${chunks.length} message(s))`);

  for (let i = 0; i < chunks.length; i++) {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Plain text: feed titles with * _ ~ or ` must not turn into formatting
      body: JSON.stringify({ text: chunks[i], mrkdwn: false }),
    });

    if (!res.ok) {
      throw new Error(`Slack webhook failed: HTTP ${res.status} ${res.statusText}`);
    }

    if (i < chunks.length - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  log.info('Slack digest sent successfully');
}
