/**
 * Regression tests for the MCP news tools: that they serve the AI editor's
 * judgments with the digest's own story code, in every tool's response shape,
 * judged and unjudged; the new filters and their validation; get_top_picks
 * matching the digest's sections; the mostly-unjudged fallback; check_status;
 * and that nothing writes. The handlers run against a fake Supabase client
 * that serves fixture rows, so no network and no credentials.
 *
 * Usage: npm run test:mcp (runs after external.test.ts)
 */

import { readFileSync } from 'node:fs';
import { parse as parseYAML } from 'yaml';
import type { SupabaseClient } from '@supabase/supabase-js';
import * as sharedNames from '../_shared/newsroom/source-names.ts';
import * as sharedSlots from '../_shared/newsroom/slots.ts';
import * as sharedStories from '../_shared/newsroom/stories.ts';
import * as sharedWhy from '../_shared/newsroom/why.ts';
import * as nodeNames from '../../../src/utils/source-names.ts';
import * as nodeSlots from '../../../src/utils/slots.ts';
import * as nodeStories from '../../../src/editor/select.ts';
import * as nodeWhy from '../../../src/digest/why.ts';
import { buildDigest } from '../../../src/digest/build.ts';
import { digestSettings } from '../../../src/digest/config.ts';
import { rowToItem } from '../_shared/newsroom/rows.ts';
import {
  handleCheckStatus, handleGetNewSince, handleGetSourceUpdates, handleGetTopPicks, handleGetTrending, handleSearch,
} from './_shared/handlers.ts';
import { parseFilters } from './_shared/present.ts';
import { TOOLS } from './_shared/tools.ts';

let passed = 0;
let failed = 0;

function check(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    passed++;
    console.log(`  ok    ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}\n          got:  ${JSON.stringify(got)}\n          want: ${JSON.stringify(want)}`);
  }
}

async function rejects(label: string, fn: () => Promise<unknown>, pattern: RegExp) {
  try {
    await fn();
    check(label, 'no error', `an error matching ${pattern}`);
  } catch (err) {
    check(label, pattern.test((err as Error).message) ? 'matching error' : (err as Error).message, 'matching error');
  }
}

function section(title: string) {
  console.log(`\n${title}`);
}

// ─── a fake Supabase client ──────────────────────────────────────

type Row = Record<string, unknown>;
const WRITES = ['insert', 'update', 'upsert', 'delete', 'rpc'];
const called = new Set<string>();

/**
 * Just enough of PostgREST: the filters, ordering and limits the handlers
 * use, over `rows`. `noEditorColumns` answers any select naming an editor
 * column with Postgres' undefined_column, as before migration 004.
 */
