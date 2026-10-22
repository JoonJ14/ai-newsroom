/**
 * MCP tool handlers backed by the news_items cache. Each reads (data.ts) and
 * shapes the answer with the shared story code (present.ts), so it serves the
 * AI editor's judgments the way the morning digest does. Reads only.
 *
 * Every list returns `items`: one entry per story, in the field names the
 * tools have always used plus the editor's (headline, why, importance, type,
 * audience, story_key, followup, outlets, published_at), null when unjudged.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.102.1';
import { sourceDisplayName } from '../../_shared/newsroom/source-names.ts';
import { BUILD_COMMIT, BUILT_AT } from './build-info.ts';
import { fetchLatest, fetchRows, SERVER_MAX_ROWS, type FetchResult } from './data.ts';
import {
  editorStatus, entriesText, InvalidParameter, parseFilters, parseLimit, parseSince, rankEntries, topPicks,
  topPicksText, type NewsEntry,
} from './present.ts';

const HOUR_MS = 60 * 60 * 1000;

/** Matches read per search column before ranking; past this the answer says it is partial. */
const SEARCH_MAX_ROWS = 5000;
const hoursAgo = (h: number) => new Date(Date.now() - h * HOUR_MS).toISOString();

const TRUNCATED_NOTE = '\n\n(Note: more items matched than this tool reads at once, so the oldest are not included.)';

function listResult(entries: NewsEntry[], limit: number, empty: string, header = '', fetched?: FetchResult) {
  const shown = entries.slice(0, limit);
  return {
    type: 'text',
    text: (shown.length === 0 ? empty : `${header}${entriesText(shown)}`) + (fetched?.truncated ? TRUNCATED_NOTE : ''),
    items: shown,
    total: shown.length,
    ...(fetched?.truncated ? { truncated: true } : {}),
  };
}

// ─── get_top_picks ───────────────────────────────────────────────

export async function handleGetTopPicks(sb: SupabaseClient, params: Record<string, unknown>) {
  const since = parseSince(params.since);
  let hours = 24;
  if (params.hours !== undefined && params.hours !== null) {
    hours = Number(params.hours);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 90) throw new InvalidParameter('hours must be a number from 1 to 2160');
  }
  const from = since ?? hoursAgo(hours);
  const showAll = params.showAll === true;

  const fetched = await fetchRows(sb, { since: from }, 10_000);
  const picks = topPicks(fetched.items, {
    showAll,
    editorColumns: fetched.editorColumns,
    legacy: {
      officialLimit: params.officialLimit as number | undefined,
      communityLimit: params.communityLimit as number | undefined,
      researchLimit: params.researchLimit as number | undefined,
      industryLimit: params.industryLimit as number | undefined,
    },
  });
  const label = since ? `since ${since}` : `the last ${hours} hours`;
  return {
    type: 'text',
    text: topPicksText(picks, label) + (fetched.truncated ? TRUNCATED_NOTE : ''),
    mode: picks.mode,
    window: { from, to: new Date().toISOString() },
    sections: picks.sections,
    totalItems: picks.sections.reduce((n, s) => n + s.items.length, 0),
    itemsInWindow: picks.total,
    judgedInWindow: picks.judged,
    ...(picks.note ? { note: picks.note } : {}),
    truncated: fetched.truncated,
  };
}

// ─── get_trending ────────────────────────────────────────────────

export async function handleGetTrending(sb: SupabaseClient, params: Record<string, unknown>) {
  const limit = parseLimit(params.limit, 50);
  const filters = parseFilters(params);
  // Ranked by importance, so a window is needed: the cache holds 90 days
  const since = parseSince(params.since) ?? hoursAgo(24 * 7);
  const fetched = await fetchRows(sb, {
    since,
    source: params.source as string | undefined,
    category: params.category as string | undefined,
  });
  return { ...listResult(rankEntries(fetched.items, filters), limit, 'No items match.', '', fetched), since };
}

// ─── search ──────────────────────────────────────────────────────

export async function handleSearch(sb: SupabaseClient, params: Record<string, unknown>) {
  const queryStr = params.query as string;
  if (!queryStr) throw new Error('Missing required parameter: query');
  const since = parseSince(params.since);
  const filters = parseFilters(params);
  const limit = parseLimit(params.limit, 30);

  // Titles and the editor's headlines; summaries too when those find little.
  // Every match is read (paged) before ranking and filtering: capping first,
  // by the old score, would drop an important story with a low score.
  // Every query carries the same `since` bound.
  const [titles, headlines] = await Promise.all([
    fetchRows(sb, { since, search: { column: 'title', query: queryStr } }, SEARCH_MAX_ROWS),
    fetchRows(sb, { since, search: { column: 'editor_headline', query: queryStr } }, SEARCH_MAX_ROWS),
  ]);
  const found = new Map<string, FetchResult['items'][number]>();
  for (const i of [...titles.items, ...headlines.items]) found.set(i.id, i);
  let truncated = titles.truncated || headlines.truncated;
  if (found.size < 5) {
    const summaries = await fetchRows(sb, { since, search: { column: 'summary', query: queryStr } }, SEARCH_MAX_ROWS);
    for (const i of summaries.items) found.set(i.id, i);
    truncated ||= summaries.truncated;
  }

  return {
    ...listResult(rankEntries([...found.values()], filters), limit, `No results found for "${queryStr}".`, '',
      { items: [], truncated, editorColumns: true }),
    query: queryStr,
  };
}

