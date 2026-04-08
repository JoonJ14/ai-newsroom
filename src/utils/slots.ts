/**
 * Slots-based display layout for get_top_picks.
 * Divides scored items into five sections:
 * 0. Today's Highlights (items from the last 24h) — shown first
 * 1. Official Announcements (company_blog + Tier 1 releases) — capped, releases consolidated
 * 2. Community Highlights (community sources) — capped
 * 3. Research & Papers (research sources) — capped
 * 4. Industry News (industry_news + remaining github) — capped
 */

import type { NewsItem, SourceCategory } from '../collectors/types.js';

export interface SlotOptions {
  todayLimit?: number;            // default 10
  todayMaxPerSource?: number;     // default 3
  todayWindowHours?: number;      // default 24
  officialLimit?: number;         // default 10
  communityLimit?: number;        // default 8
  researchLimit?: number;         // default 6
  industryLimit?: number;         // default 4
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
 */
function consolidateReleases(items: NewsItem[]): NewsItem[] {
  const releaseItems: NewsItem[] = [];
  const nonReleaseItems: NewsItem[] = [];

  for (const item of items) {
    if (item.metadata?.tagName !== undefined) {
      releaseItems.push(item);
    } else {
      nonReleaseItems.push(item);
    }
  }

  if (releaseItems.length === 0) return items;

  const groups = new Map<string, NewsItem[]>();
  for (const item of releaseItems) {
    const existing = groups.get(item.source) ?? [];
    existing.push(item);
    groups.set(item.source, existing);
  }

  const consolidated: NewsItem[] = [];
  for (const [source, group] of groups) {
    if (group.length === 1) {
      consolidated.push(group[0]);
      continue;
    }

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
  const todayLimit = options?.todayLimit ?? 5;
  const todayMaxPerSource = options?.todayMaxPerSource ?? 3;
  const todayWindowHours = options?.todayWindowHours ?? 24;
  const officialLimit = options?.officialLimit ?? 10;
  const communityLimit = options?.communityLimit ?? 8;
  const researchLimit = options?.researchLimit ?? 6;
  const industryLimit = options?.industryLimit ?? 4;
  const officialMaxPerSource = options?.officialMaxPerSource ?? 3;
  const communityMaxPerSource = options?.communityMaxPerSource ?? 2;
  const researchMaxPerSource = options?.researchMaxPerSource ?? 2;
  const industryMaxPerSource = options?.industryMaxPerSource ?? 2;

  const usedUrls = new Set<string>();
  const sections: SlottedSection[] = [];

  // Section 0 — Today's Highlights: recent non-official items
  // Official items (company_blog + Tier 1 releases) go in their own section
  const todayCutoff = Date.now() - todayWindowHours * 60 * 60 * 1000;
  const todayItems = items.filter((item) => {
    if (item.sourceCategory === 'company_blog' || TIER1_RELEASE_SOURCES.has(item.source)) return false;
    // Use publishedAt (when content was actually posted), fall back to fetchedAt
    const ts = item.publishedAt ?? item.fetchedAt;
    const time = new Date(ts).getTime();
    return !isNaN(time) && time >= todayCutoff;
  });

  if (todayItems.length > 0) {
    const todayTop = selectWithPerSourceCap(
      sortByScore(todayItems),
      todayLimit,
      todayMaxPerSource,
    );
    for (const item of todayTop) usedUrls.add(item.url);
    sections.push({ label: "Today's Highlights", items: todayTop });
  }

  // Section 1 — Official Announcements: company_blog + Tier 1 releases
  const officialRaw = items.filter(
    (item) =>
      (item.sourceCategory === 'company_blog' ||
        TIER1_RELEASE_SOURCES.has(item.source)) &&
      !usedUrls.has(item.url),
  );
  // Mark ALL official items as used to prevent leaking to other sections
  for (const item of officialRaw) usedUrls.add(item.url);
  // Also mark items that WOULD be official but are already in Today's Highlights
  for (const item of items) {
    if (item.sourceCategory === 'company_blog' || TIER1_RELEASE_SOURCES.has(item.source)) {
      usedUrls.add(item.url);
    }
  }

  const officialRecent = filterRecent(officialRaw);
  const officialConsolidated = consolidateReleases(officialRecent);

  const releaseEntries = sortByScore(
    officialConsolidated.filter((item) => TIER1_RELEASE_SOURCES.has(item.source)),
  );
  const blogEntries = sortByScore(
    officialConsolidated.filter((item) => !TIER1_RELEASE_SOURCES.has(item.source)),
  );
  const blogSlots = officialLimit - releaseEntries.length;
  const cappedBlogs = selectWithPerSourceCap(
    blogEntries,
    Math.max(0, blogSlots),
    officialMaxPerSource,
  );
  const officialFinal = [...cappedBlogs, ...releaseEntries];
  officialFinal.sort((a, b) => getRelevanceScore(b) - getRelevanceScore(a));

  if (officialFinal.length > 0) {
    sections.push({ label: 'Official Announcements', items: officialFinal });
  }

  // Section 2 — Community Highlights
  const communityItems = sortByScore(
    items.filter((item) => item.sourceCategory === 'community' && !usedUrls.has(item.url)),
  );
  const communityTop = selectWithPerSourceCap(communityItems, communityLimit, communityMaxPerSource);
  for (const item of communityTop) usedUrls.add(item.url);
  if (communityTop.length > 0) {
    sections.push({ label: 'Community Highlights', items: communityTop });
  }

  // Section 3 — Research & Papers
  const researchItems = sortByScore(
    items.filter((item) => item.sourceCategory === 'research' && !usedUrls.has(item.url)),
  );
  const researchTop = selectWithPerSourceCap(researchItems, researchLimit, researchMaxPerSource);
  for (const item of researchTop) usedUrls.add(item.url);
  if (researchTop.length > 0) {
    sections.push({ label: 'Research & Papers', items: researchTop });
  }

  // Section 4 — Industry News
  const industryItems = sortByScore(
    items.filter(
      (item) =>
        (item.sourceCategory === 'industry_news' ||
          item.sourceCategory === 'github') &&
        !usedUrls.has(item.url),
    ),
  );
  const industryTop = selectWithPerSourceCap(industryItems, industryLimit, industryMaxPerSource);
  if (industryTop.length > 0) {
    sections.push({ label: 'Industry News', items: industryTop });
  }

  const totalItems = sections.reduce((sum, s) => sum + s.items.length, 0);
  return { sections, totalItems };
}

const SECTION_ICONS: Record<string, string> = {
  "Today's Highlights": '🆕',
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
