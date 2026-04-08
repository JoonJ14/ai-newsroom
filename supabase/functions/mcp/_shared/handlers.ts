/**
 * MCP Tool handler implementations — DB queries for each tool.
 */

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  buildSlottedDisplay,
  formatSlottedText,
  sourceName,
  type NewsItem,
  type SlotOptions,
} from './slots.ts';

function formatItem(row: NewsItem) {
  return {
    title: row.title,
    url: row.url,
    source: sourceName(row.source),
    sourceId: row.source,
    category: row.source_category,
    score: (row.metadata?.relevanceScore as number) ?? row.score,
    summary: row.summary ?? null,
    authors: row.authors ?? null,
    publishedAt: row.published_at ?? null,
    fetchedAt: row.fetched_at,
  };
}

// ─── get_top_picks ───────────────────────────────────────────────

export async function handleGetTopPicks(
  sb: SupabaseClient,
  params: Record<string, unknown>,
) {
  const showAll = params.showAll === true;
  const opts: SlotOptions = showAll
    ? {
        officialLimit: 9999,
        communityLimit: 9999,
        researchLimit: 9999,
        industryLimit: 9999,
        officialMaxPerSource: 9999,
        communityMaxPerSource: 9999,
        researchMaxPerSource: 9999,
        industryMaxPerSource: 9999,
      }
    : {
        officialLimit: (params.officialLimit as number) ?? 15,
        communityLimit: (params.communityLimit as number) ?? 5,
        researchLimit: (params.researchLimit as number) ?? 3,
        industryLimit: (params.industryLimit as number) ?? 2,
      };

  const { data, error } = await sb
    .from('news_items')
    .select('*')
    .order('score', { ascending: false })
    .limit(500);

  if (error) throw new Error(error.message);

  const display = buildSlottedDisplay(data as NewsItem[], opts);
  const text = formatSlottedText(display);

  return {
    type: 'text',
    text,
    sections: display.sections.map((sec) => ({
      label: sec.label,
      emoji: sec.emoji,
      items: sec.items.map(formatItem),
    })),
    totalItems: display.totalItems,
  };
}

// ─── get_trending ────────────────────────────────────────────────

export async function handleGetTrending(
  sb: SupabaseClient,
  params: Record<string, unknown>,
) {
  const limit = (params.limit as number) ?? 50;

  let query = sb
    .from('news_items')
    .select('*')
    .order('score', { ascending: false })
    .limit(limit);

  if (params.source) query = query.eq('source', params.source);
  if (params.category)
    query = query.eq('source_category', params.category);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  return {
    type: 'text',
    text: (data ?? [])
      .map(
        (r: NewsItem, i: number) =>
          `${i + 1}. [${sourceName(r.source)}] ${r.title} (score: ${(r.metadata?.relevanceScore as number) ?? r.score})`,
      )
      .join('\n'),
    items: (data ?? []).map(formatItem),
    total: data?.length ?? 0,
  };
}

// ─── search ──────────────────────────────────────────────────────

export async function handleSearch(
  sb: SupabaseClient,
  params: Record<string, unknown>,
) {
  const queryStr = params.query as string;
  if (!queryStr) throw new Error('Missing required parameter: query');

  let query = sb
    .from('news_items')
    .select('*')
    .textSearch('title', queryStr, { type: 'websearch' })
    .order('score', { ascending: false })
    .limit(30);

  if (params.since)
    query = query.gt('fetched_at', params.since as string);

  const { data, error } = await query;

  // If title-only search returns few results, also search summaries
  if (!error && (data?.length ?? 0) < 5) {
    const { data: data2, error: e2 } = await sb
      .from('news_items')
      .select('*')
      .textSearch('summary', queryStr, { type: 'websearch' })
      .order('score', { ascending: false })
      .limit(20);

    if (!e2 && data2 && data2.length > 0) {
      const existingUrls = new Set((data ?? []).map((r: NewsItem) => r.url));
      for (const r of data2) {
        if (!existingUrls.has(r.url)) {
          data!.push(r);
          existingUrls.add(r.url);
        }
      }
    }
  }

  if (error) throw new Error(error.message);

  return {
    type: 'text',
    text:
      (data ?? []).length === 0
        ? `No results found for "${queryStr}".`
        : (data ?? [])
            .map(
              (r: NewsItem, i: number) =>
                `${i + 1}. [${sourceName(r.source)}] ${r.title}\n   ${r.url}`,
            )
            .join('\n'),
    items: (data ?? []).map(formatItem),
    total: data?.length ?? 0,
    query: queryStr,
  };
}

