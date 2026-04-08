/**
 * Slots-based display logic for the MCP server (Deno-compatible port).
 */

export interface NewsItem {
  title: string;
  url: string;
  source: string;
  source_category: string;
  score: number;
  summary?: string;
  authors?: string;
  fetched_at: string;
  published_at?: string;
  metadata?: Record<string, unknown>;
}

export interface SlotOptions {
  todayLimit?: number;
  todayMaxPerSource?: number;
  todayWindowHours?: number;
  officialLimit?: number;
  communityLimit?: number;
  researchLimit?: number;
  industryLimit?: number;
  officialMaxPerSource?: number;
  communityMaxPerSource?: number;
  researchMaxPerSource?: number;
  industryMaxPerSource?: number;
}

export interface SlottedSection {
  label: string;
  emoji: string;
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
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function sc(item: NewsItem): number {
  return (item.metadata?.relevanceScore as number) ?? item.score ?? 0;
}

function sortByScore(items: NewsItem[]): NewsItem[] {
  return [...items].sort((a, b) => sc(b) - sc(a));
}

function filterRecent(items: NewsItem[]): NewsItem[] {
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  return items.filter((item) => {
    const ts = item.published_at ?? item.fetched_at;
    const time = new Date(ts).getTime();
    return !isNaN(time) && time >= cutoff;
  });
}

function selectWithPerSourceCap(
  sorted: NewsItem[],
  limit: number,
  maxPerSource: number,
): NewsItem[] {
  const result: NewsItem[] = [];
  const counts = new Map<string, number>();
  for (const item of sorted) {
    if (result.length >= limit) break;
    const c = counts.get(item.source) ?? 0;
    if (c >= maxPerSource) continue;
    result.push(item);
    counts.set(item.source, c + 1);
  }
  return result;
}

const SOURCE_NAMES: Record<string, string> = {
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

export function sourceName(source: string): string {
  return SOURCE_NAMES[source] ?? source;
}

function consolidateReleases(items: NewsItem[]): NewsItem[] {
  const releases: NewsItem[] = [];
  const others: NewsItem[] = [];

  for (const item of items) {
    if (item.metadata?.tagName !== undefined) releases.push(item);
    else others.push(item);
  }
  if (releases.length === 0) return items;

  const groups = new Map<string, NewsItem[]>();
  for (const item of releases) {
    const g = groups.get(item.source) ?? [];
    g.push(item);
    groups.set(item.source, g);
  }

  const consolidated: NewsItem[] = [];
  for (const [source, group] of groups) {
    if (group.length === 1) {
      consolidated.push(group[0]);
      continue;
    }
    const sorted = [...group].sort(
      (a, b) =>
        new Date(b.published_at ?? b.fetched_at).getTime() -
        new Date(a.published_at ?? a.fetched_at).getTime(),
    );
    const newest = sorted[0];
    const oldest = sorted[sorted.length - 1];
    const newestTag = (newest.metadata?.tagName as string) ?? 'latest';
    const oldestTag = (oldest.metadata?.tagName as string) ?? 'oldest';
    const name = sourceName(source);
    const hi = Math.max(...group.map(sc));

    consolidated.push({
      ...newest,
      title: `${name}: ${group.length} releases this week (${oldestTag} → ${newestTag})`,
      score: hi,
      metadata: {
        ...newest.metadata,
        relevanceScore: hi,
        consolidatedCount: group.length,
        versionRange: `${oldestTag} → ${newestTag}`,
      },
    });
  }
  return [...others, ...consolidated];
}

export function buildSlottedDisplay(
  items: NewsItem[],
  opts?: SlotOptions,
): SlottedDisplay {
  const tL = opts?.todayLimit ?? 5;
  const tPS = opts?.todayMaxPerSource ?? 3;
  const tWH = opts?.todayWindowHours ?? 24;
  const oL = opts?.officialLimit ?? 10;
  const cL = opts?.communityLimit ?? 8;
  const rL = opts?.researchLimit ?? 6;
  const iL = opts?.industryLimit ?? 4;
  const oPS = opts?.officialMaxPerSource ?? 3;
  const cPS = opts?.communityMaxPerSource ?? 2;
  const rPS = opts?.researchMaxPerSource ?? 2;
  const iPS = opts?.industryMaxPerSource ?? 2;

  const used = new Set<string>();
  const sections: SlottedSection[] = [];

  // Section 0 — Today's Highlights: recent non-official items
  const todayCutoff = Date.now() - tWH * 60 * 60 * 1000;
  const todayItems = items.filter((i) => {
    if (i.source_category === 'company_blog' || TIER1_RELEASE_SOURCES.has(i.source)) return false;
    // Use published_at (when content was actually posted), fall back to fetched_at
    const ts = i.published_at ?? i.fetched_at;
    const time = new Date(ts).getTime();
    return !isNaN(time) && time >= todayCutoff;
  });

  if (todayItems.length > 0) {
    const todayTop = selectWithPerSourceCap(sortByScore(todayItems), tL, tPS);
    for (const i of todayTop) used.add(i.url);
    sections.push({ label: "Today's Highlights", emoji: '🆕', items: todayTop });
  }

  // Section 1 — Official
  const officialRaw = items.filter(
    (i) =>
      (i.source_category === 'company_blog' ||
        TIER1_RELEASE_SOURCES.has(i.source)) &&
      !used.has(i.url),
  );
  for (const i of officialRaw) used.add(i.url);
  for (const i of items) {
    if (i.source_category === 'company_blog' || TIER1_RELEASE_SOURCES.has(i.source)) {
      used.add(i.url);
    }
  }

  const officialRecent = filterRecent(officialRaw);
  const officialConsolidated = consolidateReleases(officialRecent);

  const releaseEntries = sortByScore(
    officialConsolidated.filter((i) => TIER1_RELEASE_SOURCES.has(i.source)),
  );
  const blogEntries = sortByScore(
    officialConsolidated.filter((i) => !TIER1_RELEASE_SOURCES.has(i.source)),
  );
  const blogSlots = oL - releaseEntries.length;
  const cappedBlogs = selectWithPerSourceCap(
    blogEntries,
    Math.max(0, blogSlots),
    oPS,
  );
  const official = [...cappedBlogs, ...releaseEntries].sort(
    (a, b) => sc(b) - sc(a),
  );

  if (official.length > 0)
    sections.push({ label: 'Official Announcements', emoji: '📢', items: official });

  // Section 2 — Community
  const community = selectWithPerSourceCap(
    sortByScore(
      items.filter((i) => i.source_category === 'community' && !used.has(i.url)),
    ),
    cL,
    cPS,
  );
  for (const i of community) used.add(i.url);
  if (community.length > 0)
    sections.push({ label: 'Community Highlights', emoji: '🔥', items: community });

  // Section 3 — Research
  const research = selectWithPerSourceCap(
    sortByScore(
      items.filter((i) => i.source_category === 'research' && !used.has(i.url)),
    ),
    rL,
    rPS,
  );
  for (const i of research) used.add(i.url);
  if (research.length > 0)
    sections.push({ label: 'Research & Papers', emoji: '📄', items: research });

  // Section 4 — Industry
  const industry = selectWithPerSourceCap(
    sortByScore(
      items.filter(
        (i) =>
          (i.source_category === 'industry_news' ||
            i.source_category === 'github') &&
          !used.has(i.url),
      ),
    ),
    iL,
    iPS,
  );
  if (industry.length > 0)
    sections.push({ label: 'Industry News', emoji: '📰', items: industry });

  return {
    sections,
    totalItems: sections.reduce((s, sec) => s + sec.items.length, 0),
  };
}

export function formatSlottedText(display: SlottedDisplay): string {
  const lines: string[] = [];
  for (const sec of display.sections) {
    lines.push(`${sec.emoji} ${sec.label} (${sec.items.length})`);
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    sec.items.forEach((item, i) => {
      const name = sourceName(item.source);
      const s = sc(item);
      lines.push(`${i + 1}. [${name}] ${item.title} (score: ${s})`);
    });
    lines.push('');
  }
  lines.push(`Total: ${display.totalItems} items`);
  return lines.join('\n');
}
