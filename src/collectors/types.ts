/**
 * AI Newsroom — Shared Types
 */

// NewsItem and SourceCategory are shared with the MCP server (Deno)
import type { NewsItem, SourceCategory } from '../../supabase/functions/_shared/newsroom/types.ts';
export type { NewsItem, SourceCategory } from '../../supabase/functions/_shared/newsroom/types.ts';

/** Source definition from sources.yaml */
export interface SourceConfig {
  id: string;
  name: string;
  type: CollectorType;
  url: string;
  /** html_scrape only: more pages parsed by the same site scraper (e.g. Anthropic's /research) */
  extraUrls?: string[];
  category: SourceCategory;
  enabled: boolean;
  maxItems?: number;
  tags: string[];
  refreshIntervalHours?: number;
  skipRelevanceFilter?: boolean;
  sourceTier?: 1 | 2 | 3;
  digestMaxItems?: number;
  scoreFloor?: number;
}

/** Supported collector types */
export type CollectorType =
  | 'rss'
  | 'json_api'
  | 'reddit'
  | 'hackernews'
  | 'hackernews_algolia'
  | 'github_releases'
  | 'github_trending'
  | 'html_scrape';

/** Source group for bulk enable/disable */
export interface SourceGroup {
  [groupName: string]: string[]; // group name -> array of source IDs
}

/** Digest priority topic for relevance filtering */
export interface DigestPriority {
  label: string;
  keywords: string[];
  weight: number;
}

/** Digest configuration */
export interface DigestConfig {
  priorities: DigestPriority[];
  schedule: string; // cron syntax
  maxItems: number;
  adapter: 'discord' | 'telegram' | 'slack' | 'imessage';
}

/** Full sources.yaml structure */
export interface SourcesConfig {
  sources: SourceConfig[];
  groups: SourceGroup;
  digest: DigestConfig;
}

/** MCP tool response wrapper */
export interface MCPToolResponse {
  items: NewsItem[];
  meta: {
    total: number;
    source?: string;
    query?: string;
    since?: string;
    lastUpdated: string;
  };
}

/** Cache status for check_status tool */
export interface CacheStatus {
  lastUpdated: string;
  totalItems: number;
  sourcesBreakdown: {
    source: string;
    count: number;
    latestItem: string; // ISO timestamp
  }[];
  retentionDays: number;
}
