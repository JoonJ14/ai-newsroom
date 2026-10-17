/**
 * Regression tests for collection: item clean-up, dedup coverage, and the
 * Anthropic parsers. Each case is a defect found in the ranking audit (Oct
 * 2026). Pure functions and inline HTML only, so no network or credentials.
 *
 * Usage: npm run test:collect
 */

import { cleanText, decodeEntities, htmlToText, normalizeItem, stripTrackingParams } from '../utils/normalize.js';
import { coverageOf, deduplicateItems, urlKey } from '../utils/dedup.js';
import { mergeStoredMetadata, postgrestInList } from '../utils/supabase.js';
import { withHitsPerPage } from './hackernews.js';
import {
  enrichRecent, parseDayDate, readAnthropicArticle, scrapeAnthropicChangelog, scrapeAnthropicListing,
} from './scraper.js';
import { readBody } from '../utils/http.js';
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
check('control characters dropped, decoded or raw', cleanText('A&#27;[2J B\u0007\u009b C'), 'A[2J B C');
check('HN story_text to plain text, after normalizeItem', cleanText(htmlToText('<p>It&#x27;s here</p><p>see <a href="https://x.dev">x.dev</a></p>')), "It's here see x.dev");
check('…entities decoded exactly once', cleanText(htmlToText('<p>Escape &amp;lt;model&amp;gt;</p>')), 'Escape &lt;model&gt;');

section('stripTrackingParams — utm_* removed before the URL becomes identity');
check('InfoQ feed URL',
  stripTrackingParams('https://www.infoq.com/news/2026/10/a/?utm_campaign=infoq_content&utm_source=infoq&utm_medium=feed&utm_term=AI'),
  'https://www.infoq.com/news/2026/10/a/');
check('other parameters kept',
  stripTrackingParams('https://apnews.com/article/x?taid=6ac8&utm_campaign=TrueAnthem&utm_medium=AP'),
  'https://apnews.com/article/x?taid=6ac8');
check('URL without utm_ is not re-serialized', stripTrackingParams('https://Example.com'), 'https://Example.com');
check('HN item URL untouched', stripTrackingParams('https://news.ycombinator.com/item?id=1'), 'https://news.ycombinator.com/item?id=1');
check('percent-encoded keys too', stripTrackingParams('https://x.com/a?utm%5Fsource=rss&%75tm_medium=feed&id=1'), 'https://x.com/a?id=1');
check('…in upper case too', stripTrackingParams('https://x.com/a?%55%54%4D%5Fsource=rss&id=1'), 'https://x.com/a?id=1');

section('normalizeItem');
{
  const n = normalizeItem({ ...item('theverge_ai', ' https://x.com/a?utm_source=rss ', 'A\nB &#8217;', 1), summary: '  \n ' });
  check('title cleaned', n.title, 'A B ’');
  check('url trimmed and stripped', n.url, 'https://x.com/a');
  check('blank summary dropped', n.summary, undefined);
  const scraped = normalizeItem(item('anthropic_blog', 'https://anthropic.com/x', 'Escaping &lt;model&gt;\u001b', 1), { decoded: true });
  check('already-decoded text is not decoded again', scraped.title, 'Escaping &lt;model&gt;');
  const hn = normalizeItem({ ...item('hackernews_top', 'https://news.ycombinator.com/item?id=1', 'Ask HN', 1),
    summary: htmlToText(`<p>${'&amp;'.repeat(600)}</p>`) });
  check('HN summary cut to 500 characters after decoding', hn.summary, '&'.repeat(500));
  const emojiAt500 = normalizeItem({ ...item('x', 'https://x.com', 'T', 1), summary: `${'a'.repeat(499)}😀b` });
  check('summary cut never leaves half an emoji', emojiAt500.summary, 'a'.repeat(499));
  check('lone surrogates dropped from any text', normalizeItem({ ...item('x', 'https://x.com', 'T\uD83D', 1), summary: 'b\uDE00c' }),
    { ...item('x', 'https://x.com', 'T', 1), summary: 'bc' });
}

// ─── dedup ───────────────────────────────────────────────────────

