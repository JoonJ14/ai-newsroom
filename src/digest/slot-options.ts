/**
 * The slot layout the daily digest uses. Shared with `npm run preview:editor`
 * (src/editor/preview.ts), which replays the old digest's picks for a past
 * window and must use exactly these settings.
 */

import type { SourceConfig } from '../collectors/types.js';
import type { SlotOptions } from '../utils/slots.js';

/** Tighter caps than get_top_picks, for a human-readable digest. */
export function digestSlotOptions(sourceConfigs: SourceConfig[]): SlotOptions {
  const sourceDigestCaps = new Map<string, number>();
  for (const src of sourceConfigs) {
    if (src.digestMaxItems != null) {
      sourceDigestCaps.set(src.id, src.digestMaxItems);
    }
  }

  return {
    topStoryLimit: 1,
    todayLimit: 5,
    todayMaxPerSource: 2,
    officialLimit: 5,
    officialMaxPerSource: 2,
    fieldLimit: 3,
    fieldMaxPerSource: 1,
    communityLimit: 3,
    communityMaxPerSource: 2,
    researchLimit: 3,
    researchMaxPerSource: 2,
    industryLimit: 2,
    industryMaxPerSource: 1,
    sourceDigestCaps,
  };
}