function fakeClient(rows: Row[], { noEditorColumns = false, onCount }: { noEditorColumns?: boolean; onCount?: () => void } = {}): SupabaseClient {
  class Query {
    private filters: ((r: Row) => boolean)[] = [];
    private orders: [string, boolean][] = [];
    private max = Infinity;
    private cols = '*';
    private single = false;
    private countOnly = false;
    constructor() {
      return new Proxy(this, {
        get(target, prop, receiver) {
          if (typeof prop === 'string') called.add(prop);
          return Reflect.get(target, prop, receiver);
        },
      });
    }
    select(cols: string, o?: { count?: string; head?: boolean }) { this.cols = cols; this.countOnly = Boolean(o?.head); return this; }
    gt(c: string, v: unknown) { this.filters.push((r) => r[c] != null && (r[c] as string) > (v as string)); return this; }
    eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
    gte(c: string, v: unknown) { this.filters.push((r) => r[c] != null && (r[c] as number) >= (v as number)); return this; }
    not(c: string, op: string, v: unknown) {
      if (op !== 'is' || v !== null) throw new Error(`fake: not(${op})`);
      this.filters.push((r) => r[c] != null);
      return this;
    }
    or(expr: string) {
      const m = expr.match(/^fetched_at\.lte\.(.+),fetched_at\.is\.null$/);
      if (!m) throw new Error(`fake: or(${expr})`);
      this.filters.push((r) => r.fetched_at == null || (r.fetched_at as string) <= m[1]);
      return this;
    }
    textSearch(c: string, q: string) {
      const words = q.toLowerCase().split(/\s+/);
      this.filters.push((r) => words.every((w) => String(r[c] ?? '').toLowerCase().includes(w)));
      return this;
    }
    order(c: string, o: { ascending: boolean }) { this.orders.push([c, o.ascending]); return this; }
    limit(n: number) { this.max = n; return this; }
    maybeSingle() { this.single = true; return this; }
    then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
      if (noEditorColumns && /editor_/.test(this.cols)) {
        return Promise.resolve({ data: null, error: { code: '42703', message: 'column news_items.editor_type does not exist' } })
          .then(resolve, reject);
      }
      // The count comes after the pages: a test can make a row "commit" in between
      if (this.countOnly) onCount?.();
      let out = rows.filter((r) => this.filters.every((f) => f(r)));
      out.sort((a, b) => {
        for (const [c, asc] of this.orders) {
          const x = a[c] as string | number;
          const y = b[c] as string | number;
          if (x === y) continue;
          return (x < y ? -1 : 1) * (asc ? 1 : -1);
        }
        return 0;
      });
      if (this.countOnly) {
        return Promise.resolve({ data: null, count: out.length, error: null }).then(resolve, reject);
      }
      out = out.slice(0, this.max);
      // Only the selected columns, as PostgREST returns them
      if (this.cols !== '*') {
        const cols = this.cols.split(',').map((c) => c.trim());
        out = out.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
      }
      return Promise.resolve({ data: this.single ? out[0] ?? null : out, error: null }).then(resolve, reject);
    }
  }
  return { from: () => new Query() } as unknown as SupabaseClient;
}

// ─── fixtures ────────────────────────────────────────────────────

const NOW = Date.now();
const ago = (hours: number) => new Date(NOW - hours * 3600_000).toISOString();
let seq = 0;

function row(source: string, judgment: Partial<{
  type: string; importance: number; audience: string; headline: string; why: string; story_key: string; followup: boolean;
}> | null, extra: Row = {}): Row {
  const id = `00000000-0000-0000-0000-${String(++seq).padStart(12, '0')}`;
  const base: Row = {
    id, title: `Title ${seq}`, url: `https://example.com/${seq}`, source, source_category: 'industry_news', score: 50,
    summary: `Summary ${seq}`, authors: null, tags: [], fetched_at: ago(3), published_at: ago(4), metadata: {},
  };
  if (judgment) {
    Object.assign(base, {
      editor_type: judgment.type ?? 'business', editor_importance: judgment.importance ?? 5,
      editor_audience: judgment.audience ?? 'general', editor_headline: judgment.headline ?? `Headline ${seq}`,
      editor_why: judgment.why ?? `Why ${seq} matters.`, editor_story_key: judgment.story_key ?? `key-${seq}`,
      editor_followup: judgment.followup ?? false, editor_model: 'claude-haiku-5-5', editor_version: '2026-10-21.5',
      editor_judged_at: ago(2),
    });
  } else {
    Object.assign(base, {
      editor_type: null, editor_importance: null, editor_audience: null, editor_headline: null, editor_why: null,
      editor_story_key: null, editor_followup: null, editor_model: null, editor_version: null, editor_judged_at: null,
    });
  }
  return { ...base, ...extra };
}

