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

/** PostgREST's db-max-rows for this project: responses are capped here. */
const SERVER_MAX_ROWS = 1000;

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

/**
 * Page through every cached row, seeking on the primary key.
 *
 * Pages with `.range()` ordered by the immutable primary key.
 *
 * A single query is NOT sufficient: PostgREST enforces its own `db-max-rows`
 * (1000 on this project) regardless of the requested `.limit()`, so one
 * statement returns 1000 of ~7100 rows. Paging is the only way `showAll` sees
 * the whole cache.
 *
 * Ordering on `id` rather than `score` or `fetched_at`, both of which were
 * tried and are wrong here: `score` is mutable and nullable, so a row crossing
 * the cursor is skipped permanently; `fetched_at` is nullable and only appears
 * monotonic, since `NOW()` is transaction *start* time and a transaction that
 * began earlier can commit later. `id` is a UUID primary key — unique,
 * non-null, and never updated — so the sort order itself cannot shift.
 *
 * The working set is FROZEN before paging by filtering on a timestamp captured
 * up front. Without that, offset paging loses rows in bulk rather than
 * occasionally: the collector inserts up to 500 rows per transaction, so a
 * batch landing mid-read shifts later pages and drops however many of the new
 * UUIDs sorted before the current offset — measured at 200 rows lost from a
 * 3,200-row table, reported as complete. Excluding anything fetched after the
 * cutoff makes inserts invisible to the scan instead.
 *
 * Paging then seeks on `id` rather than using OFFSET, so a concurrent delete
 * cannot shift later pages either. Within the frozen window `id` is a stable,
 * unique, non-null key.
 *
 * Completeness is finally checked against a count taken over the same window,
 * so any shortfall is reported rather than silently returned as whole.
 *
 * Ordering is irrelevant to the caller because `buildSlottedDisplay` re-sorts
 * by score.
 */
async function fetchAllRows(
  sb: SupabaseClient,
  pageSize = 1000,
  maxRows = 50_000,
): Promise<{ rows: NewsItem[]; truncated: boolean }> {
  const rows: NewsItem[] = [];
  // Dedup by id, not url: the unique index is (url, source), so two sources
  // carrying the same link are distinct rows and must both survive.
  const seen = new Set<string>();

  // `fetched_at` is nullable, so rows without one are kept in the window too —
  // a bare .lte() would silently exclude them.
  const cutoff = new Date().toISOString();
  const inWindow = `fetched_at.lte.${cutoff},fetched_at.is.null`;

  // PostgREST caps every response at db-max-rows (1000 here) whatever we ask
  // for, so requesting more would make the first capped page look like a
  // terminal short page and end the scan early.
  const perPage = Math.min(pageSize, SERVER_MAX_ROWS);

  let cursor: string | null = null;

  while (rows.length < maxRows) {
    let query = sb
      .from('news_items')
      .select('*')
      .or(inWindow)
      .order('id', { ascending: true })
      // Never request more than remains in the budget, so the bound holds for
      // any pageSize/maxRows pair rather than only ones that divide evenly.
      .limit(Math.min(perPage, maxRows - rows.length));

    if (cursor !== null) query = query.gt('id', cursor);

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;

    for (const row of data as (NewsItem & { id: string })[]) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }

    cursor = (data[data.length - 1] as { id: string }).id;

    // A page shorter than requested means the window is exhausted. This is only
    // sound because the request length is never above the server's own cap.
    if (data.length < Math.min(perPage, maxRows - rows.length + data.length)) break;
  }

  // Counted AFTER the scan, over the same window. A transaction already in
  // flight when the cutoff was captured can commit mid-scan and land inside the
  // window, and rows of it sorting below the cursor are then missed. Counting
  // first hid that — the stale count matched what had been read, so the answer
  // came back marked complete. Counting last makes the shortfall visible, which
  // is the property that matters: partial results are reported, never silent.
  const { count, error: countError } = await sb
    .from('news_items')
    .select('id', { count: 'exact', head: true })
    .or(inWindow);
  if (countError) throw new Error(countError.message);

  return { rows, truncated: (count ?? rows.length) > rows.length };
}

// ─── get_top_picks ───────────────────────────────────────────────

