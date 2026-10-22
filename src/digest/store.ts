/**
 * What the digest reads and writes in Supabase. `digest_state` holds:
 *   last_digest_at          when the last digest's window ended. The next one
 *                           starts there, and the 9:30 missed-digest alarm
 *                           (migration 003) reads it.
 *   story_history           every story shown in the last 7 days, any section,
 *                           as JSON (repeats.ts): key, headline, section, date,
 *                           newest fetched_at. The repeat check reads it.
 *   last_digest_story_keys  the last digest's keys by section (step 3). Still
 *                           written, for a rollback; read only to seed the
 *                           history the first time.
 * All are written together after a digest is sent, never by a preview.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { editorColumnsReadable, fetchItems, type StoredItem } from '../editor/db.js';
import { createLogger } from '../utils/logger.js';
import type { ShownStories } from './build.js';
import { historyFromLegacy, parseHistory, type HistoryEntry } from './repeats.js';

const log = createLogger('digest');

export interface WindowItems {
  items: StoredItem[];
  /** False when the editor columns couldn't be read: the digest falls back. */
  editorColumns: boolean;
}

export interface DigestStore {
  /** When the last digest's window ended; null if never set or not readable. */
  lastDigestAt(): Promise<string | null>;
  /**
   * Stories shown in the last 7 days. Before the first digest that stores a
   * history, the step-3 keys of the last digest stand in; else empty.
   */
  history(): Promise<HistoryEntry[]>;
  items(from: Date, to: Date): Promise<WindowItems>;
  save(windowEnd: string, shown: ShownStories, history: HistoryEntry[]): Promise<void>;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** last_digest_story_keys as stored; anything unreadable counts as nothing shown. */
export function parseShown(value: string | null | undefined): ShownStories | null {
  if (!value) return null;
  try {
    const v = JSON.parse(value) as Record<string, unknown>;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    return {
      top: strings(v.top), alsoNotable: strings(v.alsoNotable), builders: strings(v.builders), paper: strings(v.paper),
    };
  } catch {
    return null;
  }
}

/**
 * The window's items, with the editor's judgments when they can be read. If
 * that read fails for any reason, the items are read again without the editor
 * columns, so the digest can still go out on the old ranking.
 */
export async function readWindow(sb: SupabaseClient, from: Date, to: Date): Promise<WindowItems> {
  try {
    const items = await fetchItems(sb, from, to);
    return { items, editorColumns: editorColumnsReadable() };
  } catch (err) {
    log.warn(`Reading the editor's judgments failed (${(err as Error).message}); reading items without them`);
    return { items: await fetchItems(sb, from, to, true), editorColumns: false };
  }
}

/**
 * `readOnly` for previews: they read with the anon key, which can't see
 * digest_state (RLS), and must never write it.
 */
export function supabaseStore(sb: SupabaseClient, { readOnly = false } = {}): DigestStore {
  const read = async (key: string): Promise<string | null> => {
    const { data, error } = await sb.from('digest_state').select('value').eq('key', key).maybeSingle();
    if (error) {
      log.warn(`digest_state.${key} could not be read: ${error.message}`);
      return null;
    }
    return data?.value ?? null;
  };

  return {
    lastDigestAt: () => read('last_digest_at'),
    history: async () => {
      const stored = parseHistory(await read('story_history'));
      if (stored) return stored;
      return historyFromLegacy(parseShown(await read('last_digest_story_keys')), await read('last_digest_at'));
    },
    items: (from, to) => readWindow(sb, from, to),
    save: async (windowEnd, shown, history) => {
      if (readOnly) throw new Error('a read-only digest store never writes digest_state');
      const now = new Date().toISOString();
      const { error } = await sb.from('digest_state').upsert([
        { key: 'last_digest_at', value: windowEnd, updated_at: now },
        { key: 'last_digest_story_keys', value: JSON.stringify(shown), updated_at: now },
        { key: 'story_history', value: JSON.stringify(history), updated_at: now },
      ]);
      if (error) throw new Error(`digest_state update failed: ${error.message}`);
    },
  };
}
