/**
 * Regression tests for the digest: stories and their representative item,
 * sections and thresholds, yesterday's lead, the unjudged count, the
 * fallback, per-field escaping, Discord's limits, both layouts, the plain-text
 * adapters, and the guarantee that a preview never sends or writes. A fake
 * store and a stubbed fetch only, so no network or credentials.
 *
 * Usage: npm run test:digest
 */

import type { NewsItem } from '../collectors/types.js';
import { loadSources, type StoredItem } from '../editor/db.js';
import {
  buildSections, groupStories, isWireUrl, sourceClass, sourceDirectory, type JudgedItem,
} from '../editor/select.js';
import { SOURCE_DISPLAY_NAMES } from '../utils/source-names.js';
import { buildDigest, EMPTY_INTRO, FOOTER_FALLBACK, NO_STORIES, type ShownStories } from './build.js';
import { digestSettings, type DigestSettings } from './config.js';
import {
  discordPayloads, DISCORD_LIMITS, escapeDiscord, renderDiscordEmbeds, renderDiscordPlain, renderText, safeUrl,
  splitText, type DigestDocument,
} from './render.js';
import { runDigest } from './run.js';
import { parseShown, type DigestStore } from './store.js';
import { sendSlackDigest } from './adapters/slack.js';
import { sendTelegramDigest } from './adapters/telegram.js';
import { sendDiscordDigest } from './adapters/discord.js';

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

const SOURCES = loadSources();
const DIR = sourceDirectory(SOURCES);
const SETTINGS: DigestSettings = digestSettings({});
const NOW = new Date('2026-10-17T13:00:00.000Z');

let seq = 0;
function judged(
  source: string,
  j: Partial<JudgedItem['judgment']> = {},
  extra: Partial<NewsItem> = {},
): JudgedItem & StoredItem {
  const id = `id${String(++seq).padStart(3, '0')}`;
  return {
    id, title: `title ${id}`, source, url: `https://example.com/${id}`, sourceCategory: 'industry_news', score: 50,
    tags: [], fetchedAt: '2026-10-17T10:00:00.000Z', publishedAt: '2026-10-17T09:00:00.000Z', metadata: {},
    judgment: {
      type: 'business', importance: 5, audience: 'general', headline: `Headline ${id}`, why: `Why ${id}`,
      storyKey: `key-${id}`, followup: false, model: 'claude-haiku-5-5', version: 'test', judgedAt: NOW.toISOString(), ...j,
    },
    ...extra,
  };
}

function unjudged(source = 'techcrunch_ai'): StoredItem {
  const { judgment: _, ...rest } = judged(source);
  return rest;
}

const keysOf = (list: { key: string }[]) => list.map((s) => s.key);

// ─── display names ───────────────────────────────────────────────

section('display names — one shared map');
check('every source in sources.yaml has a display name',
  SOURCES.filter((s) => !SOURCE_DISPLAY_NAMES[s.id]).map((s) => s.id), []);
check('the ids the audit found raw now read as names',
  ['wired_ai', 'guardian_ai', 'theverge_ai', 'techcrunch_ai', 'ars_technica_ai'].map((id) => DIR.name(id)),
  ['WIRED', 'The Guardian', 'The Verge', 'TechCrunch', 'Ars Technica']);

// ─── stories ─────────────────────────────────────────────────────

section('story grouping');
{
  const items = [
    judged('techcrunch_ai', { storyKey: 'gpt6', importance: 8 }, { metadata: { coveredBy: [{ source: 'wired_ai', url: 'w' }, { source: 'theverge_ai', url: 'v' }] } }),
    judged('theverge_ai', { storyKey: 'gpt6', importance: 9 }),
    judged('hackernews_top', { storyKey: 'gpt6', importance: 6 }),
    judged('guardian_ai', { storyKey: 'other', importance: 4 }),
  ];
  const stories = groupStories(items, DIR);
  const gpt6 = stories.find((s) => s.key === 'gpt6')!;
  check('copies with one key are one story', [stories.length, gpt6.items.length], [2, 3]);
  check('importance is the highest of its items', gpt6.importance, 9);
  check('outlets: sources and coveredBy, by display name, once each', gpt6.outlets,
    ['The Verge', 'TechCrunch', 'WIRED', 'Hacker News']);
}

