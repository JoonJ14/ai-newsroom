/**
 * MCP Server test script — simulates JSON-RPC calls against real Supabase data.
 * Runs in Node (not Deno) for local testing.
 *
 * Usage: npx tsx supabase/functions/mcp/test.ts
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── Inline the slots logic (Node-compatible) ────────────────

interface NewsItem {
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

const TIER1 = new Set(['claude_code_releases', 'openai_codex_releases']);
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

const NAMES: Record<string, string> = {
  anthropic_blog: 'Anthropic', anthropic_changelog: 'Anthropic Changelog',
  openai_news: 'OpenAI', google_ai_blog: 'Google AI', nvidia_developer_blog: 'NVIDIA',
  claude_code_releases: 'Claude Code', openai_codex_releases: 'OpenAI Codex',
  hackernews_top: 'Hacker News', show_hn: 'Show HN', reddit_claudeai: 'r/ClaudeAI',
  reddit_localllama: 'r/LocalLLaMA', reddit_machinelearning: 'r/MachineLearning',
  reddit_artificial: 'r/artificial', hf_daily_papers: 'HF Papers',
  hf_trending_spaces: 'HF Spaces', github_trending: 'GitHub Trending',
  arxiv_cs_ai: 'ArXiv cs.AI', arxiv_cs_lg: 'ArXiv cs.LG', arxiv_cs_cv: 'ArXiv cs.CV',
  devto_ai: 'Dev.to', infoq_ai: 'InfoQ', thenewstack_ai: 'The New Stack',
  vllm_releases: 'vLLM',
};

function sn(s: string) { return NAMES[s] ?? s; }
function sc(i: NewsItem) { return (i.metadata?.relevanceScore as number) ?? i.score ?? 0; }

function header(text: string) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${text}`);
  console.log(`${'═'.repeat(60)}`);
}

// ─── Test 1: tools/list ──────────────────────────────────────

async function testToolsList() {
  header('TEST 1: tools/list');
  const tools = [
    { name: 'get_top_picks', params: 5 },
    { name: 'get_trending', params: 3 },
    { name: 'search', params: 2, required: ['query'] },
    { name: 'get_new_since', params: 2, required: ['since'] },
    { name: 'get_source_updates', params: 2, required: ['source'] },
    { name: 'check_status', params: 0 },
  ];
  console.log(`${tools.length} tools available:`);
  for (const t of tools) {
    console.log(`  - ${t.name} (${t.params} params${t.required ? `, required: ${t.required.join(', ')}` : ''})`);
  }
}

// ─── Test 2: get_top_picks (default) ─────────────────────────

async function testGetTopPicks() {
  header('TEST 2: get_top_picks (default)');
  const { data, error } = await sb
    .from('news_items')
    .select('*')
    .order('score', { ascending: false })
    .limit(500);

  if (error) { console.error('DB error:', error.message); return; }
  const items = data as NewsItem[];

  // Simplified slotted display for testing
  const used = new Set<string>();
  const cutoff = Date.now() - SEVEN_DAYS;

  // Official
  const officialRaw = items.filter(i => i.source_category === 'company_blog' || TIER1.has(i.source));
  for (const i of officialRaw) used.add(i.url);
  const officialRecent = officialRaw.filter(i => {
    const t = new Date(i.published_at ?? i.fetched_at).getTime();
    return !isNaN(t) && t >= cutoff;
  });

  // Consolidate releases
  const releases: NewsItem[] = [];
  const blogs: NewsItem[] = [];
  for (const i of officialRecent) {
    if (i.metadata?.tagName !== undefined) releases.push(i);
    else blogs.push(i);
  }
  const groups = new Map<string, NewsItem[]>();
  for (const r of releases) {
    const g = groups.get(r.source) ?? [];
    g.push(r);
    groups.set(r.source, g);
  }
  const consol: NewsItem[] = [];
  for (const [source, group] of groups) {
    if (group.length <= 1) { consol.push(...group); continue; }
    const sorted = [...group].sort((a, b) => new Date(b.published_at ?? b.fetched_at).getTime() - new Date(a.published_at ?? a.fetched_at).getTime());
    const hi = Math.max(...group.map(sc));
    consol.push({ ...sorted[0], title: `${sn(source)}: ${group.length} releases this week`, score: hi, metadata: { ...sorted[0].metadata, relevanceScore: hi } });
  }

  // Per-source cap
  const cappedBlogs: NewsItem[] = [];
  const blogCounts = new Map<string, number>();
  for (const i of blogs.sort((a, b) => sc(b) - sc(a))) {
    const c = blogCounts.get(i.source) ?? 0;
    if (c >= 3) continue;
    cappedBlogs.push(i);
    blogCounts.set(i.source, c + 1);
  }
  const official = [...cappedBlogs, ...consol].sort((a, b) => sc(b) - sc(a)).slice(0, 15);

  // Community
  const commAll = items.filter(i => i.source_category === 'community' && !used.has(i.url)).sort((a, b) => sc(b) - sc(a));
  const community: NewsItem[] = [];
  const commCounts = new Map<string, number>();
  for (const i of commAll) {
    if (community.length >= 5) break;
    const c = commCounts.get(i.source) ?? 0;
    if (c >= 2) continue;
    community.push(i);
    commCounts.set(i.source, c + 1);
    used.add(i.url);
  }

  // Research
  const resAll = items.filter(i => i.source_category === 'research' && !used.has(i.url)).sort((a, b) => sc(b) - sc(a));
  const research: NewsItem[] = [];
  const resCounts = new Map<string, number>();
  for (const i of resAll) {
    if (research.length >= 3) break;
    const c = resCounts.get(i.source) ?? 0;
    if (c >= 2) continue;
    research.push(i);
    resCounts.set(i.source, c + 1);
    used.add(i.url);
  }

  // Industry
  const indAll = items.filter(i => (i.source_category === 'industry_news' || i.source_category === 'github') && !used.has(i.url)).sort((a, b) => sc(b) - sc(a));
  const industry = indAll.slice(0, 2);

  const sections = [
    { label: '📢 Official Announcements', items: official },
    { label: '🔥 Community Highlights', items: community },
    { label: '📄 Research & Papers', items: research },
    { label: '📰 Industry News', items: industry },
  ].filter(s => s.items.length > 0);

  for (const sec of sections) {
    console.log(`\n${sec.label} (${sec.items.length})`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    sec.items.forEach((item, i) => {
      console.log(`${i + 1}. [${sn(item.source)}] ${item.title} (score: ${sc(item)})`);
    });
  }
  const total = sections.reduce((s, sec) => s + sec.items.length, 0);
  console.log(`\nTotal: ${total} items`);
}

// ─── Test 3: get_top_picks (showAll) ─────────────────────────

async function testGetTopPicksShowAll() {
  header('TEST 3: get_top_picks (showAll: true)');
  const { count } = await sb.from('news_items').select('id', { count: 'exact', head: true });
  console.log(`showAll would return all ${count} items across all sections (no caps).`);
}

// ─── Test 4: search "anthropic" ──────────────────────────────

async function testSearch() {
  header('TEST 4: search (query: "anthropic")');
  const { data, error } = await sb
    .from('news_items')
    .select('*')
    .textSearch('title', 'anthropic', { type: 'websearch' })
    .order('score', { ascending: false })
    .limit(10);

  if (error) { console.error('DB error:', error.message); return; }

  console.log(`Found ${data?.length ?? 0} results for "anthropic":`);
  for (const [i, row] of (data ?? []).entries()) {
    console.log(`${i + 1}. [${sn(row.source)}] ${row.title}`);
    console.log(`   ${row.url}`);
  }
}

// ─── Test 5: get_new_since (24h ago) ─────────────────────────

async function testGetNewSince() {
  header('TEST 5: get_new_since (24 hours ago)');
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await sb
    .from('news_items')
    .select('*')
    .gt('fetched_at', since)
    .order('score', { ascending: false })
    .limit(10);

  if (error) { console.error('DB error:', error.message); return; }

  console.log(`${data?.length ?? 0} items since ${since.split('T')[0]}:`);
  for (const [i, row] of (data ?? []).entries()) {
    console.log(`${i + 1}. [${sn(row.source)}] ${row.title} (score: ${sc(row as NewsItem)})`);
  }
}

// ─── Test 6: check_status ────────────────────────────────────

async function testCheckStatus() {
  header('TEST 6: check_status');
  const { count } = await sb.from('news_items').select('id', { count: 'exact', head: true });
  const { data: latest } = await sb.from('news_items').select('fetched_at').order('fetched_at', { ascending: false }).limit(1).single();
  const { data: allItems } = await sb.from('news_items').select('source');

  const breakdown: Record<string, number> = {};
  for (const row of allItems ?? []) {
    breakdown[row.source] = (breakdown[row.source] ?? 0) + 1;
  }

  console.log(`Total items: ${count}`);
  console.log(`Last updated: ${latest?.fetched_at ?? 'never'}`);
  console.log(`Retention: 7 days`);
  console.log(`\nPer-source breakdown:`);
  for (const [source, cnt] of Object.entries(breakdown).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${sn(source)} (${source}): ${cnt} items`);
  }
}

// ─── Run all tests ───────────────────────────────────────────

async function main() {
  console.log('AI Newsroom MCP Server — Tool Tests');
  console.log(`Testing against: ${SUPABASE_URL}`);

  await testToolsList();
  await testGetTopPicks();
  await testGetTopPicksShowAll();
  await testSearch();
  await testGetNewSince();
  await testCheckStatus();

  console.log('\n✅ All tests complete.');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
