/**
 * Short, human-readable names for every source in config/sources.yaml, as
 * readers see them in the digest ("TechCrunch", not "techcrunch_ai" or
 * "TechCrunch AI"). The one place these live: the digest, its fallback and the
 * slotted display all read them from here, and a test fails if a source in
 * sources.yaml has no entry.
 *
 * No imports on purpose, so the MCP Edge Function (Deno) can adopt this file
 * as it is in step 4 of the ranking rebuild, replacing its own copy in
 * supabase/functions/mcp/_shared/slots.ts.
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

/** The display name for a source id; the id itself if it has none. */
export function sourceDisplayName(source: string): string {
  return SOURCE_DISPLAY_NAMES[source] ?? source;
}
