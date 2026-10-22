/**
 * Short, human-readable names for every source in config/sources.yaml, as
 * readers see them ("TechCrunch", not "techcrunch_ai" or "TechCrunch AI"),
 * and how sources are classed. The one place these live: the digest, its
 * fallback and the MCP server all read them from here, and a test fails if a
 * source in sources.yaml has no entry.
 */

export const SOURCE_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  // Labs and people
  karpathy_blog: 'Andrej Karpathy',
  anthropic_blog: 'Anthropic',
  anthropic_changelog: 'Anthropic Changelog',
  claude_code_releases: 'Claude Code',
  openai_news: 'OpenAI',
  openai_codex_releases: 'OpenAI Codex',
  google_ai_blog: 'Google AI',
  deepmind_blog: 'Google DeepMind',
  google_research: 'Google Research',
  meta_ai_blog: 'Meta AI',
  xai_blog: 'xAI',
  nvidia_developer_blog: 'NVIDIA',
  sam_altman_blog: 'Sam Altman',
  steipete_blog: 'Peter Steinberger',
  vllm_releases: 'vLLM',

  // Press
  techcrunch_ai: 'TechCrunch',
  venturebeat_ai: 'VentureBeat',
  theverge_ai: 'The Verge',
  mit_tech_review_ai: 'MIT Technology Review',
  ars_technica_ai: 'Ars Technica',
  guardian_ai: 'The Guardian',
  wired_ai: 'WIRED',
  infoq_ai: 'InfoQ',
  thenewstack_ai: 'The New Stack',

  // Community
  hackernews_top: 'Hacker News',
  show_hn: 'Show HN',
  reddit_claudeai: 'r/ClaudeAI',
  reddit_localllama: 'r/LocalLLaMA',
  reddit_machinelearning: 'r/MachineLearning',
  reddit_openai: 'r/OpenAI',
  reddit_artificial: 'r/artificial',
  hf_trending_spaces: 'HF Spaces',
  devto_ai: 'Dev.to',
  github_trending: 'GitHub Trending',

  // Research
  hf_daily_papers: 'HF Papers',
  arxiv_cs_ai: 'arXiv cs.AI',
  arxiv_cs_lg: 'arXiv cs.LG',
  arxiv_cs_cv: 'arXiv cs.CV',
};

/**
 * Sources that are a lab's own channel: primary sources, and first choice to
 * represent a story. The editor's prompt flags them too.
 */
export const OFFICIAL_LAB_SOURCES: ReadonlySet<string> = new Set([
  'anthropic_blog',
  'anthropic_changelog',
  'claude_code_releases',
  'openai_news',
  'openai_codex_releases',
  'google_ai_blog',
  'deepmind_blog',
  'google_research',
  'meta_ai_blog',
  'xai_blog',
  'nvidia_developer_blog',
]);

/**
 * The tier-1/2 press: `industry_news` sources with sourceTier 1 or 2 in
 * config/sources.yaml. A test fails if the two drift apart.
 */
export const PRESS_SOURCES: ReadonlySet<string> = new Set([
  'techcrunch_ai', 'venturebeat_ai', 'theverge_ai', 'mit_tech_review_ai', 'ars_technica_ai', 'guardian_ai', 'wired_ai',
]);

/** Sources whose items are papers. */
export const PAPER_SOURCES: ReadonlySet<string> = new Set(['arxiv_cs_ai', 'arxiv_cs_lg', 'arxiv_cs_cv', 'hf_daily_papers']);

/** The display name for a source id; the id itself if it has none. */
export function sourceDisplayName(source: string): string {
  return SOURCE_DISPLAY_NAMES[source] ?? source;
}

/**
 * Publishers by domain, for Hacker News links: an HN item's URL is the
 * article itself, so the digest names who reported it ("Reuters (via HN)")
 * rather than "Hacker News". Names match SOURCE_DISPLAY_NAMES where a
 * publisher is also a direct source, so the two copies can be listed once.
 * A subdomain matches its domain (uk.reuters.com → Reuters).
 */
export const PUBLISHERS: Readonly<Record<string, string>> = {
  'reuters.com': 'Reuters',
  'apnews.com': 'AP',
  'ft.com': 'Financial Times',
  'bloomberg.com': 'Bloomberg',
  'theguardian.com': 'The Guardian',
  'nytimes.com': 'The New York Times',
  'wsj.com': 'The Wall Street Journal',
  'bbc.com': 'BBC',
  'bbc.co.uk': 'BBC',
  'washingtonpost.com': 'The Washington Post',
  'cnbc.com': 'CNBC',
  'businessinsider.com': 'Business Insider',
  'theinformation.com': 'The Information',
  'axios.com': 'Axios',
  'politico.com': 'Politico',
  'politico.eu': 'Politico',
  '404media.co': '404 Media',
  'theregister.com': 'The Register',
  'theverge.com': 'The Verge',
  'arstechnica.com': 'Ars Technica',
  'wired.com': 'WIRED',
  'techcrunch.com': 'TechCrunch',
  'technologyreview.com': 'MIT Technology Review',
  'scientificamerican.com': 'Scientific American',
  'theatlantic.com': 'The Atlantic',
  'economist.com': 'The Economist',
  'nature.com': 'Nature',
  'tomshardware.com': "Tom's Hardware",
  'zdnet.com': 'ZDNET',
  'engadget.com': 'Engadget',
  'semafor.com': 'Semafor',
  'fortune.com': 'Fortune',
  'cnn.com': 'CNN',
  'npr.org': 'NPR',
  'latimes.com': 'Los Angeles Times',
  'nbcnews.com': 'NBC News',
  'science.org': 'Science',
};

/** The URL's host without "www.", lowercased; '' if it isn't a URL. */
export function urlHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** The publisher's name for a URL, if its domain is a known one. */
export function knownPublisher(url: string): string | undefined {
  const host = urlHost(url);
  for (let h = host; h.includes('.'); h = h.slice(h.indexOf('.') + 1)) {
    if (PUBLISHERS[h]) return PUBLISHERS[h];
  }
  return undefined;
}

/** Sources whose items are Hacker News stories: their URL is usually someone else's article. */
const HN_SOURCES = new Set(['hackernews_top']);

/**
 * Who an item's reader should credit. A Hacker News link to an external
 * article names the publisher, "Reuters (via HN)", or the bare domain when
 * the publisher isn't known. HN text posts (news.ycombinator.com) stay
 * "Hacker News", and Show HN items, which link to the project itself, stay
 * "Show HN". Every other source is its display name.
 */
export function itemOutlet(source: string, url: string): { name: string; publisher: string; viaHN: boolean } {
  const host = urlHost(url);
  if (HN_SOURCES.has(source) && host && host !== 'news.ycombinator.com') {
    const publisher = knownPublisher(url) ?? host;
    return { name: `${publisher} (via HN)`, publisher, viaHN: true };
  }
  const name = sourceDisplayName(source);
  return { name, publisher: name, viaHN: false };
}