/** A morning's worth: a launch carried by three outlets, an HN wire link, builder news, a paper, and a few unrated rows. */
function fixture(): Row[] {
  seq = 0;
  return [
    row('openai_news', { story_key: 'gpt-7', importance: 9, type: 'model_release', headline: 'OpenAI launches GPT-7' },
      { url: 'https://openai.com/gpt-7', title: 'Introducing GPT-7' }),
    row('techcrunch_ai', { story_key: 'gpt-7', importance: 9, type: 'model_release', headline: 'OpenAI releases GPT-7' },
      { url: 'https://techcrunch.com/gpt-7', metadata: { coveredBy: [{ source: 'hackernews_top', url: 'https://techcrunch.com/gpt-7' }] } }),
    row('theverge_ai', { story_key: 'gpt-7', importance: 8, type: 'model_release', why: 'Same story as the existing GPT-7 entry.' }),
    row('hackernews_top', { story_key: 'china-export-curbs', importance: 7, type: 'policy_regulation', headline: 'China curbs AI exports' },
      { url: 'https://www.reuters.com/world/china-curbs', source_category: 'community' }),
    row('devto_ai', { story_key: 'agent-incidents', importance: 7, type: 'safety', headline: 'OpenAI discloses agent incidents' },
      { source_category: 'community' }),
    ...[6, 6, 6].map((importance, i) => row('techcrunch_ai', { story_key: `tc-${i}`, importance })),
    row('wired_ai', { story_key: 'ftc-probe', importance: 7, type: 'legal', headline: 'FTC opens probe of AI labs' }),
    row('vllm_releases', { story_key: 'vllm-feature', importance: 5, type: 'tool_release', audience: 'builder' }, { source_category: 'github' }),
    row('hf_daily_papers', { story_key: 'paper-x', importance: 6, type: 'research', audience: 'builder' }, { source_category: 'research' }),
    row('arxiv_cs_lg', { story_key: 'paper-low', importance: 2, type: 'research', audience: 'builder' }, { source_category: 'research' }),
    row('guardian_ai', null, { title: 'Unrated Guardian piece', score: 80 }),
    row('infoq_ai', null, { title: 'Unrated InfoQ piece', score: 40 }),
    row('anthropic_blog', { story_key: 'old-news', importance: 9 }, { fetched_at: ago(24 * 30), published_at: ago(24 * 30) }),
  ];
}

const ENTRY_KEYS = [
  'title', 'url', 'source', 'sourceId', 'category', 'score', 'summary', 'authors', 'publishedAt', 'fetchedAt',
  'headline', 'why', 'importance', 'type', 'audience', 'story_key', 'followup', 'outlets', 'published_at', 'copies',
];
const EDITOR_KEYS = ['headline', 'why', 'importance', 'type', 'audience', 'story_key', 'followup'];

// ─── one copy of the selection code ──────────────────────────────

section('one source of truth: Node and the Edge Function share the same functions');
check('stories: the digest path re-exports the shared module',
  ['groupStories', 'orderForLead', 'storyOutlets', 'isStrongCopy', 'rankStories', 'buildSections', 'topEligible', 'makeStory']
    .filter((f) => (nodeStories as Record<string, unknown>)[f] !== (sharedStories as Record<string, unknown>)[f]), []);
check('names, publishers and source classes', [nodeNames.itemOutlet === sharedNames.itemOutlet,
  nodeNames.SOURCE_DISPLAY_NAMES === sharedNames.SOURCE_DISPLAY_NAMES, nodeNames.OFFICIAL_LAB_SOURCES === sharedNames.OFFICIAL_LAB_SOURCES],
  [true, true, true]);
check('why-line guard and the old ranking', [nodeWhy.chooseWhy === sharedWhy.chooseWhy, nodeSlots.buildSlottedDisplay === sharedSlots.buildSlottedDisplay],
  [true, true]);
{
  const sources = (parseYAML(readFileSync('config/sources.yaml', 'utf8')) as { sources: { id: string; category: string; sourceTier?: number }[] }).sources;
  const press = sources.filter((s) => s.category === 'industry_news' && (s.sourceTier ?? 3) <= 2).map((s) => s.id).sort();
  check('PRESS_SOURCES matches sources.yaml (industry_news, tier 1–2)', [...sharedNames.PRESS_SOURCES].sort(), press);
}

