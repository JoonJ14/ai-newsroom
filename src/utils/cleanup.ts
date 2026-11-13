/**
 * Standalone cleanup script, run by collect.yml after every collection.
 * Deletes news_items fetched more than 90 days ago, and items the AI editor
 * rated 2 or lower fetched more than 14 days ago. Unjudged items keep the 90
 * days. Both numbers of the second rule are settings (src/utils/retention.ts):
 * CLEANUP_LOW_IMPORTANCE_MAX (0 switches the rule off) and
 * CLEANUP_LOW_IMPORTANCE_DAYS.
 *
 * Usage: npm run cleanup
 */

import 'dotenv/config';
import { deleteLowImportanceItems, deleteOldItems } from './supabase.js';
import { createLogger } from './logger.js';
import { lowImportanceRule, RETENTION_DAYS } from './retention.js';

const log = createLogger('cleanup');

/** A GitHub Actions annotation when running there, a plain warning otherwise. */
function annotate(message: string) {
  if (process.env.GITHUB_ACTIONS) console.log(`::warning title=Cleanup::${message}`);
  else log.warn(message);
}

async function main() {
  const { rule, warnings } = lowImportanceRule(process.env);
  for (const w of warnings) annotate(w);

  log.info('Running cleanup...');
  // One captured time for both rules
  const now = new Date();
  const old = await deleteOldItems(RETENTION_DAYS, now);
  const low = rule ? await deleteLowImportanceItems(rule, now) : 0;
  log.info(
    `Cleanup complete: removed ${old} items older than ${RETENTION_DAYS} days, ` +
      (rule
        ? `and ${low} rated ${rule.maxImportance} or lower older than ${rule.days} days`
        : 'and none by importance (CLEANUP_LOW_IMPORTANCE_MAX=0)'),
  );
}

main().catch((err) => {
  log.error('Cleanup failed', err);
  process.exit(1);
});
