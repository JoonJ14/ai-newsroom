/**
 * Slots-based display logic for the MCP server (Deno-compatible port).
 */

export interface NewsItem {
  /** Primary key. Identity is per-row: the unique index is (url, source), so
   *  two sources carrying the same link are distinct rows. */
  id?: string;
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
  /**
   * Drop every non-numeric reduction as well as the caps: the 7-day recency
   * window on official items and the collapsing of multiple releases into one.
   * Raising the limits alone does not make every cached row reachable, so
   * "show everything" needs this too.
   */
  unfiltered?: boolean;
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

/** Row identity for dedup. Falls back to url+source when id is absent. */
function key(item: NewsItem): string {
  return item.id ?? `${item.url}\u0000${item.source}`;
}

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
  deepmind_blog: 'Google DeepMind',
  meta_ai_blog: 'Meta AI',
  xai_blog: 'xAI',
  nvidia_developer_blog: 'NVIDIA',
  karpathy_blog: 'Andrej Karpathy',
  sam_altman_blog: 'Sam Altman',
  steipete_blog: 'Peter Steinberger',
  claude_code_releases: 'Claude Code',
  openai_codex_releases: 'OpenAI Codex',
  techcrunch_ai: 'TechCrunch',
  venturebeat_ai: 'VentureBeat',
  theverge_ai: 'The Verge',
  mit_tech_review_ai: 'MIT Tech Review',
  hackernews_top: 'Hacker News',
  show_hn: 'Show HN',
  reddit_claudeai: 'r/ClaudeAI',
  reddit_localllama: 'r/LocalLLaMA',
  reddit_machinelearning: 'r/MachineLearning',
  reddit_openai: 'r/OpenAI',
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
  // The tool schema only says "number", so a caller can send a negative or NaN
  // limit. Those must not reach slice()/comparisons: slice(0, -1) has
  // from-the-end semantics and would drop the last entry instead of returning
  // none, and NaN comparisons are silently always false.
  const limit = (value: number | undefined, fallback: number): number => {
    if (value === undefined || Number.isNaN(value)) return fallback;
    if (value < 0) return 0;
    // Floor finite values: slice() truncates a fractional limit while
    // selectWithPerSourceCap() checks before pushing and so effectively rounds
    // up, meaning officialLimit: 1.5 could yield two items.
    return Number.isFinite(value) ? Math.floor(value) : value;
  };

  // Durations are not counts: flooring turns a legitimate 0.5-hour window into
  // zero. Only negatives and NaN are corrected.
  const duration = (value: number | undefined, fallback: number): number => {
    if (value === undefined || Number.isNaN(value)) return fallback;
    return value < 0 ? 0 : value;
  };

  const tL = limit(opts?.todayLimit, 5);
  const tPS = limit(opts?.todayMaxPerSource, 3);
  const tWH = duration(opts?.todayWindowHours, 24);
  const oL = limit(opts?.officialLimit, 10);
  const cL = limit(opts?.communityLimit, 8);
  const rL = limit(opts?.researchLimit, 6);
  const iL = limit(opts?.industryLimit, 4);
  const oPS = limit(opts?.officialMaxPerSource, 3);
  const cPS = limit(opts?.communityMaxPerSource, 2);
  const rPS = limit(opts?.researchMaxPerSource, 2);
  const iPS = limit(opts?.industryMaxPerSource, 2);

  const unfiltered = opts?.unfiltered === true;

  const used = new Set<string>();
  const sections: SlottedSection[] = [];

  // Section 0 — Today's Highlights: recent non-official items
  const todayCutoff = Date.now() - tWH * 60 * 60 * 1000;
  const todayItems = items.filter((i) => {
    if (i.source_category === 'company_blog' || TIER1_RELEASE_SOURCES.has(i.source)) return false;
    // Only include items with a real published_at — no fallback to fetched_at
    if (!i.published_at) return false;
    const time = new Date(i.published_at).getTime();
    return !isNaN(time) && time >= todayCutoff;
  });

  const todayTop = selectWithPerSourceCap(sortByScore(todayItems), tL, tPS);
  // Presence is decided AFTER the limit is applied — todayLimit: 0 previously
  // emitted an empty section while every other zero-limit section was omitted.
  if (todayTop.length > 0) {
    for (const i of todayTop) used.add(key(i));
    sections.push({ label: "Today's Highlights", emoji: '🆕', items: todayTop });
  }

  // Section 1 — Official
  const officialRaw = items.filter(
    (i) =>
      (i.source_category === 'company_blog' ||
        TIER1_RELEASE_SOURCES.has(i.source)) &&
      !used.has(key(i)),
  );
  for (const i of officialRaw) used.add(key(i));
  for (const i of items) {
    if (i.source_category === 'company_blog' || TIER1_RELEASE_SOURCES.has(i.source)) {
      used.add(key(i));
    }
  }

  const officialRecent = unfiltered ? officialRaw : filterRecent(officialRaw);
  const officialConsolidated = unfiltered
    ? officialRecent
    : consolidateReleases(officialRecent);

  const releaseEntries = sortByScore(
    officialConsolidated.filter((i) => TIER1_RELEASE_SOURCES.has(i.source)),
  );
  const blogEntries = sortByScore(
    officialConsolidated.filter((i) => !TIER1_RELEASE_SOURCES.has(i.source)),
  );
  // Releases take priority but are still bounded by officialLimit — previously
  // they were appended uncapped, so with more release entries than the limit
  // the section could exceed the maximum the caller asked for.
  const cappedReleases = releaseEntries.slice(0, oL);
  const blogSlots = oL - cappedReleases.length;
  const cappedBlogs = selectWithPerSourceCap(
    blogEntries,
    Math.max(0, blogSlots),
    oPS,
  );
  const official = [...cappedBlogs, ...cappedReleases].sort(
    (a, b) => sc(b) - sc(a),
  );

  if (official.length > 0)
    sections.push({ label: 'Official Announcements', emoji: '📢', items: official });

  // Section 2 — Community
  const community = selectWithPerSourceCap(
    sortByScore(
      items.filter((i) => i.source_category === 'community' && !used.has(key(i))),
    ),
    cL,
    cPS,
  );
  for (const i of community) used.add(key(i));
  if (community.length > 0)
    sections.push({ label: 'Community Highlights', emoji: '🔥', items: community });

  // Section 3 — Research
  const research = selectWithPerSourceCap(
    sortByScore(
      items.filter((i) => i.source_category === 'research' && !used.has(key(i))),
    ),
    rL,
    rPS,
  );
  for (const i of research) used.add(key(i));
  if (research.length > 0)
    sections.push({ label: 'Research & Papers', emoji: '📄', items: research });

  // Section 4 — Industry
  const industry = selectWithPerSourceCap(
    sortByScore(
      items.filter(
        (i) =>
          (i.source_category === 'industry_news' ||
            i.source_category === 'github') &&
          !used.has(key(i)),
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