section('representative item');
{
  const lead = (...items: JudgedItem[]) => groupStories(items, DIR)[0].lead.source;
  const k = { storyKey: 's', importance: 7 };
  check('official lab first', lead(judged('techcrunch_ai', k), judged('anthropic_blog', k), judged('hackernews_top', k)), 'anthropic_blog');
  check('then a wire service, linked via Hacker News',
    lead(judged('techcrunch_ai', k), judged('hackernews_top', k, { url: 'https://www.reuters.com/tech/x' })), 'hackernews_top');
  check('the HN item links the article, not the thread',
    groupStories([judged('hackernews_top', k, { url: 'https://apnews.com/article/x', metadata: { hnLink: 'https://news.ycombinator.com/item?id=1' } })], DIR)[0].lead.url,
    'https://apnews.com/article/x');
  check('then tier-1/2 press', lead(judged('thenewstack_ai', k), judged('guardian_ai', k), judged('devto_ai', k)), 'guardian_ai');
  check('within a class, higher importance',
    groupStories([judged('techcrunch_ai', { storyKey: 's', importance: 7 }), judged('wired_ai', { storyKey: 's', importance: 8 })], DIR)[0].lead.source,
    'wired_ai');
  check('then the earliest published',
    lead(judged('techcrunch_ai', k, { publishedAt: '2026-10-17T08:00:00Z' }), judged('wired_ai', k, { publishedAt: '2026-10-17T06:00:00Z' })),
    'wired_ai');
  check('wire domains match subdomains only', [isWireUrl('https://uk.reuters.com/a'), isWireUrl('https://notreuters.com/a')], [true, false]);
  check('source classes', [
    sourceClass(judged('openai_news'), DIR), sourceClass(judged('hackernews_top', {}, { url: 'https://www.ft.com/x' }), DIR),
    sourceClass(judged('ars_technica_ai'), DIR), sourceClass(judged('infoq_ai'), DIR),
  ], ['official', 'wire', 'press', 'other']);
  check('a partner lab post about someone else\'s launch does not represent it',
    lead(
      judged('nvidia_developer_blog', { storyKey: 's', importance: 8, audience: 'builder' }),
      judged('techcrunch_ai', { storyKey: 's', importance: 8 }),
    ), 'techcrunch_ai');
  check('nor does an official post rated well below the story',
    lead(judged('openai_news', { storyKey: 's', importance: 5 }), judged('techcrunch_ai', { storyKey: 's', importance: 8 })),
    'techcrunch_ai');
}

// ─── sections ────────────────────────────────────────────────────

section('sections and thresholds');
{
  const items = [
    ...[9, 8, 7, 6, 6, 6].map((importance) => judged('techcrunch_ai', { importance })),
    ...[5, 4, 4, 4, 4, 3].map((importance) => judged('theverge_ai', { importance })),
    judged('vllm_releases', { importance: 7, audience: 'builder', type: 'tool_release' }),
    judged('github_trending', { importance: 5, audience: 'builder' }),
    judged('claude_code_releases', { importance: 2, audience: 'builder', type: 'patch_release' }),
    judged('arxiv_cs_lg', { importance: 7, type: 'research', audience: 'builder' }),
    judged('hf_daily_papers', { importance: 6, type: 'research' }),
    judged('hf_daily_papers', { importance: 5, type: 'research' }),
  ];
  const s = buildSections(groupStories(items, DIR), DIR);
  const imp = (list: { importance: number }[]) => list.map((x) => x.importance);
  check('top stories: up to 5 general at 6+, by importance', imp(s.top), [9, 8, 7, 6, 6]);
  check('also notable: next in rank at 4+, up to 5', imp(s.alsoNotable), [6, 5, 4, 4, 4]);
  check('for builders: builder stories at 4+ not shown elsewhere', imp(s.builders), [7, 5]);
  check('paper of note: one research story at 6+', imp(s.paper), [7]);
  check('nothing below its threshold anywhere',
    [s.top, s.alsoNotable, s.builders, s.paper].flat().some((x) => x.importance < 4), false);
  check('each story in one section only',
    new Set([s.top, s.alsoNotable, s.builders, s.paper].flat()).size, [s.top, s.alsoNotable, s.builders, s.paper].flat().length);

  const short = buildSections(groupStories([
    judged('techcrunch_ai', { importance: 6 }),
    judged('vllm_releases', { importance: 7, audience: 'builder' }),
    judged('github_trending', { importance: 6, audience: 'builder' }),
  ], DIR), DIR);
  check('builder stories fill Top stories only at 7+, after general ones', [imp(short.top), imp(short.builders)], [[7, 6], [6]]);

  const custom = buildSections(groupStories(items, DIR), DIR, { rules: { ...SETTINGS.rules, topLimit: 2, topMinImportance: 8 } });
  check('thresholds are configurable', imp(custom.top), [9, 8]);
}