// ─── tools/list ──────────────────────────────────────────────────

section('tools/list — every name and parameter still there');
{
  const names = TOOLS.map((t) => t.name);
  check('8 tools, the same names', names, ['get_top_picks', 'get_trending', 'search', 'get_new_since', 'get_source_updates',
    'get_repo_quickstart', 'get_paper_brief', 'check_status']);
  const props = (n: string) => Object.keys((TOOLS.find((t) => t.name === n)!.inputSchema.properties ?? {}) as object);
  const legacy: Record<string, string[]> = {
    get_top_picks: ['officialLimit', 'communityLimit', 'researchLimit', 'industryLimit', 'showAll'],
    get_trending: ['source', 'category', 'limit'],
    search: ['query', 'since'],
    get_new_since: ['since', 'limit'],
    get_source_updates: ['source', 'limit'],
    get_repo_quickstart: ['repo'],
    get_paper_brief: ['arxiv_id'],
    check_status: [],
  };
  check('no parameter removed or renamed', Object.entries(legacy).flatMap(([n, ps]) => ps.filter((p) => !props(n).includes(p)).map((p) => `${n}.${p}`)), []);
  check('the editor filters on the list tools', ['get_trending', 'search', 'get_new_since', 'get_source_updates']
    .map((n) => ['min_importance', 'type', 'audience'].every((p) => props(n).includes(p))), [true, true, true, true]);
  check('get_top_picks takes a window', ['hours', 'since'].every((p) => props('get_top_picks').includes(p)), true);
  check('required parameters unchanged', TOOLS.map((t) => (t.inputSchema.required as string[] | undefined) ?? []),
    [[], [], ['query'], ['since'], ['source'], ['repo'], ['arxiv_id'], []]);
}

// ─── get_top_picks ───────────────────────────────────────────────

section('get_top_picks — the digest\'s sections for the same window');
{
  const rows = fixture();
  const sb = fakeClient(rows);
  const res = await handleGetTopPicks(sb, {});
  const mcp = Object.fromEntries(res.sections.map((s) => [s.id, s.items.map((e) => e.story_key)]));
  const window = rows.filter((r) => (r.fetched_at as string) > ago(24)).map(rowToItem);
  const digest = await buildDigest({
    items: window, editorColumns: true, now: new Date(NOW), sources: [], dir: sharedStories.sourceDirectory(),
    settings: digestSettings({}), history: [],
  });
  check('same stories in the same sections, in the same order, as the digest builds', mcp, digest.shown);
  check('the sections, titled as in the digest', res.sections.map((s) => `${s.emoji} ${s.label}`),
    ['📰 Top stories', '📌 Also notable', '🛠️ For builders', '📄 Paper of note']);
  check('mode and counts', [res.mode, res.itemsInWindow, res.judgedInWindow], ['editor', 14, 12]);
  check('the last 24 hours by default: a month-old story is not there', JSON.stringify(res).includes('old-news'), false);
  const gpt7 = res.sections[0].items[0];
  check('a story: lab post represents it, outlets list every copy, the guard drops a coverage why-line',
    [gpt7.story_key, gpt7.url, gpt7.outlets, gpt7.copies, gpt7.why], ['gpt-7', 'https://openai.com/gpt-7', ['OpenAI', 'TechCrunch', 'The Verge'], 3, 'Why 1 matters.']);
  check('a weak source (Dev.to only, rated 7) is not a top story', res.sections[0].items.some((e) => e.story_key === 'agent-incidents'), false);
  check('at most 2 stories per outlet in a section', res.sections[0].items.filter((e) => e.sourceId === 'techcrunch_ai').length <= 2, true);
  check('an HN wire link names its publisher', res.sections[0].items.find((e) => e.story_key === 'china-export-curbs')?.outlets, ['Reuters (via HN)']);
  check('unrated items are counted, not shown', [res.note, JSON.stringify(res.sections).includes('Unrated')], ['2 items in this window not yet rated, so not shown.', false]);
  const showAll = await handleGetTopPicks(sb, { showAll: true });
  // GPT-7 is led by OpenAI's own post, so three top stories are TechCrunch's
  check('showAll lifts the section and outlet limits', showAll.sections[0].items.filter((e) => e.sourceId === 'techcrunch_ai').length, 3);
  const week = await handleGetTopPicks(sb, { hours: 24 * 40 });
  check('a longer window reaches older stories', JSON.stringify(week).includes('old-news'), true);
  await rejects('a bad window is a caller error', () => handleGetTopPicks(sb, { hours: -1 }), /^Invalid parameter: hours/);
  await rejects('a bad since too', () => handleGetTopPicks(sb, { since: 'yesterday-ish' }), /^Invalid parameter: since/);
  check('the text names sections and stories', [/📰 Top stories/.test(res.text), /\[9\] OpenAI launches GPT-7 — OpenAI, TechCrunch, The Verge/.test(res.text)], [true, true]);
}