export async function handleGetTopPicks(
  sb: SupabaseClient,
  params: Record<string, unknown>,
) {
  const showAll = params.showAll === true;
  // Infinity rather than a large sentinel: 9999 is still a cap, and with enough
  // cached rows it silently trims the very thing showAll promises to show.
  const opts: SlotOptions = showAll
    ? {
        officialLimit: Infinity,
        communityLimit: Infinity,
        researchLimit: Infinity,
        industryLimit: Infinity,
        officialMaxPerSource: Infinity,
        communityMaxPerSource: Infinity,
        researchMaxPerSource: Infinity,
        industryMaxPerSource: Infinity,
        // Infinite limits alone are not "everything": official items are also
        // filtered to the last 7 days and multiple releases are collapsed into
        // a single row, both independent of any limit.
        unfiltered: true,
      }
    : {
        officialLimit: params.officialLimit as number | undefined,
        communityLimit: params.communityLimit as number | undefined,
        researchLimit: params.researchLimit as number | undefined,
        industryLimit: params.industryLimit as number | undefined,
      };

  // showAll removes the per-section caps, so the row budget has to lift too —
  // otherwise "show everything, no limits" still silently drops anything past
  // the cut-off before slotting ever sees it. Any single .limit() is just a
  // higher cut-off, so showAll pages through the table instead.
  let data: NewsItem[];
  let truncated = false;
  if (showAll) {
    const paged = await fetchAllRows(sb);
    data = paged.rows;
    truncated = paged.truncated;
  } else {
    const res = await sb
      .from('news_items')
      .select('*')
      .order('score', { ascending: false })
      .order('id', { ascending: true })
      .limit(500);
    if (res.error) throw new Error(res.error.message);
    data = (res.data ?? []) as NewsItem[];
  }

  const display = buildSlottedDisplay(data, opts);
  // Deliberately does not claim the omitted rows are "older": they are selected
  // by fetch order, which has no fixed relationship to score or publish date.
  const notice = truncated
    ? '\n\n(Note: the cache is larger than this tool loads at once, so some items are not shown.)'
    : '';
  const text = formatSlottedText(display) + notice;

  return {
    type: 'text',
    text,
    sections: display.sections.map((sec) => ({
      label: sec.label,
      emoji: sec.emoji,
      items: sec.items.map(formatItem),
    })),
    totalItems: display.totalItems,
    truncated,
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

  // If title-only search returns few results, also search summaries.
  // This fallback must carry the same `since` bound as the primary query —
  // without it, "search X since Friday" quietly returns older items whenever
  // the title search happens to match fewer than five rows.
  if (!error && (data?.length ?? 0) < 5) {
    let fallback = sb
      .from('news_items')
      .select('*')
      .textSearch('summary', queryStr, { type: 'websearch' })
      .order('score', { ascending: false })
      .limit(20);

    if (params.since) {
      fallback = fallback.gt('fetched_at', params.since as string);
    }

    const { data: data2, error: e2 } = await fallback;

    // Surface a fallback failure instead of returning title-only hits as though
    // the search were complete.
    if (e2) throw new Error(e2.message);

    if (data2 && data2.length > 0) {
      // Keyed by (url, source) — the actual identity constraint. Keying on url
      // alone let a title hit from one source suppress a summary hit carrying
      // the same link from a different source.
      const identity = (r: NewsItem) => `${r.url}\u0000${r.source}`;
      const existing = new Set((data ?? []).map(identity));
      for (const r of data2) {
        if (!existing.has(identity(r))) {
          data!.push(r);
          existing.add(identity(r));
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

  // Per-source breakdown. Paged for the same reason as fetchAllRows: an
  // uncapped select silently returns only the server's db-max-rows (1000 here),
  // so the per-source counts summed to at most 1000 against a 7,000-row cache
  // while the total above reported the true figure — two numbers in the same
  // response that disagreed.
  const allItems: { source: string; fetched_at: string }[] = [];
  {
    const pageSize = 1000;
    let cursor: string | null = null;

    for (let guard = 0; guard < 1000; guard++) {
      let q = sb
        .from('news_items')
        .select('id, source, fetched_at')
        .order('id', { ascending: true })
        .limit(pageSize);
      if (cursor !== null) q = q.gt('id', cursor);

      const { data: page, error: e3 } = await q;
      if (e3) throw new Error(e3.message);
      if (!page || page.length === 0) break;

      allItems.push(...(page as typeof allItems));
      cursor = (page[page.length - 1] as { id: string }).id;
      if (page.length < pageSize) break;
    }
  }

  // Derived from the same scan rather than a separate exact count: the two were
  // taken at different moments, so a concurrent insert made the response state a
  // total that disagreed with its own breakdown.
  const totalItems = allItems.length;

  const breakdown: Record<string, { count: number; latest: string }> = {};
  for (const row of allItems) {
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
    `Retention: 90 days`,
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
    retentionDays: 90,
    sourcesBreakdown,
  };
}
