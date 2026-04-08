/**
 * iMessage adapter (macOS only).
 * Uses AppleScript via osascript to send messages.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('imessage');
const execAsync = promisify(exec);

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

export async function sendIMessageDigest(message: string): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('iMessage adapter only works on macOS.');
  }

  const recipient = process.env.IMESSAGE_RECIPIENT;
  if (!recipient) throw new Error('IMESSAGE_RECIPIENT not set');

  const chunks = splitAtSections(message, 5000);
  log.info(`Sending digest via iMessage to ${recipient} (${chunks.length} message(s))`);

  for (let i = 0; i < chunks.length; i++) {
    // Escape for AppleScript: double-quote escaping
    const escaped = chunks[i]
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"');

    const script = `tell application "Messages" to send "${escaped}" to buddy "${recipient}"`;

    try {
      await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`);
    } catch (err) {
      throw new Error(`iMessage send failed: ${(err as Error).message}`);
    }

    if (i < chunks.length - 1) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  log.info('iMessage digest sent successfully');
}