section('get_top_picks — mostly unjudged: the old score order, with a note');
{
  seq = 0;
  const rows = [row('guardian_ai', null, { score: 90 }), row('techcrunch_ai', null, { score: 70 }), row('openai_news', null, { score: 95, source_category: 'company_blog' }),
    row('wired_ai', { importance: 9 })];
  const res = await handleGetTopPicks(fakeClient(rows), {});
  check('fallback mode, note says why', [res.mode, res.note], ['fallback',
    'The AI editor has rated only 1 of 4 items in this window (25%), so this uses the older score-based ranking.']);
  check('items in the same shape, editor fields null on unrated ones',
    res.sections.flatMap((s) => s.items).filter((e) => e.importance === null).length >= 3, true);
  const noColumns = await handleGetTopPicks(fakeClient(fixture(), { noEditorColumns: true }), {});
  check('without the editor columns: fallback too, nothing fails', noColumns.mode, 'fallback');
  const rated = res.sections.flatMap((s) => s.items).find((e) => e.sourceId === 'wired_ai');
  check('a rated item in the fallback keeps its judgment', [rated?.importance, rated?.headline], [9, 'Headline 4']);

  seq = 0;
  const twenty = Array.from({ length: 20 }, (_, i) => row('techcrunch_ai', null, { score: 60 + i, published_at: ago(2) }));
  const all = await handleGetTopPicks(fakeClient(twenty), { showAll: true });
  check('showAll in the fallback: every item, no section or per-source caps', all.sections.flatMap((s) => s.items).length, 20);
  check('without showAll the old caps still apply', (await handleGetTopPicks(fakeClient(twenty), {})).sections.flatMap((s) => s.items).length < 20, true);
}

section('fallback — officialLimit holds for release entries too');
{
  seq = 0;
  const rows = [row('wired_ai', null, { score: 99, published_at: ago(2) }),
    row('claude_code_releases', null, { score: 70, source_category: 'github', published_at: ago(2), metadata: { tagName: 'v2.1.310' } })];
  const official = (r: Awaited<ReturnType<typeof handleGetTopPicks>>) => r.sections.find((s) => s.label === 'Official Announcements')?.items.length ?? 0;
  check('officialLimit 0 leaves no official entries, releases included', official(await handleGetTopPicks(fakeClient(rows), { officialLimit: 0 })), 0);
  check('without a limit the release is shown', official(await handleGetTopPicks(fakeClient(rows), {})), 1);
}