section('quiet day');
{
  const plan = await buildDigest({
    items: [judged('techcrunch_ai', { importance: 5 }), judged('theverge_ai', { importance: 2 })],
    editorColumns: true, now: NOW, sources: SOURCES, dir: DIR, settings: SETTINGS, ledBefore: new Set(),
  });
  const text = renderText(plan.doc);
  check('no top stories: one line says so', text.includes('No top stories today: nothing was rated 6 or higher.'), true);
  check('fewer items, no padding', [plan.shown.top.length, plan.shown.alsoNotable.length, plan.shown.builders.length], [0, 1, 0]);
  check('empty sections are left out', [text.includes('FOR BUILDERS'), text.includes('PAPER OF NOTE')], [false, false]);

  const empty = await buildDigest({
    items: [], editorColumns: true, now: NOW, sources: SOURCES, dir: DIR, settings: SETTINGS, ledBefore: new Set(),
  });
  check('an empty window still sends a quiet-day message', [empty.mode, empty.doc.intro], ['empty', EMPTY_INTRO]);
}

section("yesterday's lead");
{
  const old1 = judged('techcrunch_ai', { storyKey: 'muse', importance: 8 });
  const old2 = judged('theverge_ai', { storyKey: 'muse', importance: 8 });
  const fresh = judged('wired_ai', { storyKey: 'ftc', importance: 7 });
  const led = new Set(['muse']);
  const s = buildSections(groupStories([old1, old2, fresh], DIR), DIR, { ledBefore: led });
  check('a story that led yesterday is not repeated', [keysOf(s.top), keysOf(s.repeats)], [['ftc'], ['muse']]);
  check('not even lower down', [s.alsoNotable, s.builders].flat().length, 0);

  const follow = judged('guardian_ai', { storyKey: 'muse', importance: 7, followup: true, headline: 'Meta pulls Muse' });
  const f = buildSections(groupStories([old1, old2, follow, fresh], DIR), DIR, { ledBefore: led });
  check('unless a newer item is a follow-up', keysOf(f.top), ['ftc', 'muse']);
  check('and then the follow-up represents it', f.top.find((x) => x.key === 'muse')!.lead.judgment.headline, 'Meta pulls Muse');
  check('a story that was only "also notable" may lead today',
    keysOf(buildSections(groupStories([old1], DIR), DIR, { ledBefore: new Set() }).top), ['muse']);
}

// ─── unjudged items and the fallback ─────────────────────────────

section('unjudged items');
{
  const plan = await buildDigest({
    items: [judged('techcrunch_ai', { importance: 7 }), judged('wired_ai'), judged('theverge_ai'), unjudged(), unjudged()],
    editorColumns: true, now: NOW, sources: SOURCES, dir: DIR, settings: SETTINGS, ledBefore: new Set(),
  });
  check('left out of the sections and counted in the footer',
    [plan.mode, plan.unjudged, plan.doc.footer], ['editor', 2, 'Ranked by the AI editor · 3 items reviewed (+2 items not yet rated)']);
  check('none of them shown', plan.doc.sections.flatMap((s) => s.entries).some((e) => e.headline.startsWith('title')), false);
}

