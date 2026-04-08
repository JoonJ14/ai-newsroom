/**
 * Slots-based display layout for get_top_picks.
 * Divides scored items into four sections:
 * 1. Official Announcements (company_blog + Tier 1 releases) — capped, releases consolidated
 * 2. Community Highlights (community sources) — capped
 * 3. Research & Papers (research sources) — capped
 * 4. Industry News (industry_news + remaining github) — capped
 */

import type { NewsItem, SourceCategory } from '../collectors/types.js';

export interface SlotOptions {
  officialLimit?: number;         // default 15
  communityLimit?: number;        // default 5
  researchLimit?: number;         // default 3
  industryLimit?: number;         // default 2
  officialMaxPerSource?: number;  // default 3
  communityMaxPerSource?: number; // default 2
  researchMaxPerSource?: number;  // default 2
  industryMaxPerSource?: number;  // default 2
}

export interface SlottedSection {
  label: string;
  items: NewsItem[];
}

export interface SlottedDisplay {
  sections: SlottedSection[];
  totalItems: number;
}

const TIER1_RELEASE_SOURCES = new Set(['claude_code_releases', 'openai_codex_releases']);
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function getRelevanceScore(item: NewsItem): number {
  return (item.metadata?.relevanceScore as number) ?? item.score ?? 0;
}

function sortByScore(items: NewsItem[]): NewsItem[] {
  return [...items].sort((a, b) => getRelevanceScore(b) - getRelevanceScore(a));
}

/** Filter to items from the last 7 days based on publishedAt or fetchedAt. */
function filterRecent(items: NewsItem[]): NewsItem[] {
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  return items.filter((item) => {
    const ts = item.publishedAt ?? item.fetchedAt;
    const time = new Date(ts).getTime();
    return !isNaN(time) && time >= cutoff;
  });
}

/** Display name for a source (e.g. claude_code_releases → Claude Code) */
const SOURCE_DISPLAY_NAMES: Record<string, string> = {
  anthropic_blog: 'Anthropic',
  anthropic_changelog: 'Anthropic Changelog',
  openai_news: 'OpenAI',
  google_ai_blog: 'Google AI',
  google_research: 'Google Research',
  nvidia_developer_blog: 'NVIDIA',
  claude_code_releases: 'Claude Code',
  openai_codex_releases: 'OpenAI Codex',
  hackernews_top: 'Hacker News',
  show_hn: 'Show HN',
  reddit_claudeai: 'r/ClaudeAI',
  reddit_localllama: 'r/LocalLLaMA',
  reddit_machinelearning: 'r/MachineLearning',
  reddit_artificial: 'r/artificial',
  hf_daily_papers: 'HF Papers',
  hf_trending_spaces: 'HF Spaces',
  github_trending: 'GitHub Trending',
  arxiv_cs_ai: 'ArXiv cs.AI',
  arxiv_cs_lg: 'ArXiv cs.LG',
  arxiv_cs_cv: 'ArXiv cs.CV',
  devto_ai: 'Dev.to',
  infoq_ai: 'InfoQ',
  thenewstack_ai: 'The New Stack',
  vllm_releases: 'vLLM',
};

function sourceDisplayName(source: string): string {
  return SOURCE_DISPLAY_NAMES[source] ?? source;
}

/**
 * Consolidate GitHub release items from the same source into a single summary entry.
 * e.g. 4 Claude Code releases → "Claude Code: 4 releases this week (v2.1.89 → v2.1.92)"
 */
function consolidateReleases(items: NewsItem[]): NewsItem[] {
  const releaseItems: NewsItem[] = [];
  const nonReleaseItems: NewsItem[] = [];

  for (const item of items) {
    // Check if this is a github_releases item (source ends with _releases)
    if (item.metadata?.tagName !== undefined) {
      releaseItems.push(item);
    } else {
      nonReleaseItems.push(item);
    }
  }

  if (releaseItems.length === 0) return items;

  // Group by source
  const groups = new Map<string, NewsItem[]>();
  for (const item of releaseItems) {
    const existing = groups.get(item.source) ?? [];
    existing.push(item);
    groups.set(item.source, existing);
  }

  // Consolidate each group into one entry
  const consolidated: NewsItem[] = [];
  for (const [source, group] of groups) {
    if (group.length === 1) {
      consolidated.push(group[0]);
      continue;
    }

    // Sort by publishedAt descending to find newest/oldest
    const sorted = [...group].sort((a, b) => {
      const ta = new Date(a.publishedAt ?? a.fetchedAt).getTime();
      const tb = new Date(b.publishedAt ?? b.fetchedAt).getTime();
      return tb - ta;
    });

    const newest = sorted[0];
    const oldest = sorted[sorted.length - 1];
    const newestTag = newest.metadata?.tagName as string ?? 'latest';
    const oldestTag = oldest.metadata?.tagName as string ?? 'oldest';
    const displayName = sourceDisplayName(source);
    const highestScore = Math.max(...group.map(getRelevanceScore));

    consolidated.push({
      ...newest,
      title: `${displayName}: ${group.length} releases this week (${oldestTag} → ${newestTag})`,
      score: highestScore,
      metadata: {
        ...newest.metadata,
        relevanceScore: highestScore,
        consolidatedCount: group.length,
        versionRange: `${oldestTag} → ${newestTag}`,
      },
    });
  }

  return [...nonReleaseItems, ...consolidated];
}

