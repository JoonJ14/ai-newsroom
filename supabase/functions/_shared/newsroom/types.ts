/**
 * Types shared by the digest (Node, src/) and the MCP server (Deno,
 * supabase/functions/mcp/). Every file in this folder is pure TypeScript with
 * no imports outside it, so both runtimes load the same code: Node through
 * the re-exports in src/, Deno and the Supabase bundler directly. Imports here
 * end in `.ts`, as Deno requires.
 */

/** A single news item normalized from any source */
export interface NewsItem {
  id?: string;
  title: string;
  url: string;
  source: string;
  sourceCategory: SourceCategory;
  score: number;
  summary?: string;
  authors?: string;
  tags: string[];
  fetchedAt: string; // ISO 8601
  publishedAt?: string; // ISO 8601
  metadata?: Record<string, unknown>;
}

/** Source categories for filtering */
export type SourceCategory =
  | 'company_blog'
  | 'community'
  | 'research'
  | 'github'
  | 'industry_news';

/** Another copy of a story, folded into a row by dedup (metadata.coveredBy). */
export interface Coverage {
  source: string;
  url: string;
}

export const EDITOR_TYPES = [
  'model_release', 'product_launch', 'policy_regulation', 'safety', 'business', 'legal',
  'research', 'tool_release', 'opinion', 'tutorial', 'patch_release', 'other',
] as const;
export type EditorType = (typeof EDITOR_TYPES)[number];

export const AUDIENCES = ['general', 'builder'] as const;
export type Audience = (typeof AUDIENCES)[number];

/** The AI editor's judgment of one item, as stored in news_items.editor_*. */
export interface ItemJudgment {
  type: EditorType;
  importance: number;
  audience: Audience;
  headline: string;
  why: string;
  storyKey: string;
  followup: boolean;
}
