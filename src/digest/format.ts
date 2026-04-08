/**
 * Digest message formatter.
 * Renders the slotted display into a clean unicode message for messaging apps.
 */

import type { SlottedDisplay } from '../utils/slots.js';

const SECTION_ICONS: Record<string, string> = {
  "Today's Highlights": '🆕',
  'Official Announcements': '📢',
  'Community Highlights': '🔥',
  'Research & Papers': '📄',
  'Industry News': '📰',
};

/** Strip query params and tracking parameters from a URL. */
function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return (u.hostname + u.pathname).replace(/\/$/, '');
  } catch {
    return url;
  }
}

/** Truncate a title to maxLen characters. */
function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen - 3) + '...' : text;
}

/** Format a date as "Monday, April 7, 2026" in Eastern time. */
function formatDate(): string {
  const formatter = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'America/New_York',
  });
  return formatter.format(new Date());
}

/** Source display name for digest (shorter than slots version). */
function sourceTag(source: string): string {
  const TAGS: Record<string, string> = {
    anthropic_blog: 'Anthropic',
    anthropic_changelog: 'Anthropic Changelog',
    openai_news: 'OpenAI',
    google_ai_blog: 'Google AI',
    nvidia_developer_blog: 'NVIDIA',
    claude_code_releases: 'Claude Code',
    openai_codex_releases: 'OpenAI Codex',
    hackernews_top: 'HN',
    show_hn: 'Show HN',
    reddit_claudeai: 'r/ClaudeAI',
    reddit_localllama: 'r/LocalLLaMA',
    reddit_machinelearning: 'r/MachineLearning',
    reddit_artificial: 'r/artificial',
    hf_daily_papers: 'HF Papers',
    hf_trending_spaces: 'HF Spaces',
    github_trending: 'GitHub',
    arxiv_cs_ai: 'ArXiv',
    arxiv_cs_lg: 'ArXiv',
    arxiv_cs_cv: 'ArXiv',
    devto_ai: 'Dev.to',
    infoq_ai: 'InfoQ',
    thenewstack_ai: 'The New Stack',
    vllm_releases: 'vLLM',
  };
  return TAGS[source] ?? source;
}

export function formatDigestMessage(
  display: SlottedDisplay,
  newItemCount?: number,
  summary?: string,
): string {
  const lines: string[] = [];

  lines.push('🤖 AI Newsroom Daily Digest');
  lines.push(`📅 ${formatDate()}`);
  if (newItemCount !== undefined) {
    lines.push(`🆕 ${newItemCount} new items since your last digest`);
  }
  lines.push('');

  if (summary) {
    lines.push(summary);
    lines.push('');
  }

  for (const section of display.sections) {
    const icon = SECTION_ICONS[section.label] ?? '📋';
    lines.push(`${icon} ${section.label} (${section.items.length})`);
    lines.push('─────────────────────────────');

    for (const item of section.items) {
      // For community/research/industry, show source tag in brackets
      const isOfficial =
        section.label === 'Official Announcements';
      const tag = isOfficial ? '' : `[${sourceTag(item.source)}] `;
      const title = truncate(`${tag}${item.title}`, 120);
      lines.push(`• ${title}`);
      lines.push(`  → ${shortUrl(item.url)}`);
    }

    lines.push('');
  }

  lines.push('───────────────────');
  lines.push(`Total: ${display.totalItems} items | Powered by AI Newsroom`);
  lines.push('github.com/JoonJ14/ai-newsroom');

  return lines.join('\n');
}