// ─── get_new_since ───────────────────────────────────────────────

export async function handleGetNewSince(sb: SupabaseClient, params: Record<string, unknown>) {
  if (!params.since) throw new Error('Missing required parameter: since');
  const since = parseSince(params.since)!;
  const limit = parseLimit(params.limit, 50);
  const filters = parseFilters(params);
  const fetched = await fetchRows(sb, { since });
  const entries = rankEntries(fetched.items, filters);
  return {
    ...listResult(entries, limit, `No new items since ${since}.`, `${Math.min(limit, entries.length)} of ${entries.length} stories since ${since}:\n`, fetched),
    since,
  };
}

// ─── get_source_updates ──────────────────────────────────────────

export async function handleGetSourceUpdates(sb: SupabaseClient, params: Record<string, unknown>) {
  const source = params.source as string;
  if (!source) throw new Error('Missing required parameter: source');
  const limit = parseLimit(params.limit, 20);
  const filters = parseFilters(params);
  // The source's newest items (that match the filters: applied in the query, so
  // the cap below can't hide a match), then ranked: the best of what's recent first
  const fetched = await fetchLatest(sb, { source, editor: filters }, Math.min(Math.max(limit * 3, 60), SERVER_MAX_ROWS));
  return {
    ...listResult(rankEntries(fetched.items, filters), limit, `No items found for source "${source}".`,
      `Latest from ${sourceDisplayName(source)}, most important first:\n`),
    source,
  };
}

// ─── check_status ────────────────────────────────────────────────

export async function handleCheckStatus(sb: SupabaseClient) {
  // Last updated. NULLs are excluded explicitly: Postgres sorts NULLS FIRST on
  // DESC, so a single row without a timestamp made this report "never".
  const { data: latestRow, error: e2 } = await sb
    .from('news_items')
    .select('fetched_at')
    .not('fetched_at', 'is', null)
    .order('fetched_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (e2) throw new Error(e2.message);

  // Per-source breakdown, paged: an uncapped select returns only db-max-rows
  // (1000) of a cache several times that size
  const allItems: { source: string; fetched_at: string }[] = [];
  {
    let cursor: string | null = null;
    for (let guard = 0; guard < 1000; guard++) {
      let q = sb.from('news_items').select('id, source, fetched_at').order('id', { ascending: true }).limit(SERVER_MAX_ROWS);
      if (cursor !== null) q = q.gt('id', cursor);
      const { data: page, error: e3 } = await q;
      if (e3) throw new Error(e3.message);
      if (!page || page.length === 0) break;
      allItems.push(...(page as typeof allItems));
      cursor = (page[page.length - 1] as { id: string }).id;
      if (page.length < SERVER_MAX_ROWS) break;
    }
  }
  // Derived from the same scan, so the total and the breakdown always agree
  const totalItems = allItems.length;
  const breakdown: Record<string, { count: number; latest: string }> = {};
  for (const row of allItems) {
    const entry = breakdown[row.source] ?? { count: 0, latest: '' };
    entry.count++;
    if (row.fetched_at > entry.latest) entry.latest = row.fetched_at;
    breakdown[row.source] = entry;
  }
  const sourcesBreakdown = Object.entries(breakdown)
    .map(([source, { count, latest }]) => ({ source, displayName: sourceDisplayName(source), count, latestItem: latest }))
    .sort((a, b) => b.count - a.count);

  // The AI editor: coverage of the last 24 hours, and its newest judgment
  const lastDay = await fetchRows(sb, { since: hoursAgo(24) });
  const editor = editorStatus(lastDay.items);
  let newestJudgedAt: string | null = null;
  if (lastDay.editorColumns) {
    const { data, error } = await sb
      .from('news_items')
      .select('editor_judged_at')
      .not('editor_judged_at', 'is', null)
      .order('editor_judged_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    newestJudgedAt = (data as { editor_judged_at?: string } | null)?.editor_judged_at ?? null;
  }

  const lastUpdated = latestRow?.fetched_at ?? 'never';
  const share = editor.judgedShare === null ? 'no items' : `${Math.round(editor.judgedShare * 100)}% (${editor.judged} of ${editor.items})`;
  const text = [
    `Cache Status`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `Total items: ${totalItems}`,
    `Last updated: ${lastUpdated}`,
    `Retention: 90 days`,
    ``,
    `AI editor, last 24 hours: ${share} judged`,
    `Newest judgment: ${newestJudgedAt ?? 'none'}`,
    `Rubric version(s): ${editor.rubricVersions.join(', ') || 'none'}`,
    `Deployed commit: ${BUILD_COMMIT}${BUILT_AT ? ` (${BUILT_AT})` : ''}`,
    ``,
    `Per-source breakdown:`,
    ...sourcesBreakdown.map((s) => `  ${s.displayName} (${s.source}): ${s.count} items`),
  ].join('\n');

  return {
    type: 'text',
    text,
    lastUpdated,
    totalItems,
    retentionDays: 90,
    sourcesBreakdown,
    editor: { last24h: editor, newestJudgedAt, columnsPresent: lastDay.editorColumns },
    deployment: { commit: BUILD_COMMIT, builtAt: BUILT_AT || null },
  };
}
