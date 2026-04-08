/**
 * Standalone cleanup script.
 * Deletes news_items where fetched_at < 90 days ago.
 *
 * Usage: npm run cleanup
 */

import 'dotenv/config';
import { deleteOldItems } from './supabase.js';
import { createLogger } from './logger.js';

const log = createLogger('cleanup');

async function main() {
  log.info('Running cleanup...');
  const deleted = await deleteOldItems(90);
  log.info(`Cleanup complete: removed ${deleted} items older than 90 days`);
}

main().catch((err) => {
  log.error('Cleanup failed', err);
  process.exit(1);
});
