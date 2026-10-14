/**
 * Regression tests for collection: item clean-up, dedup coverage, and the
 * Anthropic parsers. Each case is a defect found in the ranking audit (Oct
 * 2026). Pure functions and inline HTML only, so no network or credentials.
 *
 * Usage: npm run test:collect
 */

import { cleanText, decodeEntities, htmlToText, normalizeItem, stripTrackingParams } from '../utils/normalize.js';
import { deduplicateItems, urlKey } from '../utils/dedup.js';
import { mergeStoredMetadata } from '../utils/supabase.js';
import { withHitsPerPage } from './hackernews.js';
import { parseDayDate, scrapeAnthropicChangelog, scrapeAnthropicListing } from './scraper.js';
import type { NewsItem, SourceConfig } from './types.js';

let passed = 0;
let failed = 0;

function check(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    passed++;
    console.log(`  ok    ${label}`);
  } else {
    failed++;
    console.log(
      `  FAIL  ${label}\n          got:  ${JSON.stringify(got)}\n          want: ${JSON.stringify(want)}`,
    );
  }
}

function section(title: string) {
  console.log(`\n${title}`);
}

function item(source: string, url: string, title: string, score: number, metadata?: Record<string, unknown>): NewsItem {
  return {
    title, url, source, score, metadata,
    sourceCategory: 'industry_news', tags: [], fetchedAt: '2026-10-14T00:00:00.000Z',
  };
}

const SOURCE = { id: 'anthropic_blog', name: 'Anthropic', type: 'html_scrape', url: '', category: 'company_blog', enabled: true, tags: [] } as SourceConfig;

// ─── normalize ───────────────────────────────────────────────────

section('decodeEntities / cleanText — titles as feeds send them');
check('Verge numeric entities', decodeEntities('Anthropic&#8217;s &#8216;model&#8217;'), 'Anthropic’s ‘model’');
check('hex and named entities', decodeEntities('It&#x27;s &amp; &quot;x&quot; &hellip;'), 'It\'s & "x" …');
check('unknown named entity left alone', decodeEntities('R&D &bogus; AT&T'), 'R&D &bogus; AT&T');
check('decodes once, not twice', decodeEntities('&amp;#8217;'), '&#8217;');
check('newlines collapsed (Dev.to title)', cleanText('Gemini 4 Argon\r\n\r\nhttps://blog.google/x'), 'Gemini 4 Argon https://blog.google/x');
check('HN story_text to plain text', htmlToText('<p>It&#x27;s here</p><p>see <a href="https://x.dev">x.dev</a></p>'), "It's here see x.dev");

section('stripTrackingParams — utm_* removed before the URL becomes identity');
check('InfoQ feed URL',
  stripTrackingParams('https://www.infoq.com/news/2026/10/a/?utm_campaign=infoq_content&utm_source=infoq&utm_medium=feed&utm_term=AI'),
  'https://www.infoq.com/news/2026/10/a/');
check('other parameters kept',
  stripTrackingParams('https://apnews.com/article/x?taid=6ac8&utm_campaign=TrueAnthem&utm_medium=AP'),
  'https://apnews.com/article/x?taid=6ac8');
check('URL without utm_ is not re-serialized', stripTrackingParams('https://Example.com'), 'https://Example.com');
check('HN item URL untouched', stripTrackingParams('https://news.ycombinator.com/item?id=1'), 'https://news.ycombinator.com/item?id=1');

section('normalizeItem');
{
  const n = normalizeItem({ ...item('theverge_ai', ' https://x.com/a?utm_source=rss ', 'A\nB &#8217;', 1), summary: '  \n ' });
  check('title cleaned', n.title, 'A B ’');
  check('url trimmed and stripped', n.url, 'https://x.com/a');
  check('blank summary dropped', n.summary, undefined);
}

// ─── dedup ───────────────────────────────────────────────────────

section('urlKey — what counts as the same link');
check('scheme, www and trailing slash ignored', urlKey('http://www.techcrunch.com/a/'), urlKey('https://techcrunch.com/a'));
check('HN items with different ids differ', urlKey('https://news.ycombinator.com/item?id=1') === urlKey('https://news.ycombinator.com/item?id=2'), false);

section('deduplicateItems — distinct items stay distinct');
{
  const out = deduplicateItems([
    item('hackernews_top', 'https://news.ycombinator.com/item?id=1', 'Ask HN: What are you using for evals', 50),
    item('hackernews_top', 'https://news.ycombinator.com/item?id=2', 'Tell HN: Our outage postmortem', 49),
    item('anthropic_changelog', 'https://p.dev/notes?entry=a#october-7-2026', 'We launched X', 80),
    item('anthropic_changelog', 'https://p.dev/notes?entry=b#october-7-2026', 'Fixed a bug in Y', 80),
  ]);
  check('four items survive', out.length, 4);
}