section('fallback');
{
  const base = { now: NOW, sources: SOURCES, dir: DIR, settings: SETTINGS, ledBefore: new Set<string>() };
  const mostlyUnjudged = [judged('techcrunch_ai', { importance: 9 }), unjudged('techcrunch_ai'), unjudged('openai_news')];
  const fb = await buildDigest({ ...base, items: mostlyUnjudged, editorColumns: true });
  check('under half judged: old ranking, fallback footer', [fb.mode, fb.doc.footer], ['fallback', FOOTER_FALLBACK]);
  check('the reason is reported', fb.reason, 'only 1 of 3 items are judged (33%, under 50%)');
  check('nothing recorded as led', fb.shown, NO_STORIES);
  check('the fallback still uses safe links',
    renderDiscordPlain(fb.doc).join('\n').includes('](<https://example.com/'), true);

  const half = [judged('techcrunch_ai', { importance: 9 }), unjudged()];
  check('exactly half judged is enough', (await buildDigest({ ...base, items: half, editorColumns: true })).mode, 'editor');
  check('editor columns unreadable: fallback',
    (await buildDigest({ ...base, items: [judged('techcrunch_ai')], editorColumns: false })).mode, 'fallback');
  check('the threshold is configurable',
    (await buildDigest({ ...base, items: mostlyUnjudged, editorColumns: true, settings: digestSettings({ DIGEST_MIN_JUDGED_SHARE: '0.3' }) })).mode,
    'editor');
  let summarized = 0;
  await buildDigest({ ...base, items: mostlyUnjudged, editorColumns: true, summarize: async () => { summarized++; return 'S'; } });
  await buildDigest({ ...base, items: half, editorColumns: true, summarize: async () => { summarized++; return 'S'; } });
  check('only the fallback asks for the AI summary', summarized, 1);
}

section('settings');
{
  check('plain by default', digestSettings({}).layout, 'plain');
  check('DIGEST_LAYOUT=embeds', digestSettings({ DIGEST_LAYOUT: 'embeds' }).layout, 'embeds');
  const bad = digestSettings({ DIGEST_LAYOUT: 'fancy', DIGEST_TOP_LIMIT: 'lots', DIGEST_MIN_JUDGED_SHARE: '2' });
  check('a bad value warns and keeps the default, never stops the digest',
    [bad.layout, bad.rules.topLimit, bad.minJudgedShare, bad.warnings.length], ['plain', 5, 0.5, 3]);
  check('thresholds from env', digestSettings({ DIGEST_TOP_MIN_IMPORTANCE: '7', DIGEST_PAPER_LIMIT: '0' }).rules.topMinImportance, 7);
  check('last_digest_story_keys parsing', [
    parseShown('{"top":["a",1],"alsoNotable":["b"]}'), parseShown('not json'), parseShown('["a"]'), parseShown(null),
  ], [{ top: ['a'], alsoNotable: ['b'], builders: [], paper: [] }, null, null, null]);
}

// ─── formatting and safety ───────────────────────────────────────

const HOSTILE = '[x](https://evil.example) @everyone ||spoiler|| **bold** <@123> `code` ~~s~~ _i_ \\';

function doc(entries: number, opts: { why?: string; headline?: string; url?: string } = {}): DigestDocument {
  const entry = (i: number) => ({
    headline: opts.headline ?? `Story number ${i} with a reasonably long headline about a model launch`,
    url: opts.url ?? `https://www.example.com/2026/10/17/a-fairly-long-article-slug-for-story-number-${i}-goes-here`,
    why: opts.why ?? 'A line on why this matters to people who follow AI, about twenty-five words long, give or take a few.',
    outlets: ['TechCrunch', 'The Verge', 'WIRED'],
  });
  return {
    date: NOW,
    sections: [
      { title: 'Top stories', icon: '📰', style: 'stories', entries: Array.from({ length: entries }, (_, i) => entry(i + 1)) },
      { title: 'Also notable', icon: '📌', style: 'list', entries: Array.from({ length: entries }, (_, i) => entry(i + 100)) },
    ],
    footer: 'Ranked by the AI editor · 99 items reviewed',
  };
}

