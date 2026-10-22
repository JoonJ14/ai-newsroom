/**
 * The MCP server's reads from news_items. Reads only: nothing here (or
 * anywhere in this function) writes. Rows come back with the AI editor's
 * columns and are mapped by the shared rowToItem, so the digest and the MCP
 * see the same items.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.102.1';
import {
  BASE_COLUMNS, ITEM_COLUMNS, rowToItem, UNDEFINED_COLUMN, type Row, type StoredItem,
} from '../../_shared/newsroom/rows.ts';

/** PostgREST's db-max-rows for this project: no response holds more. */
export const SERVER_MAX_ROWS = 1000;

export interface RowFilter {
  /** fetched_at strictly after. */
  since?: string;
  source?: string;
  category?: string;
  /** A keyword search on one text column (websearch syntax). */
  search?: { column: 'title' | 'summary' | 'editor_headline'; query: string };
}

export interface FetchResult {
  items: StoredItem[];
  /** Rows matched beyond `maxRows` were not read. */
  truncated: boolean;
  /** False when news_items has no editor columns (migration 004 not applied). */
  editorColumns: boolean;
}

// The query builder's type depends on the select string; the filters below are all it needs
// deno-lint-ignore no-explicit-any
type Query = any;

function applyFilter(q: Query, f: RowFilter): Query {
  if (f.since) q = q.gt('fetched_at', f.since);
  if (f.source) q = q.eq('source', f.source);
  if (f.category) q = q.eq('source_category', f.category);
  if (f.search) q = q.textSearch(f.search.column, f.search.query, { type: 'websearch' });
  return q;
}

/**
 * Every row matching `filter`, up to `maxRows`, paged on the primary key.
 *
 * PostgREST cuts every response to db-max-rows (1000) whatever .limit()
 * asks for, so one query cannot see a large window. The working set is frozen
 * by a cutoff captured up front (fetched_at at or before it, or null), so a
 * collector batch landing mid-read can't shift the pages, and paging seeks on
 * `id`, which is unique and never updated, rather than on the mutable score.
 * The order of the result doesn't matter: the callers rank it themselves.
 */
export async function fetchRows(sb: SupabaseClient, filter: RowFilter = {}, maxRows = 5000): Promise<FetchResult> {
  const cutoff = new Date().toISOString();
  let columns = ITEM_COLUMNS;
  let editorColumns = true;
  const items: StoredItem[] = [];
  let cursor: string | null = null;

  for (;;) {
    const want = Math.min(SERVER_MAX_ROWS, maxRows - items.length + 1);
    let q = applyFilter(sb.from('news_items').select(columns), filter)
      .or(`fetched_at.lte.${cutoff},fetched_at.is.null`)
      .order('id', { ascending: true })
      .limit(want);
    if (cursor !== null) q = q.gt('id', cursor);
    const { data, error } = await q;
    if (error?.code === UNDEFINED_COLUMN && editorColumns) {
      // Migration 004 not applied: serve the items unjudged rather than fail
      if (filter.search?.column === 'editor_headline') return { items: [], truncated: false, editorColumns: false };
      columns = BASE_COLUMNS;
      editorColumns = false;
      continue;
    }
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Row[];
    items.push(...rows.map(rowToItem));
    if (items.length > maxRows) return { items: items.slice(0, maxRows), truncated: true, editorColumns };
    if (rows.length < want) return { items, truncated: false, editorColumns };
    cursor = rows[rows.length - 1].id;
  }
}

/** The newest rows of a source, by fetched_at: get_source_updates' starting set. */
export async function fetchLatest(sb: SupabaseClient, filter: RowFilter, count: number): Promise<FetchResult> {
  const run = (columns: string) =>
    applyFilter(sb.from('news_items').select(columns), filter)
      .not('fetched_at', 'is', null)
      .order('fetched_at', { ascending: false })
      .order('id', { ascending: true })
      .limit(Math.min(count, SERVER_MAX_ROWS));
  let { data, error } = await run(ITEM_COLUMNS);
  let editorColumns = true;
  if (error?.code === UNDEFINED_COLUMN) {
    ({ data, error } = await run(BASE_COLUMNS));
    editorColumns = false;
  }
  if (error) throw new Error(error.message);
  return { items: ((data ?? []) as Row[]).map(rowToItem), truncated: false, editorColumns };
}
