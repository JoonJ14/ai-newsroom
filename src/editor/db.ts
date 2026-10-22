/**
 * Database access for the editor and its preview.
 *
 * Reads page on `id` inside a frozen window, because PostgREST cuts any result
 * to 1,000 rows without an error (CLAUDE.md, "Query constraints"). Writes touch
 * only the `editor_*` columns, one row at a time by id, and only while the row
 * is still unjudged: a concurrent run, or a judgment stored a moment earlier,
 * is never overwritten.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYAML } from 'yaml';
import type { SourceConfig, SourcesConfig } from '../collectors/types.js';
import {
  BASE_COLUMNS, ITEM_COLUMNS, rowToItem, UNDEFINED_COLUMN, type Row, type StoredItem,
} from '../../supabase/functions/_shared/newsroom/rows.ts';
import type { Judgment } from './judgment.js';
import type { KnownStory } from './prompt.js';

const here = dirname(fileURLToPath(import.meta.url));

export function loadSources(): SourceConfig[] {
  const raw = readFileSync(resolve(here, '../../config/sources.yaml'), 'utf-8');
  return (parseYAML(raw) as SourcesConfig).sources;
}

/** Write access: the service key, which only GitHub Actions has. */
export function serviceClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  return createClient(url, key);
}

/** Read access: the public anon key (RLS allows reads), or the service key if that is what is set. */
export function readClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL and SUPABASE_ANON_KEY (or SUPABASE_SERVICE_KEY)');
  return createClient(url, key);
}

// Rows, columns and the row → item mapping are shared with the MCP server
export { rowToItem, type StoredItem, type StoredJudgment } from '../../supabase/functions/_shared/newsroom/rows.ts';

/** PostgREST's `db-max-rows`. */
const PAGE = 1000;

export class MissingEditorColumnsError extends Error {
  constructor() {
    super('news_items has no editor_* columns: apply supabase/migrations/004_editor_judgments.sql');
  }
}

/**
 * Whether the editor columns exist, learned from the first read. Until
 * migration 004 is applied, plain reads fall back to the base columns, so the
 * preview's --dry-run works before the migration does.
 */
let editorColumnsExist: boolean | undefined;

/** False once a read has found the editor columns missing. */
export function editorColumnsReadable(): boolean {
  return editorColumnsExist !== false;
}

const identity = <T>(q: T): T => q;

/**
 * Every row with `fetched_at` in (from, to], paged on id. `filter` narrows
 * the query further. Rows inserted after `to` can't shift the pages.
 */
async function fetchWindow(
  sb: SupabaseClient,
  from: Date,
  to: Date,
  filter: (q: any) => any = identity, // eslint-disable-line @typescript-eslint/no-explicit-any
  baseOnly = false,
): Promise<StoredItem[]> {
  const out: StoredItem[] = [];
  let after: string | null = null;
  const editorFilter = filter !== identity;
  if (editorColumnsExist === false && editorFilter) throw new MissingEditorColumnsError();
  for (;;) {
    let q = sb
      .from('news_items')
      .select(baseOnly || editorColumnsExist === false ? BASE_COLUMNS : ITEM_COLUMNS)
      .gt('fetched_at', from.toISOString())
      .lte('fetched_at', to.toISOString())
      .order('id', { ascending: true })
      .limit(PAGE);
    if (after) q = q.gt('id', after);
    const { data, error } = await filter(q);
    if (error?.code === UNDEFINED_COLUMN && editorColumnsExist === undefined && !baseOnly) {
      editorColumnsExist = false;
      if (editorFilter) throw new MissingEditorColumnsError();
      continue;
    }
    if (error) throw new Error(`news_items read failed: ${error.message}`);
    if (!baseOnly) editorColumnsExist ??= true;
    const rows = (data ?? []) as Row[];
    out.push(...rows.map(rowToItem));
    if (rows.length < PAGE) return out;
    after = rows[rows.length - 1].id;
  }
}

const byFetchedDesc = (a: StoredItem, b: StoredItem) =>
  (b.fetchedAt ?? '').localeCompare(a.fetchedAt ?? '') || a.id.localeCompare(b.id);

/** Unjudged rows fetched in (from, to], newest first. */
export async function fetchUnjudged(sb: SupabaseClient, from: Date, to: Date): Promise<StoredItem[]> {
  const rows = await fetchWindow(sb, from, to, (q) => q.is('editor_judged_at', null));
  return rows.sort(byFetchedDesc);
}

/**
 * Every row fetched in (from, to], judged or not. `baseOnly` reads only the
 * collection columns, for the digest's fallback when the editor's can't be read.
 */
export async function fetchItems(sb: SupabaseClient, from: Date, to: Date, baseOnly = false): Promise<StoredItem[]> {
  return (await fetchWindow(sb, from, to, identity, baseOnly)).sort(byFetchedDesc);
}

/** Stories judged among rows fetched in (from, to], one entry per row. */
export async function fetchKnownStories(sb: SupabaseClient, from: Date, to: Date): Promise<KnownStory[]> {
  const rows = await fetchWindow(sb, from, to, (q) => q.not('editor_judged_at', 'is', null));
  return rows.flatMap((r) =>
    r.judgment?.storyKey
      ? [{
          key: r.judgment.storyKey,
          headline: r.judgment.headline,
          importance: r.judgment.importance,
          lastSeen: r.publishedAt ?? r.fetchedAt,
        }]
      : [],
  );
}

/**
 * The update for one judgment: only `editor_*` columns, so a judgment can't
 * change anything collection owns.
 */
export function editorColumns(j: Judgment, model: string, version: string, judgedAt: string) {
  return {
    editor_type: j.type,
    editor_importance: j.importance,
    editor_audience: j.audience,
    editor_headline: j.headline,
    editor_why: j.why,
    editor_story_key: j.storyKey,
    editor_followup: j.followup,
    editor_model: model,
    editor_version: version,
    editor_judged_at: judgedAt,
  };
}

export interface WriteResult {
  written: number;
  /** Already judged by the time we wrote, or deleted: left as they were. */
  skipped: number;
  failed: number;
}

export async function writeJudgments(
  sb: SupabaseClient,
  judgments: Judgment[],
  model: string,
  version: string,
  judgedAt: string,
): Promise<WriteResult> {
  const result: WriteResult = { written: 0, skipped: 0, failed: 0 };
  for (const j of judgments) {
    const { data, error } = await sb
      .from('news_items')
      .update(editorColumns(j, model, version, judgedAt))
      .eq('id', j.id)
      .is('editor_judged_at', null)
      .select('id');
    if (error) result.failed++;
    else if ((data?.length ?? 0) === 0) result.skipped++;
    else result.written++;
  }
  return result;
}
