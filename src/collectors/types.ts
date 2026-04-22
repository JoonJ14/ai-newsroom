/**
 * AI Newsroom — Shared Types
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

/** Source definition from sources.yaml */
export interface SourceConfig {
  id: string;
  name: string;
  type: CollectorType;
  url: string;
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
