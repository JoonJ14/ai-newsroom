/**
 * Relevance scoring for news items.
 * Score = recency (40%) + community signal (40%) + tier weight (20%)
 * Output: integer 0-100.
 */

import type { NewsItem, SourceCategory, CollectorType } from '../collectors/types.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

const TIER_WEIGHTS_BY_NUMBER: Record<number, number> = {
  1: 100,
  2: 85,
  3: 65,
};

const TIER_WEIGHTS_BY_CATEGORY: Record<SourceCategory, number> = {
  company_blog: 100,
  community: 65,
  research: 65,
  github: 65,
  industry_news: 85,
};

const SCORE_CEILINGS: Partial<Record<CollectorType, number>> = {
  hackernews: 500,
  hackernews_algolia: 500,
  reddit: 1000,
  github_trending: 5000,
  github_releases: 100,
};

function recencyScore(item: NewsItem): number {
  const timestamp = item.publishedAt ?? item.fetchedAt;
  const ageMs = Date.now() - new Date(timestamp).getTime();
  if (isNaN(ageMs)) return 0;
  if (ageMs <= SIX_HOURS_MS) return 100;
  if (ageMs >= SEVEN_DAYS_MS) return 0;
  const decayRange = SEVEN_DAYS_MS - SIX_HOURS_MS;
  return Math.round(100 * (1 - (ageMs - SIX_HOURS_MS) / decayRange));
}

function communityScore(item: NewsItem, collectorType: CollectorType): number {
  const ceiling = SCORE_CEILINGS[collectorType];
  if (ceiling === undefined) {
    return item.score > 0 ? Math.min(100, Math.round((item.score / 100) * 100)) : 50;
  }
  return Math.min(100, Math.round((item.score / ceiling) * 100));
}

export function computeRelevanceScore(
  item: NewsItem,
  collectorType: CollectorType,
  category: SourceCategory,
  sourceId?: string,
  sourceTier?: number,
  scoreFloor?: number,
): number {
  const recency = recencyScore(item);
  const community = communityScore(item, collectorType);
  const tierWeight = sourceTier != null
    ? (TIER_WEIGHTS_BY_NUMBER[sourceTier] ?? 65)
    : TIER_WEIGHTS_BY_CATEGORY[category];

  let score = Math.round(recency * 0.4 + community * 0.4 + tierWeight * 0.2);

  if (scoreFloor != null) {
    score = Math.max(score, scoreFloor);
  }

  return Math.max(0, Math.min(100, score));
}
