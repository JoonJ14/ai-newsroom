/**
 * GitHub collector.
 * - github_releases: Fetch releases from GitHub API for a specific repo.
 * - github_trending: Scrape github.com/trending with cheerio.
 */

import * as cheerio from 'cheerio';
import { createLogger } from '../utils/logger.js';
import { filterRecentItems } from '../utils/date-filter.js';
import type { NewsItem, SourceConfig } from './types.js';

const log = createLogger('github');

interface GitHubRelease {
  tag_name: string;
  name: string | null;
  html_url: string;
  body: string | null;
  author: { login: string } | null;
  published_at: string | null;
  prerelease: boolean;
  draft: boolean;
}

/**
 * Fetch releases from a GitHub repo via the API.
 */
export async function collectGitHubReleases(source: SourceConfig): Promise<NewsItem[]> {
  log.info(`Fetching GitHub releases: ${source.name}`);

  try {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ai-newsroom/0.1',
    };

    // Only attach GITHUB_TOKEN for requests to GitHub's API
    const url = new URL(source.url);
    if (process.env.GITHUB_TOKEN && url.hostname === 'api.github.com') {
      headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }

    const res = await fetch(source.url, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

    const releases = (await res.json()) as GitHubRelease[];
    const now = new Date().toISOString();
    const maxItems = source.maxItems ?? 10;

    const items: NewsItem[] = releases
      .filter((r) => !r.draft)
      .slice(0, maxItems)
      .map((r) => {
        // Extract repo name from URL: https://api.github.com/repos/owner/repo/releases
        const repoMatch = source.url.match(/repos\/([^/]+\/[^/]+)/);
        const repoName = repoMatch ? repoMatch[1] : source.id;

        return {
          title: `${repoName} ${r.name ?? r.tag_name}`,
          url: r.html_url,
          source: source.id,
          sourceCategory: source.category,
          score: 0,
          summary: r.body?.slice(0, 500) || undefined,
          authors: r.author?.login,
          tags: source.tags,
          fetchedAt: now,
          publishedAt: r.published_at ?? undefined,
          metadata: {
            tagName: r.tag_name,
            prerelease: r.prerelease,
            repo: repoName,
          },
        };
      });

    const recent = filterRecentItems(items);
    log.info(`Collected ${recent.length} releases from ${source.name} (${items.length - recent.length} filtered by date)`);
    return recent;
  } catch (err) {
    log.error(`Failed to fetch GitHub releases for ${source.name}`, (err as Error).message);
    return [];
  }
}

/**
 * Scrape github.com/trending for trending repositories.
 */
export async function collectGitHubTrending(source: SourceConfig): Promise<NewsItem[]> {
  log.info(`Fetching GitHub trending: ${source.name}`);

  try {
    const res = await fetch(source.url, {
      headers: {
        'User-Agent': 'ai-newsroom/0.1',
        Accept: 'text/html',
      },
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

    const html = await res.text();
    const $ = cheerio.load(html);
    const now = new Date().toISOString();
    const maxItems = source.maxItems ?? 25;

    const items: NewsItem[] = [];

    $('article.Box-row').each((i, el) => {
      if (i >= maxItems) return false; // cheerio .each break

      const $el = $(el);
      const repoPath = $el.find('h2 a').attr('href')?.trim();
      if (!repoPath) return;

      const repoName = repoPath.replace(/^\//, '');
      const description = $el.find('p').first().text().trim() || undefined;
      const language = $el.find('[itemprop="programmingLanguage"]').text().trim() || undefined;

      // Parse stars today text like "1,234 stars today"
      const starsText = $el.find('.float-sm-right, .d-inline-block.float-sm-right').text().trim();
      const starsMatch = starsText.match(/([\d,]+)\s*stars?\s*today/i);
      const starsToday = starsMatch ? parseInt(starsMatch[1].replace(/,/g, ''), 10) : 0;

      items.push({
        title: repoName,
        url: `https://github.com${repoPath}`,
        source: source.id,
        sourceCategory: source.category,
        score: starsToday,
        summary: description,
        tags: source.tags,
        fetchedAt: now,
        metadata: {
          language,
          starsToday,
        },
      });
    });

    // GitHub trending has no publishedAt — all items pass date filter (assumed today)
    log.info(`Collected ${items.length} trending repos from ${source.name}`);
    return items;
  } catch (err) {
    log.error(`Failed to fetch GitHub trending for ${source.name}`, (err as Error).message);
    return [];
  }
}