section('urlKey — what counts as the same link');
check('scheme, www and trailing slash ignored', urlKey('http://www.techcrunch.com/a/'), urlKey('https://techcrunch.com/a'));
check('HN items with different ids differ', urlKey('https://news.ycombinator.com/item?id=1') === urlKey('https://news.ycombinator.com/item?id=2'), false);
check('a fragment is the same page', urlKey('https://site.com/story#comments'), urlKey('https://site.com/story'));
check('app routes in the fragment differ', urlKey('https://site.com/#/post/1') === urlKey('https://site.com/#/post/2'), false);

section('deduplicateItems — distinct items stay distinct');
{
  const out = deduplicateItems([
    item('hackernews_top', 'https://news.ycombinator.com/item?id=1', 'Ask HN: What are you using for evals', 50),
    item('hackernews_top', 'https://news.ycombinator.com/item?id=2', 'Tell HN: Our outage postmortem', 49),
    item('anthropic_changelog', 'https://p.dev/notes?entry=a#october-7-2026', 'We launched X', 80),
    item('anthropic_changelog', 'https://p.dev/notes?entry=b#october-7-2026', 'Fixed a bug in Y', 80),
  ]);
  check('four items survive', out.length, 4);
  const regions = deduplicateItems([
    item('anthropic_changelog', 'https://p.dev/notes?day=october-8-2026&entry=a', 'We added support for regional data residency in the Australia region', 80),
    item('anthropic_changelog', 'https://p.dev/notes?day=october-9-2026&entry=b', 'We added support for regional data residency in the Canada region', 80),
  ]);
  check('similar titles from one source stay two items', regions.length, 2);
  const bridged = deduplicateItems([
    ...regions,
    item('techcrunch_ai', 'https://t.com/residency', 'We added support for regional data residency in the Australia and Canada region', 70),
  ]);
  check('…even when another source\'s title matches both', bridged.map((i) => i.source).sort(),
    ['anthropic_changelog', 'anthropic_changelog']);

  // B's URL with A's title: the exact URL decides
  const byUrl = deduplicateItems([
    item('the_verge_ai', 'https://v.com/a', 'Alpha launches a model today', 50),
    item('the_verge_ai', 'https://v.com/b', 'Beta raises a round', 50),
    item('techcrunch_ai', 'https://v.com/b', 'Alpha launches a model today', 40),
  ]);
  check('an exact URL match goes before a similar title', byUrl.map((i) => [i.url, coverageOf(i).map((c) => c.source)]),
    [['https://v.com/a', []], ['https://v.com/b', ['techcrunch_ai']]]);
  // …whatever the order: the title match comes first in the input here
  const byUrlLate = deduplicateItems([
    item('techcrunch_ai', 'https://v.com/b', 'Alpha launches a model today', 40),
    item('the_verge_ai', 'https://v.com/a', 'Alpha launches a model today', 50),
    item('the_verge_ai', 'https://v.com/b', 'Beta raises a round', 50),
  ]);
  check('…even when the title match comes first', byUrlLate.map((i) => [i.url, coverageOf(i).map((c) => c.source)]).sort(),
    [['https://v.com/a', []], ['https://v.com/b', ['techcrunch_ai']]]);

  // Copies of one row never survive twice: an upsert batch would fail
  const rows = deduplicateItems([
    item('s1', 'https://x/x', 'alpha', 50), item('s2', 'https://x/y', 'alpha', 50), item('s3', 'https://x/z', 'beta', 50),
    item('s1', 'https://x/y', 'beta', 50), item('s1', 'https://x/y', 'gamma', 50),
  ]);
  const ids = rows.map((i) => `${i.source} ${i.url}`);
  check('each (url, source) survives at most once', ids.length, new Set(ids).size);
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
{
  // The 100-point thread's absorber is itself replaced, twice
  const out = deduplicateItems([
    item('techcrunch_ai', 'https://example.com/c', 'Big story', 60),
    item('hackernews_top', 'https://example.com/c', 'Big story', 50, { hnId: '1', hnPoints: 100 }),
    item('show_hn', 'https://example.com/c', 'Big story', 70, { hnId: '2', hnPoints: 50 }),
    item('the_verge_ai', 'https://example.com/c', 'Big story', 80),
  ]);
  check('the press survivor carries the biggest thread', [out[0].source, out[0].metadata?.hnPoints, out[0].metadata?.hnId],
    ['the_verge_ai', 100, '1']);
}
{
  const out = deduplicateItems([
    item('techcrunch_ai', 'https://x.com/story', 'Old headline about the launch', 50),
    item('the_verge_ai', 'https://y.com/copy', 'Shared new headline for the launch', 60),
    item('hackernews_top', 'https://x.com/story', 'Shared new headline for the launch', 40),
  ]);
  check('a copy matching one story by URL and another by title joins them', out.length, 1);
  check('…and every copy is covered', [out[0].source, (out[0].metadata?.coveredBy as { source: string }[]).map((c) => c.source).sort()],
    ['the_verge_ai', ['hackernews_top', 'techcrunch_ai']]);
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

section('postgrestInList — feed URLs quoted and escaped for the metadata lookup');
check('quotes, backslashes and reserved characters', postgrestInList(['https://a/x', 'https://a/"q"', 'https://a/b\\c', 'https://a/(1,2)']),
  '("https://a/x","https://a/\\"q\\"","https://a/b\\\\c","https://a/(1,2)")');

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

section('enrichRecent — the exact time decides, not the listing date');
{
  const DAY = 24 * 60 * 60 * 1000;
  const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
  // The listing date reads as midnight UTC; the real time can be up to 32 h later
  const boundary = { ...item('anthropic_blog', 'https://www.anthropic.com/news/a', 'A', 0), publishedAt: ago(8.3) };
  const unreadable = { ...item('anthropic_blog', 'https://www.anthropic.com/news/b', 'B', 0), publishedAt: ago(7.4) };
  const old = { ...item('anthropic_blog', 'https://www.anthropic.com/news/c', 'C', 0), publishedAt: ago(12) };
  const page = `<meta property="article:published_time" content="${ago(6.9)}">`;
  const read: string[] = [];
  // Logs one expected "Could not read …/news/b" warning
  const kept = await enrichRecent([boundary, unreadable, old], async (it) => {
    read.push(it.url);
    if (it === unreadable) throw new Error('timeout');
    readAnthropicArticle(it, page);
  });
  check('boundary item kept on its exact time', kept.map((i) => i.title), ['A']);
  check('items far outside the window are not fetched', read, [boundary.url, unreadable.url]);
}

section('readAnthropicArticle — summary and exact time from the article page');
{
  const listed = () => ({
    ...item('anthropic_blog', 'https://www.anthropic.com/news/x', 'X', 0),
    summary: 'Card text', publishedAt: '2026-10-07T00:00:00.000Z',
  });
  const para = '<main><p class="ReadingColumn_reading-column__x">Short.</p>' +
    '<p class="ReadingColumn_reading-column__x">The first paragraph long enough to stand in as a summary.</p></main>';

  const own = listed();
  readAnthropicArticle(own, '<meta name="description" content="What we found &amp; why.">' +
    '<meta property="article:published_time" content="2026-10-07T16:30:00Z">');
  check('own description, decoded', own.summary, 'What we found & why.');
  check('exact time replaces the listing date', own.publishedAt, '2026-10-07T16:30:00.000Z');

  const generic = listed();
  readAnthropicArticle(generic, '<meta name="description" content="Anthropic is an AI safety and research company that builds…">' + para);
  check('generic description → card text', generic.summary, 'Card text');
  check('no published_time → listing date kept', generic.publishedAt, '2026-10-07T00:00:00.000Z');

  const bare = { ...listed(), summary: undefined };
  readAnthropicArticle(bare, para);
  check('no description or card text → first long paragraph', bare.summary,
    'The first paragraph long enough to stand in as a summary.');
}

section('readBody — a response past the size cap is cancelled, not buffered');
{
  const outcome = (p: Promise<Uint8Array>) => p.then((b) => `${b.byteLength} bytes`, (e: Error) => e.message);
  // A body that never ends, and counts its cancellations: stopping to read isn't enough
  let cancelled = 0;
  const endless = () => new ReadableStream<Uint8Array>({
    pull: (c) => c.enqueue(new Uint8Array(4)),
    cancel: () => { cancelled++; },
  });
  check('within the cap', await outcome(readBody(new Response('x'.repeat(10)), 10)), '10 bytes');
  check('past the cap while streaming', await outcome(readBody(new Response(endless()), 10)),
    'Response larger than 10 bytes');
  check('declared length past the cap', await outcome(readBody(new Response(endless(), { headers: { 'content-length': '11' } }), 10)),
    'Response larger than 10 bytes');
  check('both bodies cancelled', cancelled, 2);
  check('default cap: 10 MB', [
    await outcome(readBody(new Response(new Uint8Array(10 * 1024 * 1024)))),
    await outcome(readBody(new Response(new Uint8Array(10 * 1024 * 1024 + 1)))),
  ], ['10485760 bytes', 'Response larger than 10485760 bytes']);
}

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
    <ul><li>We've lowered the price of cache reads for Sonnet. Details follow.</li>
        <li>We've launched Claude Haiku 5.5 (<code>claude-haiku-5-5</code>), our most capable small model.<ul><li>Nested detail.</li></ul></li>
        <li>We've lowered the price of cache reads for batch too.</li></ul>
    <h3 id="october-6-2026">October 6, 2026</h3><ul><li>Fixed an SDK bug in streaming.</li></ul>
    <h3 id="see-also">See also</h3><ul><li>Not a release note at all.</li></ul>`;
  const items = scrapeAnthropicChangelog(html, { ...SOURCE, id: 'anthropic_changelog' }, 'https://platform.claude.com/docs/en/release-notes/overview');
  check('four bullets, nested list not split out, non-date heading ignored', items.length, 4);
  check('first sentence as title', items.map((i) => i.title), [
    "We've lowered the price of cache reads for Sonnet.",
    "We've launched Claude Haiku 5.5 (claude-haiku-5-5), our most capable small model.",
    "We've lowered the price of cache reads for batch too.",
    'Fixed an SDK bug in streaming.',
  ]);
  check('URL opens at the day, entry slug keeps it unique', items[1].url,
    'https://platform.claude.com/docs/en/release-notes/overview?day=october-7-2026&entry=weve-launched-claude-haiku-5-5-claude-haiku#october-7-2026');
  check('same first eight words get distinct entries', new Set(items.map((i) => i.url)).size, 4);
  check('dated by heading id', items[3].publishedAt, '2026-10-06T00:00:00.000Z');

  // A third bullet with the same first eight words is added above the others,
  // and the day's order changes: every earlier bullet keeps its URL
  const later = html
    .replace("<ul><li>We've lowered", "<ul><li>We've lowered the price of cache reads for Opus.</li><li>We've lowered")
    .replace(/<li>We've lowered the price of cache reads for batch too\.<\/li><\/ul>/, '</ul>')
    .replace('<ul><li>', "<ul><li>We've lowered the price of cache reads for batch too.</li><li>");
  const urlOf = (list: NewsItem[]) => new Map(list.map((i) => [i.summary, i.url]));
  const before = urlOf(items);
  const after = urlOf(scrapeAnthropicChangelog(later, { ...SOURCE, id: 'anthropic_changelog' }, 'https://platform.claude.com/docs/en/release-notes/overview'));
  check('five bullets after the change', after.size, 5);

  const long = scrapeAnthropicChangelog(`<h3 id="october-8-2026">x</h3><ul><li>${'a'.repeat(200)}</li><li>${'word '.repeat(50)}</li></ul>`,
    { ...SOURCE, id: 'anthropic_changelog' }, 'https://platform.claude.com/docs/en/release-notes/overview');
  check('long titles cut to 160 characters at most, ellipsis included', long.map((i) => i.title.length), [160, 155]);
  const emoji = scrapeAnthropicChangelog(`<h3 id="october-8-2026">x</h3><ul><li>${'a'.repeat(158)}😀${'b'.repeat(10)}</li></ul>`,
    { ...SOURCE, id: 'anthropic_changelog' }, 'https://platform.claude.com/docs/en/release-notes/overview');
  check('an emoji at the cut is kept whole', emoji[0].title.endsWith('😀…'), true);

  // Same opening words on two days, different entries: dedup must keep both
  const twoDays = scrapeAnthropicChangelog(`<h3 id="october-9-2026">x</h3><ul><li>We've lowered the price of cache reads for Sonnet 5.</li></ul>
    <h3 id="october-8-2026">x</h3><ul><li>We've lowered the price of cache reads for Opus 5 and Haiku 5.5.</li></ul>`,
    { ...SOURCE, id: 'anthropic_changelog' }, 'https://platform.claude.com/docs/en/release-notes/overview');
  check('same words on two days survive dedup', deduplicateItems(twoDays).length, 2);
  check('earlier bullets keep their URLs', [...before].filter(([text, url]) => after.get(text) !== url), []);
}

// ─── summary ─────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(52)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(52)}\n`);

if (failed > 0) process.exit(1);