section('deduplicateItems — coverage is recorded on the surviving row');
{
  const out = deduplicateItems([
    item('techcrunch_ai', 'https://techcrunch.com/2026/10/13/character-ai-bankruptcy/', 'Character.AI files for bankruptcy', 77),
    item('hackernews_top', 'https://techcrunch.com/2026/10/13/character-ai-bankruptcy', 'Character.AI files for bankruptcy', 58,
      { hnId: '9', hnLink: 'https://news.ycombinator.com/item?id=9', hnPoints: 63, commentCount: 12 }),
  ]);
  check('one row', out.length, 1);
  check('press row survives', out[0].source, 'techcrunch_ai');
  check('HN copy recorded', out[0].metadata?.coveredBy, [{ source: 'hackernews_top', url: 'https://techcrunch.com/2026/10/13/character-ai-bankruptcy' }]);
  check('HN points kept', [out[0].metadata?.hnPoints, out[0].metadata?.hnLink, out[0].metadata?.commentCount],
    [63, 'https://news.ycombinator.com/item?id=9', 12]);
}
{
  const out = deduplicateItems([
    item('hackernews_top', 'https://example.com/a', 'Same story', 58, { hnId: '1', hnPoints: 63 }),
    item('techcrunch_ai', 'https://techcrunch.com/x', 'Same story', 77),
    item('show_hn', 'https://example.com/a', 'Same story', 50, { hnId: '2', hnPoints: 120 }),
  ]);
  check('higher score replaces the first copy', out[0].source, 'techcrunch_ai');
  check('all copies covered', (out[0].metadata?.coveredBy as { source: string }[]).map((c) => c.source).sort(), ['hackernews_top', 'show_hn']);
  check('carried HN points: the bigger thread', out[0].metadata?.hnPoints, 120);
}
{
  const out = deduplicateItems([
    item('hackernews_top', 'https://example.com/b', 'Show HN: Tool', 60, { hnId: '5', hnPoints: 40 }),
    item('show_hn', 'https://example.com/b', 'Show HN: Tool', 55, { hnId: '5', hnPoints: 41 }),
  ]);
  check('an HN row keeps its own points', out[0].metadata?.hnPoints, 40);
  check('…and lists the other HN source', out[0].metadata?.coveredBy, [{ source: 'show_hn', url: 'https://example.com/b' }]);
}
{
  const out = deduplicateItems([
    item('arxiv_cs_lg', 'https://arxiv.org/abs/2610.1', 'On the Off-Policy Teacher in On-Policy Distillation', 73),
    item('hf_daily_papers', 'https://huggingface.co/papers/2610.1', 'On the Off-Policy Teacher in On-Policy Distillation', 62, { upvotes: 24 }),
  ]);
  check('title match merges different URLs', out.length, 1);
  check('HF upvotes kept on the arXiv row', out[0].metadata?.upvotes, 24);
}

section('mergeStoredMetadata — later runs keep earlier coverage');
{
  const press = item('techcrunch_ai', 'https://techcrunch.com/x', 'Story', 70, { relevanceScore: 70 });
  const merged = mergeStoredMetadata(press, {
    relevanceScore: 77, hnPoints: 63, hnId: '9',
    coveredBy: [{ source: 'hackernews_top', url: 'https://techcrunch.com/x/' }, { source: 'techcrunch_ai', url: 'https://techcrunch.com/x' }],
  });
  check('fresh relevance score wins', merged.relevanceScore, 70);
  check('stored HN points kept when this run has none', merged.hnPoints, 63);
  check('stored coverage kept, row itself excluded', merged.coveredBy, [{ source: 'hackernews_top', url: 'https://techcrunch.com/x/' }]);
  const fresh = mergeStoredMetadata(item('techcrunch_ai', 'https://techcrunch.com/x', 'Story', 70, { hnPoints: 90 }), { hnPoints: 63 });
  check('fresh carried value wins over stored', fresh.hnPoints, 90);
  check('nothing stored → metadata unchanged', mergeStoredMetadata(press, undefined), { relevanceScore: 70 });
}

// ─── collectors ──────────────────────────────────────────────────

section('withHitsPerPage — Algolia returned 20 hits whatever maxItems said');
check('added', withHitsPerPage('https://hn.algolia.com/api/v1/search?query=AI', 25), 'https://hn.algolia.com/api/v1/search?query=AI&hitsPerPage=25');
check('explicit value wins', withHitsPerPage('https://h/search?hitsPerPage=5', 25), 'https://h/search?hitsPerPage=5');

