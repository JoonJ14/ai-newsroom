/**
 * Slack incoming webhook adapter.
 * 40,000 char limit — splitting rarely needed but implemented for safety.
 */

import { createLogger } from '../../utils/logger.js';

const log = createLogger('slack');

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

export async function sendSlackDigest(message: string): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) throw new Error('SLACK_WEBHOOK_URL not set');

  // Titles come from feeds. Escape Slack's control characters so "<!channel>"
  // or "<https://x|label>" in a title is shown, not acted on
  const escaped = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const chunks = splitAtSections(escaped, 40_000);
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