// ─── get_new_since ───────────────────────────────────────────────

export async function handleGetNewSince(
  sb: SupabaseClient,
  params: Record<string, unknown>,
) {
  const since = params.since as string;
  if (!since) throw new Error('Missing required parameter: since');

  const limit = (params.limit as number) ?? 50;

  const { data, error } = await sb
    .from('news_items')
    .select('*')
    .gt('fetched_at', since)
    .order('score', { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message);

  return {
    type: 'text',
    text:
      (data ?? []).length === 0
        ? `No new items since ${since}.`
        : `${data!.length} items since ${since}:\n` +
          data!
            .map(
              (r: NewsItem, i: number) =>
                `${i + 1}. [${sourceName(r.source)}] ${r.title} (score: ${(r.metadata?.relevanceScore as number) ?? r.score})`,
            )
            .join('\n'),
    items: (data ?? []).map(formatItem),
    total: data?.length ?? 0,
    since,
  };
}

// ─── get_source_updates ──────────────────────────────────────────

export async function handleGetSourceUpdates(
  sb: SupabaseClient,
  params: Record<string, unknown>,
) {
  const source = params.source as string;
  if (!source) throw new Error('Missing required parameter: source');

  const limit = (params.limit as number) ?? 20;

  const { data, error } = await sb
    .from('news_items')
    .select('*')
    .eq('source', source)
    .order('fetched_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message);

  return {
    type: 'text',
    text:
      (data ?? []).length === 0
        ? `No items found for source "${source}".`
        : `${data!.length} items from ${sourceName(source)}:\n` +
          data!
            .map(
              (r: NewsItem, i: number) =>
                `${i + 1}. ${r.title}\n   ${r.url}`,
            )
            .join('\n'),
    items: (data ?? []).map(formatItem),
    total: data?.length ?? 0,
    source,
  };
}

// ─── check_status ────────────────────────────────────────────────

export async function handleCheckStatus(sb: SupabaseClient) {
  // Total count
  const { count: totalItems, error: e1 } = await sb
    .from('news_items')
    .select('id', { count: 'exact', head: true });
  if (e1) throw new Error(e1.message);

  // Last updated
  const { data: latestRow, error: e2 } = await sb
    .from('news_items')
    .select('fetched_at')
    .order('fetched_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (e2) throw new Error(e2.message);

  // Per-source breakdown
  const { data: allItems, error: e3 } = await sb
    .from('news_items')
    .select('source, fetched_at');
  if (e3) throw new Error(e3.message);

  const breakdown: Record<string, { count: number; latest: string }> = {};
  for (const row of allItems ?? []) {
    const entry = breakdown[row.source] ?? { count: 0, latest: '' };
    entry.count++;
    if (row.fetched_at > entry.latest) entry.latest = row.fetched_at;
    breakdown[row.source] = entry;
  }

  const sourcesBreakdown = Object.entries(breakdown)
    .map(([source, { count, latest }]) => ({
      source,
      displayName: sourceName(source),
      count,
      latestItem: latest,
    }))
    .sort((a, b) => b.count - a.count);

  const lastUpdated = latestRow?.fetched_at ?? 'never';
  const text = [
    `Cache Status`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `Total items: ${totalItems ?? 0}`,
    `Last updated: ${lastUpdated}`,
    `Retention: 7 days`,
    ``,
    `Per-source breakdown:`,
    ...sourcesBreakdown.map(
      (s) => `  ${s.displayName} (${s.source}): ${s.count} items`,
    ),
  ].join('\n');

  return {
    type: 'text',
    text,
    lastUpdated,
    totalItems: totalItems ?? 0,
    retentionDays: 7,
    sourcesBreakdown,
  };
}
