/**
 * news_items rows as PostgREST returns them, and the items both the digest
 * and the MCP server build from them. The columns are
 * supabase/migrations/001_create_news_items.sql plus 004's editor_* columns.
 */

import type { Audience, EditorType, ItemJudgment, NewsItem, SourceCategory } from './types.ts';

/** A stored judgment: the editor's fields plus which model and rubric made it, and when. */
export type StoredJudgment = ItemJudgment & { model: string | null; version: string | null; judgedAt: string };

export type StoredItem = NewsItem & { id: string; judgment?: StoredJudgment };

export const BASE_COLUMNS =
  'id, title, url, source, source_category, score, summary, authors, tags, fetched_at, published_at, metadata';
export const EDITOR_COLUMNS =
  'editor_type, editor_importance, editor_audience, editor_headline, editor_why, ' +
  'editor_story_key, editor_followup, editor_model, editor_version, editor_judged_at';
export const ITEM_COLUMNS = `${BASE_COLUMNS}, ${EDITOR_COLUMNS}`;

/** Postgres "undefined_column": the editor columns (migration 004) are missing. */
export const UNDEFINED_COLUMN = '42703';

// Rows come back untyped from the select string
// deno-lint-ignore no-explicit-any
export type Row = Record<string, any>;

export function rowToItem(row: Row): StoredItem {
  const item: StoredItem = {
    id: row.id,
    title: row.title,
    url: row.url,
    source: row.source,
    sourceCategory: row.source_category as SourceCategory,
    score: row.score,
    summary: row.summary ?? undefined,
    authors: row.authors ?? undefined,
    tags: row.tags ?? [],
    fetchedAt: row.fetched_at,
    publishedAt: row.published_at ?? undefined,
    metadata: row.metadata ?? {},
  };
  if (row.editor_judged_at) {
    item.judgment = {
      type: row.editor_type as EditorType,
      importance: row.editor_importance,
      audience: row.editor_audience as Audience,
      headline: row.editor_headline,
      why: row.editor_why ?? '',
      storyKey: row.editor_story_key,
      followup: Boolean(row.editor_followup),
      model: row.editor_model,
      version: row.editor_version,
      judgedAt: row.editor_judged_at,
    };
  }
  return item;
}