section('parseDayDate — listing dates, independent of the machine time zone');
check('short month', parseDayDate('Oct 7, 2026'), '2026-10-07T00:00:00.000Z');
check('long month', parseDayDate('October 7, 2026'), '2026-10-07T00:00:00.000Z');
check('"Sept"', parseDayDate('Sept 3, 2026'), '2026-09-03T00:00:00.000Z');
check('impossible day', parseDayDate('Feb 30, 2026'), undefined);
check('not a date', parseDayDate('Announcements'), undefined);

section('scrapeAnthropicListing — the /news layout');
{
  // Trimmed from www.anthropic.com/news on 2026-10-14.
  const html = `<header><a href="/news"><time>Oct 1, 2026</time>Newsroom</a></header><main>
    <a href="/news/cyber-verification-program"><h2>Expanding the Cyber Verification Program</h2>
      <div><div class="FeaturedGrid__meta"><span>Announcements</span><time>Oct 6, 2026</time></div>
      <p>We’re launching a new, expanded version.</p></div></a>
    <a href="/claude-haiku-5-5"><div class="FeaturedGrid__meta"><span>Announcements</span><time>Oct 7, 2026</time></div>
      <h4 class="FeaturedGrid__title">Introducing Claude Haiku 5.5</h4><p>Our fastest small model yet.</p></a>
    <a href="/news/cyber-verification-program"><div class="PublicationList__meta"><time>Oct 6, 2026</time>
      <span class="PublicationList__subject">Announcements</span></div>
      <span class="PublicationList__title">Expanding the Cyber Verification Program</span></a>
    <a href="/news/singapore-office-opening"><div class="PublicationList__meta"><time>Oct 14, 2026</time>
      <span class="PublicationList__subject">Announcements</span></div>
      <span class="PublicationList__title">Anthropic opens Singapore office</span></a>
    <a href="/research/team/alignment"><span>Alignment</span></a>
    <a href="https://claude.com/blog/x"><time>Oct 9, 2026</time><h4>Elsewhere</h4></a>
  </main>`;
  const items = scrapeAnthropicListing(html, SOURCE, 'https://www.anthropic.com/news');
  check('dated anthropic.com cards only, featured duplicate merged', items.map((i) => i.url), [
    'https://www.anthropic.com/news/cyber-verification-program',
    'https://www.anthropic.com/claude-haiku-5-5',
    'https://www.anthropic.com/news/singapore-office-opening',
  ]);
  check('real titles, not the category label', items.map((i) => i.title), [
    'Expanding the Cyber Verification Program', 'Introducing Claude Haiku 5.5', 'Anthropic opens Singapore office',
  ]);
  check('model launch dated and summarized', [items[1].publishedAt, items[1].summary], ['2026-10-07T00:00:00.000Z', 'Our fastest small model yet.']);
  check('category kept', items[2].metadata, { category: 'Announcements' });
}

section('scrapeAnthropicChangelog — one item per bullet');
{
  const html = `<h3 id="october-7-2026">October 7, 2026<button>Copy link</button></h3>
    <ul><li>We've lowered the price of cache reads. Details follow.</li>
        <li>We've launched Claude Haiku 5.5 (<code>claude-haiku-5-5</code>), our most capable small model.<ul><li>Nested detail.</li></ul></li>
        <li>We've lowered the price of cache reads for batch too.</li></ul>
    <h3 id="october-6-2026">October 6, 2026</h3><ul><li>Fixed an SDK bug in streaming.</li></ul>
    <h3 id="see-also">See also</h3><ul><li>Not a release note at all.</li></ul>`;
  const items = scrapeAnthropicChangelog(html, { ...SOURCE, id: 'anthropic_changelog' }, 'https://platform.claude.com/docs/en/release-notes/overview');
  check('four bullets, nested list not split out, non-date heading ignored', items.length, 4);
  check('first sentence as title', items.map((i) => i.title), [
    "We've lowered the price of cache reads.",
    "We've launched Claude Haiku 5.5 (claude-haiku-5-5), our most capable small model.",
    "We've lowered the price of cache reads for batch too.",
    'Fixed an SDK bug in streaming.',
  ]);
  check('URL opens at the day, entry slug keeps it unique', items[1].url,
    'https://platform.claude.com/docs/en/release-notes/overview?entry=weve-launched-claude-haiku-5-5-claude-haiku#october-7-2026');
  check('same opening words get distinct slugs', new Set(items.map((i) => i.url)).size, 4);
  check('dated by heading id', items[3].publishedAt, '2026-10-06T00:00:00.000Z');
}

// ─── summary ─────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(52)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(52)}\n`);

if (failed > 0) process.exit(1);
