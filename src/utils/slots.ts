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
  topStoryLimit?: number;
  todayLimit?: number;
  todayMaxPerSource?: number;
  todayWindowHours?: number;
  officialLimit?: number;
  officialMaxPerSource?: number;
  fieldLimit?: number;
  fieldMaxPerSource?: number;
  communityLimit?: number;
  communityMaxPerSource?: number;
  researchLimit?: number;
  researchMaxPerSource?: number;
  industryLimit?: number;
  industryMaxPerSource?: number;
  sourceDigestCaps?: Map<string, number>;
}

export interface SlottedSection {
  label: string;
  items: NewsItem[];
}

export interface SlottedDisplay {
  sections: SlottedSection[];
  totalItems: number;
}

const TIER1_RELEASE_SOURCES = new Set([
  'claude_code_releases',
  'openai_codex_releases',
]);

const OFFICIAL_LAB_SOURCES = new Set([
  'anthropic_blog',
  'anthropic_changelog',
  'claude_code_releases',
  'openai_news',
  'openai_codex_releases',
  'google_ai_blog',
  'deepmind_blog',
]);

const FROM_THE_FIELD_SOURCES = new Set([
  'techcrunch_ai',
  'venturebeat_ai',
  'theverge_ai',
  'mit_tech_review_ai',
  'meta_ai_blog',
  'xai_blog',
  'nvidia_developer_blog',
  'sam_altman_blog',
  'steipete_blog',
  'google_research',
  'vllm_releases',
]);
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
  karpathy_blog: 'Karpathy',
  deepmind_blog: 'DeepMind',
  meta_ai_blog: 'Meta AI',
  xai_blog: 'xAI',
  sam_altman_blog: 'Sam Altman',
  steipete_blog: 'Peter Steinberger',
  techcrunch_ai: 'TechCrunch',
  venturebeat_ai: 'VentureBeat',
  theverge_ai: 'The Verge',
  mit_tech_review_ai: 'MIT Tech Review',
  reddit_openai: 'r/OpenAI',
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
  const topStoryLimit = options?.topStoryLimit ?? 1;
  const todayLimit = options?.todayLimit ?? 5;
  const todayMaxPerSource = options?.todayMaxPerSource ?? 2;
  const todayWindowHours = options?.todayWindowHours ?? 24;
  const officialLimit = options?.officialLimit ?? 5;
  const officialMaxPerSource = options?.officialMaxPerSource ?? 2;
  const fieldLimit = options?.fieldLimit ?? 3;
  const fieldMaxPerSource = options?.fieldMaxPerSource ?? 1;
  const communityLimit = options?.communityLimit ?? 3;
  const communityMaxPerSource = options?.communityMaxPerSource ?? 2;
  const researchLimit = options?.researchLimit ?? 3;
  const researchMaxPerSource = options?.researchMaxPerSource ?? 2;
  const industryLimit = options?.industryLimit ?? 2;
  const industryMaxPerSource = options?.industryMaxPerSource ?? 1;
  const sourceDigestCaps = options?.sourceDigestCaps ?? new Map<string, number>();

  const usedUrls = new Set<string>();
  const sections: SlottedSection[] = [];

  function selectCapped(
    sorted: NewsItem[],
    limit: number,
    maxPerSource: number,
  ): NewsItem[] {
    const result: NewsItem[] = [];
    const sourceCounts = new Map<string, number>();
    for (const item of sorted) {
      if (result.length >= limit) break;
      const count = sourceCounts.get(item.source) ?? 0;
      const digestCap = sourceDigestCaps.get(item.source) ?? Infinity;
      const effectiveCap = Math.min(maxPerSource, digestCap);
      if (count >= effectiveCap) continue;
      result.push(item);
      sourceCounts.set(item.source, count + 1);
    }
    return result;
  }

  // Section 0 — Top Story
  // Single highest-scoring item from the entire pool.
  // Karpathy has scoreFloor=90 so he almost always wins when he posts.
  // A major breaking story with high recency + community signal can also win.
  const allSorted = sortByScore(filterRecent(items));
  const topStoryItems = selectCapped(allSorted, topStoryLimit, 1);
  for (const item of topStoryItems) usedUrls.add(item.url);
  if (topStoryItems.length > 0) {
    sections.push({ label: 'Top Story', items: topStoryItems });
  }

  // Section 1 — Today's Highlights
  // Non-official items published in the last 24h.
  // OFFICIAL_LAB_SOURCES are excluded here — they go in Official Announcements.
  const todayCutoff = Date.now() - todayWindowHours * 60 * 60 * 1000;
  const todayItems = items.filter((item) => {
    if (OFFICIAL_LAB_SOURCES.has(item.source)) return false;
    if (!item.publishedAt) return false;
    const time = new Date(item.publishedAt).getTime();
    return !isNaN(time) && time >= todayCutoff && !usedUrls.has(item.url);
  });
  const todayTop = selectCapped(sortByScore(todayItems), todayLimit, todayMaxPerSource);
  for (const item of todayTop) usedUrls.add(item.url);
  if (todayTop.length > 0) {
    sections.push({ label: "Today's Highlights", items: todayTop });
  }

  // Section 2 — Official Announcements
  // Tier 1 official labs only: Anthropic, OpenAI, Google AI, DeepMind.
  const officialRaw = filterRecent(
    items.filter((item) => OFFICIAL_LAB_SOURCES.has(item.source) && !usedUrls.has(item.url))
  );
  for (const item of officialRaw) usedUrls.add(item.url);
  const officialConsolidated = consolidateReleases(officialRaw);
  const releaseEntries = sortByScore(
    officialConsolidated.filter((item) => TIER1_RELEASE_SOURCES.has(item.source))
  );
  const blogEntries = sortByScore(
    officialConsolidated.filter((item) => !TIER1_RELEASE_SOURCES.has(item.source))
  );
  const blogSlots = officialLimit - releaseEntries.length;
  const cappedBlogs = selectCapped(blogEntries, Math.max(0, blogSlots), officialMaxPerSource);
  const officialFinal = [...cappedBlogs, ...releaseEntries];
  officialFinal.sort((a, b) => getRelevanceScore(b) - getRelevanceScore(a));
  if (officialFinal.length > 0) {
    sections.push({ label: 'Official Announcements', items: officialFinal });
  }

  // Section 3 — From the Field
  // Tier 2: press + individuals + secondary labs.
  // No score floors — compete purely on recency + community signal.
  // Guaranteed dedicated slots so press is never crowded out by busy lab days.
  const fieldItems = sortByScore(
    filterRecent(
      items.filter((item) =>
        FROM_THE_FIELD_SOURCES.has(item.source) && !usedUrls.has(item.url)
      )
    )
  );
  const fieldTop = selectCapped(fieldItems, fieldLimit, fieldMaxPerSource);
  for (const item of fieldTop) usedUrls.add(item.url);
  if (fieldTop.length > 0) {
    sections.push({ label: 'From the Field', items: fieldTop });
  }

  // Section 4 — Community Highlights
  const communityItems = sortByScore(
    items.filter((item) =>
      item.sourceCategory === 'community' &&
      !OFFICIAL_LAB_SOURCES.has(item.source) &&
      !FROM_THE_FIELD_SOURCES.has(item.source) &&
      !usedUrls.has(item.url)
    )
  );
  const communityTop = selectCapped(communityItems, communityLimit, communityMaxPerSource);
  for (const item of communityTop) usedUrls.add(item.url);
  if (communityTop.length > 0) {
    sections.push({ label: 'Community Highlights', items: communityTop });
  }

  // Section 5 — Research & Papers
  const researchItems = sortByScore(
    items.filter((item) =>
      item.sourceCategory === 'research' &&
      !FROM_THE_FIELD_SOURCES.has(item.source) &&
      !usedUrls.has(item.url)
    )
  );
  const researchTop = selectCapped(researchItems, researchLimit, researchMaxPerSource);
  for (const item of researchTop) usedUrls.add(item.url);
  if (researchTop.length > 0) {
    sections.push({ label: 'Research & Papers', items: researchTop });
  }

  // Section 6 — Industry & Tools
  const industryItems = sortByScore(
    items.filter((item) =>
      (item.sourceCategory === 'industry_news' || item.sourceCategory === 'github') &&
      !OFFICIAL_LAB_SOURCES.has(item.source) &&
      !FROM_THE_FIELD_SOURCES.has(item.source) &&
      !usedUrls.has(item.url)
    )
  );
  const industryTop = selectCapped(industryItems, industryLimit, industryMaxPerSource);
  if (industryTop.length > 0) {
    sections.push({ label: 'Industry & Tools', items: industryTop });
  }

  const totalItems = sections.reduce((sum, s) => sum + s.items.length, 0);
  return { sections, totalItems };
}

const SECTION_ICONS: Record<string, string> = {
  'Top Story': '🔝',
  "Today's Highlights": '🆕',
  'Official Announcements': '📢',
  'From the Field': '📰',
  'Community Highlights': '🔥',
  'Research & Papers': '📄',
  'Industry & Tools': '⚙️',
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
