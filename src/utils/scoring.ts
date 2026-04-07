/**
 * Relevance scoring for news items.
 * Score = recency (40%) + community signal (40%) + source tier (20%)
 * Output: integer 0-100.
 */

import type { NewsItem, SourceCategory, CollectorType } from '../collectors/types.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

/** Source tier weights by category */
const TIER_WEIGHTS: Record<SourceCategory, number> = {
  company_blog: 100,
  community: 70,
  research: 60,
  github: 65,
  industry_news: 50,
};

/** Score ceilings for community signal normalization by collector type */
const SCORE_CEILINGS: Partial<Record<CollectorType, number>> = {
  hackernews: 500,
  hackernews_algolia: 500,
  reddit: 1000,
  github_trending: 5000,
  github_releases: 100, // releases don't have meaningful scores
};

/**
 * Compute recency score (0-100).
 * Items from the last 6 hours = 100. Linear decay to 0 at 7 days.
 */
function recencyScore(item: NewsItem): number {
  const timestamp = item.publishedAt ?? item.fetchedAt;
  const ageMs = Date.now() - new Date(timestamp).getTime();

  if (ageMs <= SIX_HOURS_MS) return 100;
  if (ageMs >= SEVEN_DAYS_MS) return 0;

  // Linear decay from 100 at 6h to 0 at 7d
  const decayRange = SEVEN_DAYS_MS - SIX_HOURS_MS;
  return Math.round(100 * (1 - (ageMs - SIX_HOURS_MS) / decayRange));
}

/**
 * Normalize community signal (0-100).
 * Sources without meaningful scores get a flat 50.
 */
function communityScore(item: NewsItem, collectorType: CollectorType): number {
  const ceiling = SCORE_CEILINGS[collectorType];

  if (ceiling === undefined) {
    // RSS blogs, ArXiv, html_scrape, json_api without scores — flat 50
    return item.score > 0 ? Math.min(100, Math.round((item.score / 100) * 100)) : 50;
  }

  return Math.min(100, Math.round((item.score / ceiling) * 100));
}

/** Tier 1 release repos that get a score floor of 90 */
const TIER1_RELEASE_IDS = new Set(['claude_code_releases', 'openai_codex_releases']);

/**
 * Compute overall relevance score for a news item.
 * Returns integer 0-100.
 *
 * Score floors:
 * - company_blog sources: minimum 95 (official announcements always top)
 * - Tier 1 github_releases (claude_code, openai_codex): minimum 90
 */
export function computeRelevanceScore(
  item: NewsItem,
  collectorType: CollectorType,
  category: SourceCategory,
  sourceId?: string,
): number {
  const recency = recencyScore(item);
  const community = communityScore(item, collectorType);
  const tier = TIER_WEIGHTS[category];

  let score = Math.round(recency * 0.4 + community * 0.4 + tier * 0.2);

  // Tier 1 score floors
  if (category === 'company_blog') {
    score = Math.max(score, 95);
  } else if (sourceId && TIER1_RELEASE_IDS.has(sourceId)) {
    score = Math.max(score, 90);
  }

  return Math.max(0, Math.min(100, score));
}