section('paged reads — rows committed mid-scan are reported, not silently missed');
{
  seq = 0;
  const rows = Array.from({ length: 1001 }, () => row('techcrunch_ai', { importance: 5 }, { fetched_at: ago(2) }));
  // A collector batch that began before the cutoff commits between pages:
  // its row's id sorts below the cursor, and its fetched_at is in the window
  const late = row('wired_ai', { importance: 5 }, { id: '00000000-0000-0000-0000-000000000000', fetched_at: ago(2) });
  let inserted = false;
  const store = [...rows];
  const sb = fakeClient(store, { onCount: () => { if (!inserted) { store.push(late); inserted = true; } } });
  const res = await handleGetNewSince(sb, { since: ago(24) });
  check('a complete scan is not marked truncated when nothing moved', (await handleGetNewSince(fakeClient(rows), { since: ago(24) })).truncated, undefined);
  check('a row that appeared mid-scan marks the answer truncated', [res.truncated, /oldest are not included/.test(res.text)], [true, true]);
}

section('get_source_updates — filters before the newest-N cap');
{
  seq = 0;
  // 61 recent items; only the oldest is rated 9
  const rows = [
    row('techcrunch_ai', { importance: 9, story_key: 'the-big-one' }, { fetched_at: ago(0.9) }),
    ...Array.from({ length: 60 }, (_, i) => row('techcrunch_ai', { importance: 4 }, { fetched_at: ago(0.5 - i / 1000) })),
  ];
  check('a match past the cap is found', (await handleGetSourceUpdates(fakeClient(rows), { source: 'techcrunch_ai', min_importance: 9 })).items.map((e) => e.story_key), ['the-big-one']);
  check('no editor columns: an editor filter matches nothing, without an error',
    (await handleGetSourceUpdates(fakeClient(rows, { noEditorColumns: true }), { source: 'techcrunch_ai', min_importance: 9 })).items.length, 0);
}

section('search — every match ranked and filtered, not the top 100 by score first');
{
  seq = 0;
  const rows = [
    ...Array.from({ length: 150 }, () => row('devto_ai', { importance: 3 }, { title: 'Claude tips and tricks', score: 90 })),
    row('anthropic_blog', { importance: 10, headline: 'Anthropic launches Claude 6', story_key: 'claude-6' }, { title: 'Introducing Claude 6', score: 10 }),
  ];
  const sb = fakeClient(rows);
  check('a low-score, high-importance match survives a filter', (await handleSearch(sb, { query: 'claude', min_importance: 9 })).items.map((e) => e.story_key), ['claude-6']);
  check('and leads without one', (await handleSearch(sb, { query: 'claude' })).items[0].story_key, 'claude-6');
}

// ─── list tools ──────────────────────────────────────────────────