section('per-field escaping');
{
  const hostile: DigestDocument = {
    ...doc(1, { headline: HOSTILE, why: HOSTILE }),
    intro: HOSTILE,
  };
  hostile.sections[0].entries[0].outlets = [HOSTILE];
  const plain = renderDiscordPlain(hostile).join('\n');
  const escaped = escapeDiscord(HOSTILE);
  check('a hostile title is escaped', escaped,
    '\\[x\\](https\\://evil.example) @\u2060everyone \\|\\|spoiler\\|\\| \\*\\*bold\\*\\* \\<@\u2060123\\> \\`code\\` \\~\\~s\\~\\~ \\_i\\_ \\\\');
  check('it cannot open a link of its own: no unescaped "](" or "://"',
    [/(^|[^\\])\]\(https/.test(escaped), /(^|[^\\]):\/\//.test(escaped)], [false, false]);
  check('no live @everyone, spoiler or mention left', [/@everyone/.test(plain), /(^|[^\\])\|\|/.test(plain), /<@\d/.test(plain)], [false, false, false]);
  check('our masked link survives, label escaped',
    plain.includes(`**1. [${escaped}](<https://www.example.com/`), true);
  check('our bold headers and subtext footer survive',
    [plain.includes('**📰 Top stories**'), plain.includes('\n-# Ranked by the AI editor')], [true, true]);
  check('a newline in a field cannot start a line of markup', escapeDiscord('a\n# b\n-# c\n> d'), 'a # b -# c \\> d');
  const embeds = JSON.stringify(renderDiscordEmbeds(hostile));
  check('embeds are escaped the same way', embeds.includes(JSON.stringify(escaped).slice(1, -1)), true);
}

section('links');
{
  check('only http(s) is linked', [safeUrl('javascript:alert(1)'), safeUrl('ftp://x'), safeUrl('not a url')], [undefined, undefined, undefined]);
  check('characters that would end the link are encoded',
    safeUrl('https://x.dk/Dom-(H%C3%B8j)>a b'), 'https://x.dk/Dom-%28H%C3%B8j%29%3Ea%20b');
  const unsafe = renderDiscordPlain(doc(1, { url: 'javascript:alert(1)' })).join('\n');
  check('an unsafe URL is shown unlinked', [unsafe.includes('javascript'), unsafe.includes('**1. Story number 1')], [false, true]);
  const p = renderDiscordPlain(doc(1)).join('\n');
  check('Discord links are masked, with <…> to stop preview cards',
    p.includes('[Story number 1 with a reasonably long headline about a model launch](<https://www.example.com/'), true);
  check('no bare scheme-less URLs (the old "→ example.com/…" lines)', /→ /.test(p), false);
}

section('Discord limits');
{
  const typical = renderDiscordPlain(doc(3));
  check('a typical small digest is one message', typical.length, 1);

  const big = doc(25);
  const messages = renderDiscordPlain(big);
  check('every message fits 2,000 characters', messages.every((m) => m.length <= DISCORD_LIMITS.content), true);
  check('it took several messages', messages.length > 1, true);
  const whole = (i: number) => `**${i}. [Story number ${i} with a reasonably long headline about a model launch]`;
  check('no story is split across messages',
    Array.from({ length: 25 }, (_, i) => messages.filter((m) => m.includes(whole(i + 1))).length === 1 &&
      messages.some((m) => m.includes(whole(i + 1)) && m.includes(`for-story-number-${i + 1}-goes-here>)**\n   A line on why`))).every(Boolean),
    true);
  check('a section header stays with its first entry',
    messages.every((m) => !/\*\*📌 Also notable\*\*$/.test(m)), true);

  const huge = doc(1, { why: 'w '.repeat(1500) });
  const hugeMsgs = renderDiscordPlain(huge);
  check('an entry too long for a message is shortened, not split',
    [hugeMsgs.every((m) => m.length <= DISCORD_LIMITS.content), hugeMsgs.some((m) => m.includes('**1. Story number 1'))], [true, true]);

  const e = renderDiscordEmbeds(doc(40));
  const size = (em: { title: string; description: string; footer?: { text: string } }) =>
    em.title.length + em.description.length + (em.footer?.text.length ?? 0);
  check('embeds: descriptions fit 4,096', e.flatMap((p) => p.embeds!).every((em) => em.description.length <= DISCORD_LIMITS.embedDescription), true);
  check('embeds: at most 10 and 6,000 characters per message',
    e.every((p) => p.embeds!.length <= 10 && p.embeds!.reduce((n, em) => n + size(em), 0) <= DISCORD_LIMITS.embedTotal), true);
  check('embeds: a long section continues in a second embed',
    e.flatMap((p) => p.embeds!).some((em) => em.title === '📰 Top stories (continued)'), true);
  check('a typical digest is one embeds message', renderDiscordEmbeds(doc(5)).length, 1);
}

section('layouts');
{
  const plain = discordPayloads(doc(2), 'plain');
  check('plain: regular message, no mentions, no preview cards',
    [typeof plain[0].content, plain[0].embeds, plain[0].allowed_mentions, plain[0].flags], ['string', undefined, { parse: [] }, 4]);
  check('plain: numbered top stories with why-line and outlets',
    /\*\*1\. \[.*\]\(<https:.*>\)\*\*\n {3}A line on why.*\n {3}\*TechCrunch · The Verge · WIRED\*/.test(plain[0].content!), true);
  check('plain: one-line list items', /\n• \[Story number 100 .*\]\(<https:.*>\) · TechCrunch\n/.test(plain[0].content!), true);

  const embeds = discordPayloads(doc(2), 'embeds');
  check('embeds: one message, one embed per section, header as text',
    [embeds.length, embeds[0].embeds!.map((em) => em.title), embeds[0].content], [1, ['📰 Top stories', '📌 Also notable'], '**🤖 AI Newsroom** · Saturday, October 17, 2026']);
  check('embeds: link and why-line in the description',
    embeds[0].embeds![0].description.startsWith('**1. [Story number 1 with a reasonably long headline about a model launch](https://www.example.com/'), true);
  check('embeds: no SUPPRESS_EMBEDS flag (it would hide them), mentions off', [embeds[0].flags, embeds[0].allowed_mentions], [undefined, { parse: [] }]);
  check('embeds: the ranking line in the last footer',
    embeds[0].embeds!.at(-1)!.footer!.text, 'Ranked by the AI editor · 99 items reviewed · github.com/JoonJ14/ai-newsroom');
}

// ─── adapters (stubbed fetch) ────────────────────────────────────

const realFetch = globalThis.fetch;
const posted: { url: string; body: Record<string, unknown> }[] = [];
globalThis.fetch = (async (url: string, init: { body: string }) => {
  posted.push({ url: String(url), body: JSON.parse(init.body) });
  return new Response('{}', { status: 200 });
}) as unknown as typeof fetch;

section('plain-text adapters');
{
  const text = renderText({ ...doc(2, { headline: 'Q&A <b> @alice' }) });
  check('full https URLs on their own line',
    text.split('\n').filter((l) => l.includes('example.com')).every((l) => /^ *https:\/\/\S+$/.test(l)), true);
  check('no markup in the text rendering', [/\*\*|\]\(</.test(text)], [false]);

  process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.test/x';
  posted.length = 0;
  await sendSlackDigest(text);
  const slack = posted[0].body;
  check('Slack: plain text, mrkdwn off, & < > escaped',
    [slack.mrkdwn, String(slack.text).includes('Q&amp;A &lt;b&gt;'), String(slack.text).includes('https://www.example.com/')], [false, true, true]);

  process.env.TELEGRAM_BOT_TOKEN = 't';
  process.env.TELEGRAM_CHAT_ID = 'c';
  posted.length = 0;
  await sendTelegramDigest(text);
  const tg = posted[0].body;
  check('Telegram: no parse_mode, @ joined so it is not a mention',
    [tg.parse_mode, String(tg.text).includes('@\u2060alice'), String(tg.text).includes('Q&A <b>')], [undefined, true, true]);

  const long = renderText(doc(40));
  const parts = splitText(long, 4096);
  const together = (n: number) => parts.some((p) => p.includes(`Story number ${n} `) && p.includes(`story-number-${n}-goes-here`));
  check('split at blank lines or between list items: every part fits, no story split',
    [parts.length > 1, parts.every((p) => p.length <= 4096), [1, 20, 40, 100, 120, 139].every(together)], [true, true, true]);

  process.env.DISCORD_WEBHOOK_URL = 'https://discord.test/webhook';
  posted.length = 0;
  await sendDiscordDigest(doc(2), 'plain');
  check('Discord: the rendered payload is sent as is', [posted.length, posted[0].body.flags, posted[0].body.allowed_mentions], [1, 4, { parse: [] }]);
}

// ─── runs: preview, dry run, send ────────────────────────────────

section('runs — a preview never sends or writes');
{
  const calls = { save: 0, deliver: 0, windows: [] as string[] };
  const day = (iso: string, key: string, importance = 8) => judged('techcrunch_ai', { storyKey: key, importance }, { fetchedAt: iso });
  const store: DigestStore = {
    lastDigestAt: async () => '2026-10-16T13:00:00.000Z',
    lastShown: async () => ({ ...NO_STORIES, top: ['old-lead'] }),
    items: async (from, to) => {
      calls.windows.push(`${from.toISOString()}→${to.toISOString()}`);
      // The day before: "yesterday" leads; the day itself: the same story again, and a new one
      return to.toISOString().startsWith('2026-10-15')
        ? { items: [day('2026-10-15T20:00:00Z', 'yesterday')], editorColumns: true }
        : { items: [day('2026-10-16T20:00:00Z', 'yesterday'), day('2026-10-16T21:00:00Z', 'today', 7)], editorColumns: true };
    },
    save: async () => { calls.save++; },
  };
  const base = { store, now: NOW, settings: SETTINGS, layout: 'plain' as const, sources: SOURCES, dir: DIR,
    deliver: async () => { calls.deliver++; } };

  const preview = await runDigest({ ...base, mode: 'preview', date: '2026-10-16' });
  check('preview: nothing delivered, digest_state untouched', [calls.deliver, calls.save, preview.sent], [0, 0, false]);
  check('preview: the 9:00 AM ET window of that date, and the day before for its lead',
    calls.windows, ['2026-10-14T13:00:00.000Z→2026-10-15T13:00:00.000Z', '2026-10-15T13:00:00.000Z→2026-10-16T13:00:00.000Z']);
  check("preview: the previous morning's lead is rebuilt, and not repeated", [preview.ledBefore, preview.shown.top], [['yesterday'], ['today']]);

  calls.windows.length = 0;
  const dry = await runDigest({ ...base, mode: 'dry-run' });
  check('dry run: from last_digest_at to now, nothing sent or stored',
    [calls.windows, calls.deliver, calls.save, dry.ledBefore], [['2026-10-16T13:00:00.000Z→2026-10-17T13:00:00.000Z'], 0, 0, ['old-lead']]);

  let saved: [string, ShownStories] | undefined;
  const sent = await runDigest({ ...base, mode: 'send', store: { ...store, save: async (at, shown) => { saved = [at, shown]; } } });
  check('send: delivered once, then window end and shown keys stored',
    [calls.deliver, saved, sent.sent], [1, ['2026-10-17T13:00:00.000Z', { top: ['yesterday', 'today'], alsoNotable: [], builders: [], paper: [] }], true]);

  let savedAfterFailure = false;
  const failing = runDigest({
    ...base, mode: 'send', store: { ...store, save: async () => { savedAfterFailure = true; } },
    deliver: async () => { throw new Error('webhook down'); },
  });
  check('a failed send is not recorded as sent', [await failing.then(() => 'sent', () => 'threw'), savedAfterFailure], ['threw', false]);
}

globalThis.fetch = realFetch;

// ─── summary ─────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(52)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(52)}\n`);

if (failed > 0) process.exit(1);