/**
 * Select top N items with a per-source diversity cap.
 * Items are assumed to be pre-sorted by score descending.
 */
function selectWithPerSourceCap(
  sorted: NewsItem[],
  limit: number,
  maxPerSource: number,
): NewsItem[] {
  const result: NewsItem[] = [];
  const sourceCounts = new Map<string, number>();

  for (const item of sorted) {
    if (result.length >= limit) break;
    const count = sourceCounts.get(item.source) ?? 0;
    if (count >= maxPerSource) continue;
    result.push(item);
    sourceCounts.set(item.source, count + 1);
  }

  return result;
}

export function buildSlottedDisplay(
  items: NewsItem[],
  options?: SlotOptions,
): SlottedDisplay {
  const officialLimit = options?.officialLimit ?? 20;
  const communityLimit = options?.communityLimit ?? 8;
  const researchLimit = options?.researchLimit ?? 6;
  const industryLimit = options?.industryLimit ?? 4;
  const officialMaxPerSource = options?.officialMaxPerSource ?? 5;
  const communityMaxPerSource = options?.communityMaxPerSource ?? 2;
  const researchMaxPerSource = options?.researchMaxPerSource ?? 2;
  const industryMaxPerSource = options?.industryMaxPerSource ?? 2;

  const usedUrls = new Set<string>();

  // Section 1 — Official Announcements: company_blog + Tier 1 releases
  const officialRaw = items.filter(
    (item) =>
      item.sourceCategory === 'company_blog' ||
      TIER1_RELEASE_SOURCES.has(item.source),
  );
  // Mark ALL official items as used (even if capped) to prevent leaking to other sections
  for (const item of officialRaw) usedUrls.add(item.url);

  // Filter to recent, consolidate releases, then guarantee releases are included
  const officialRecent = filterRecent(officialRaw);
  const officialConsolidated = consolidateReleases(officialRecent);

  // Split into releases and blog posts — releases are exempt from per-source cap
  const releaseEntries = sortByScore(
    officialConsolidated.filter((item) => TIER1_RELEASE_SOURCES.has(item.source)),
  );
  const blogEntries = sortByScore(
    officialConsolidated.filter((item) => !TIER1_RELEASE_SOURCES.has(item.source)),
  );
  // Apply per-source cap to blog posts, reserve slots for releases
  const blogSlots = officialLimit - releaseEntries.length;
  const cappedBlogs = selectWithPerSourceCap(
    blogEntries,
    Math.max(0, blogSlots),
    officialMaxPerSource,
  );
  const officialFinal = [...cappedBlogs, ...releaseEntries];
  officialFinal.sort((a, b) => getRelevanceScore(b) - getRelevanceScore(a));

  // Section 2 — Community Highlights: community category, capped with per-source diversity
  const communityItems = sortByScore(
    items.filter((item) => item.sourceCategory === 'community' && !usedUrls.has(item.url)),
  );
  const communityTop = selectWithPerSourceCap(communityItems, communityLimit, communityMaxPerSource);
  for (const item of communityTop) usedUrls.add(item.url);

  // Section 3 — Research & Papers: research category, capped with per-source diversity
  const researchItems = sortByScore(
    items.filter((item) => item.sourceCategory === 'research' && !usedUrls.has(item.url)),
  );
  const researchTop = selectWithPerSourceCap(researchItems, researchLimit, researchMaxPerSource);
  for (const item of researchTop) usedUrls.add(item.url);

  // Section 4 — Industry News: industry_news + remaining github, capped with per-source diversity
  const industryItems = sortByScore(
    items.filter(
      (item) =>
        (item.sourceCategory === 'industry_news' ||
          item.sourceCategory === 'github') &&
        !usedUrls.has(item.url),
    ),
  );
  const industryTop = selectWithPerSourceCap(industryItems, industryLimit, industryMaxPerSource);

  // Build sections, omitting empty ones
  const sections: SlottedSection[] = [];

  if (officialFinal.length > 0) {
    sections.push({ label: 'Official Announcements', items: officialFinal });
  }
  if (communityTop.length > 0) {
    sections.push({ label: 'Community Highlights', items: communityTop });
  }
  if (researchTop.length > 0) {
    sections.push({ label: 'Research & Papers', items: researchTop });
  }
  if (industryTop.length > 0) {
    sections.push({ label: 'Industry News', items: industryTop });
  }

  const totalItems = sections.reduce((sum, s) => sum + s.items.length, 0);

  return { sections, totalItems };
}

const SECTION_ICONS: Record<string, string> = {
  'Official Announcements': '📢',
  'Community Highlights': '🔥',
  'Research & Papers': '📄',
  'Industry News': '📰',
};

export function formatSlottedDisplayAsText(display: SlottedDisplay): string {
  const lines: string[] = [];

  for (const section of display.sections) {
    const icon = SECTION_ICONS[section.label] ?? '📋';
    lines.push(`${icon} ${section.label} (${section.items.length})`);
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    section.items.forEach((item, i) => {
      const name = sourceDisplayName(item.source);
      const score = getRelevanceScore(item);
      lines.push(`${i + 1}. [${name}] ${item.title} (score: ${score})`);
    });

    lines.push('');
  }

  lines.push(`Total: ${display.totalItems} items`);
  return lines.join('\n');
}