section('list tools — judged stories by importance, unjudged after by score');
{
  const sb = fakeClient(fixture());
  const trending = await handleGetTrending(sb, {});
  const imps = trending.items.map((e) => e.importance);
  check('stories ranked by importance, unjudged last', imps, [9, 7, 7, 7, 6, 6, 6, 6, 5, 2, null, null]);
  check('unjudged ordered by the old score', trending.items.filter((e) => e.importance === null).map((e) => e.title), ['Unrated Guardian piece', 'Unrated InfoQ piece']);
  check('copies grouped into one story', trending.items.filter((e) => e.story_key === 'gpt-7').length, 1);
  check('the last 7 days by default', trending.items.some((e) => e.story_key === 'old-news'), false);
  check('judged entry shape', Object.keys(trending.items[0]), ENTRY_KEYS);
  const unrated = trending.items.at(-1)!;
  check('unjudged entry: same shape, editor fields null', [Object.keys(unrated), EDITOR_KEYS.map((k) => (unrated as Record<string, unknown>)[k])],
    [ENTRY_KEYS, [null, null, null, null, null, null, null]]);
  check('unjudged entry still lists its outlet', unrated.outlets, ['InfoQ']);

  check('min_importance', (await handleGetTrending(sb, { min_importance: 7 })).items.map((e) => e.importance), [9, 7, 7, 7]);
  check('type', (await handleGetTrending(sb, { type: 'research' })).items.map((e) => e.story_key), ['paper-x', 'paper-low']);
  check('audience', (await handleGetTrending(sb, { audience: 'builder' })).items.map((e) => e.story_key), ['paper-x', 'vllm-feature', 'paper-low']);
  check('source and category still filter', [(await handleGetTrending(sb, { source: 'wired_ai' })).items.map((e) => e.story_key),
    (await handleGetTrending(sb, { category: 'github' })).items.map((e) => e.story_key)], [['ftc-probe'], ['vllm-feature']]);
  check('limit', (await handleGetTrending(sb, { limit: 2 })).items.length, 2);
  await rejects('min_importance out of range', () => handleGetTrending(sb, { min_importance: 11 }), /^Invalid parameter: min_importance/);
  await rejects('an unknown type', () => handleGetTrending(sb, { type: 'gossip' }), /^Invalid parameter: type must be one of model_release/);
  await rejects('an unknown audience', () => handleGetTrending(sb, { audience: 'everyone' }), /^Invalid parameter: audience/);
  check('filters parse as documented', parseFilters({ min_importance: '8', type: 'safety', audience: 'general' }),
    { minImportance: 8, type: 'safety', audience: 'general' });

  const search = await handleSearch(sb, { query: 'GPT-7' });
  check('search: titles and editor headlines, grouped', [search.items.map((e) => e.story_key), search.query], [['gpt-7'], 'GPT-7']);
  check('search: no results', (await handleSearch(sb, { query: 'nothing matches this' })).text, 'No results found for "nothing matches this".');
  await rejects('search: query still required', () => handleSearch(sb, {}), /^Missing required parameter: query/);

  const since = await handleGetNewSince(sb, { since: ago(24 * 2), min_importance: 9 });
  check('get_new_since with a filter; since echoed as ISO 8601', [since.items.map((e) => e.story_key), !Number.isNaN(Date.parse(since.since))], [['gpt-7'], true]);
  await rejects('get_new_since: since still required', () => handleGetNewSince(sb, {}), /^Missing required parameter: since/);

  const tc = await handleGetSourceUpdates(sb, { source: 'techcrunch_ai' });
  check('get_source_updates: that source, most important first', tc.items.map((e) => e.importance), [9, 6, 6, 6]);
  check('get_source_updates: empty', (await handleGetSourceUpdates(sb, { source: 'nope' })).text, 'No items found for source "nope".');
}

// ─── check_status ────────────────────────────────────────────────

section('check_status — the editor\'s coverage and the deployed commit');
{
  const res = await handleCheckStatus(fakeClient(fixture()));
  check('the existing fields', ['lastUpdated', 'totalItems', 'retentionDays', 'sourcesBreakdown'].every((k) => k in res), true);
  check('share judged in the last 24 hours, rubric versions, models', [res.editor.last24h.items, res.editor.last24h.judged,
    res.editor.last24h.judgedShare, res.editor.last24h.rubricVersions, res.editor.last24h.models],
    [14, 12, 0.857, ['2026-10-21.5'], ['claude-haiku-5-5']]);
  check('the newest judgment', res.editor.newestJudgedAt, ago(2));
  check('the deployed commit: "dev" until the deploy workflow stamps it', res.deployment, { commit: 'dev', builtAt: null });
  check('all in the text too', [/AI editor, last 24 hours: 86% \(12 of 14\) judged/.test(res.text), /Deployed commit: dev/.test(res.text)], [true, true]);
  const old = await handleCheckStatus(fakeClient(fixture(), { noEditorColumns: true }));
  check('without the editor columns: reported, not an error', [old.editor.columnsPresent, old.editor.last24h.judged], [false, 0]);
}

// ─── reads only ──────────────────────────────────────────────────

section('reads only');
check('no tool called insert, update, upsert, delete or rpc', WRITES.filter((w) => called.has(w)), []);

// ─── summary ─────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(52)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(52)}\n`);

if (failed > 0) process.exit(1);
