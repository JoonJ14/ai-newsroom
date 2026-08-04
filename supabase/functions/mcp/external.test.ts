/**
 * Regression tests for the live-lookup MCP tools (`_shared/external.ts`).
 *
 * Every case here corresponds to a defect that actually shipped during review;
 * each one failed before its fix. They cover the pure helpers only, so the suite
 * needs no network and no credentials.
 *
 * Usage: npm run test:mcp
 */

import {
  normalizeRepo,
  normalizeArxivId,
  decodeXmlEntities,
  maskCodeFences,
  extractQuickstart,
  sliceTag,
  readCapped,
} from './_shared/external.ts';

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

function rejects(label: string, fn: () => unknown) {
  try {
    const result = fn();
    failed++;
    console.log(`  FAIL  ${label} — expected a throw, got ${JSON.stringify(result)}`);
  } catch {
    passed++;
    console.log(`  ok    ${label}`);
  }
}

function section(title: string) {
  console.log(`\n${title}`);
}

// ─── normalizeRepo ───────────────────────────────────────────────

section('normalizeRepo — accepts the real-world forms');
check('bare owner/name', normalizeRepo('anthropics/claude-code'), 'anthropics/claude-code');
check('https URL', normalizeRepo('https://github.com/openai/codex'), 'openai/codex');
check('.git suffix', normalizeRepo('https://github.com/vllm-project/vllm.git'), 'vllm-project/vllm');
check('deep path is trimmed', normalizeRepo('https://github.com/openai/codex/tree/main'), 'openai/codex');
check('trailing slash', normalizeRepo('openai/codex/'), 'openai/codex');
check('dot in repo name', normalizeRepo('ggml-org/llama.cpp'), 'ggml-org/llama.cpp');
check('underscore in repo name', normalizeRepo('some-owner/repo_name.v2'), 'some-owner/repo_name.v2');
check('query string is dropped, not forwarded', normalizeRepo('https://github.com/openai/codex?tab=readme'), 'openai/codex');
check('fragment is dropped', normalizeRepo('a/b#readme'), 'a/b');

section('normalizeRepo — rejects inputs that would retarget the API call');
rejects('single segment', () => normalizeRepo('notarepo'));
rejects('parent traversal', () => normalizeRepo('../../users/octocat'));
// `repos/a/..` resolves to `repos/`, a different endpoint that has no full_name.
rejects('dot-segment repo name ".."', () => normalizeRepo('a/..'));
rejects('dot-segment repo name "."', () => normalizeRepo('a/.'));
rejects('space in name', () => normalizeRepo('a/b c'));
rejects('percent-encoded traversal', () => normalizeRepo('..%2F..%2Fusers/x'));
rejects('owner charset (underscore is not legal on GitHub)', () => normalizeRepo('bad_owner/repo'));

// ─── normalizeArxivId ────────────────────────────────────────────

section('normalizeArxivId');
check('modern id', normalizeArxivId('2501.12345'), '2501.12345');
check('versioned id', normalizeArxivId('2501.12345v2'), '2501.12345v2');
check('arXiv: prefix', normalizeArxivId('arXiv:2501.12345'), '2501.12345');
check('abs URL', normalizeArxivId('https://arxiv.org/abs/1706.03762v5'), '1706.03762v5');
check('pdf URL', normalizeArxivId('https://arxiv.org/pdf/1706.03762.pdf'), '1706.03762');
check('legacy id', normalizeArxivId('cs/0701001'), 'cs/0701001');
rejects('free text', () => normalizeArxivId('hello world'));
rejects('empty', () => normalizeArxivId(''));

// ─── decodeXmlEntities ───────────────────────────────────────────

section('decodeXmlEntities');
check('named entities', decodeXmlEntities('a &lt;b&gt; &quot;c&quot; &apos;d&apos; &amp; e'), `a <b> "c" 'd' & e`);
// &amp; must decode LAST, or "&amp;lt;" double-decodes into a real "<".
check('escaped entity stays literal', decodeXmlEntities('&amp;lt;script&amp;gt;'), '&lt;script&gt;');
check('escaped numeric stays literal', decodeXmlEntities('&amp;#60;b&amp;#62;'), '&#60;b&#62;');
check('decimal entity', decodeXmlEntities('&#233;'), 'é');
check('hex entity', decodeXmlEntities('&#x41;'), 'A');
// fromCharCode would truncate this above U+FFFF; fromCodePoint is required.
check('astral plane decimal', decodeXmlEntities('&#128512;'), '\u{1F600}');
check('astral plane hex', decodeXmlEntities('&#x1F600;'), '\u{1F600}');
check('lone high surrogate dropped', decodeXmlEntities('a&#xD800;b'), 'ab');
check('lone low surrogate dropped', decodeXmlEntities('a&#xDC00;b'), 'ab');
check('out-of-range dropped', decodeXmlEntities('a&#x110000;b'), 'ab');
// Some feeds encode an astral char as its UTF-16 pair; the halves must combine
// rather than each be discarded as a "lone" surrogate.
check('entity-encoded surrogate pair combines', decodeXmlEntities('&#xD83D;&#xDE00;'), '\u{1F600}');
check('surrogate pair survives surrounding text', decodeXmlEntities('a&#xD83D;&#xDE00;b'), 'a\u{1F600}b');
check('reversed halves are both dropped', decodeXmlEntities('&#xDE00;&#xD83D;'), '');

// ─── maskCodeFences ──────────────────────────────────────────────

section('maskCodeFences — offsets must survive exactly');
{
  const md = '# t\n\n```bash\n# not a heading\n```\n\n## Real\nbody\n';
  const masked = maskCodeFences(md);
  check('length preserved', masked.length, md.length);
  check(
    'newline offsets preserved',
    [...masked].map((c, i) => (c === '\n' ? i : -1)).filter((i) => i >= 0),
    [...md].map((c, i) => (c === '\n' ? i : -1)).filter((i) => i >= 0),
  );
  check('comment inside fence is masked', /^#\s*not a heading/m.test(masked), false);
  check('real heading survives', /^## Real$/m.test(masked), true);
}

// ─── extractQuickstart ───────────────────────────────────────────

section('extractQuickstart — heading selection');
check(
  'a passing mention of "usage" loses to a real quickstart heading',
  extractQuickstart('## Data collection, usage, and retention\nx\n\n## Get started\nrun it\n').heading,
  'Get started',
);
check(
  'emoji prefix does not block the match',
  extractQuickstart('## 🚀 Getting Started\nrun it\n').heading,
  '🚀 Getting Started',
);
check(
  'falls back to the top of the README when nothing matches',
  extractQuickstart('# Project\n\nJust prose.\n').matched,
  false,
);

section('extractQuickstart — a shell comment must not end the section');
{
  const md = [
    '## Quick start',
    '',
    '```bash',
    '# Install it',
    'npm i -g tool',
    '',
    '# Run it',
    'tool --start',
    '```',
    '',
    'Then open the app.',
    '',
    '## License',
    'MIT',
  ].join('\n');
  const { section: body } = extractQuickstart(md);
  check('commands after the first comment survive', body.includes('tool --start'), true);
  check('prose after the block survives', body.includes('Then open the app.'), true);
  check('code fences are balanced', (body.match(/```/g) ?? []).length % 2, 0);
  check('the next section is excluded', body.includes('MIT'), false);
}

section('extractQuickstart — fence variants');
{
  const tilde = '## Install\n~~~sh\n# comment\nnpm i\n~~~\ndone\n## Next\nx';
  check('tilde fence', extractQuickstart(tilde).section.includes('npm i'), true);
  check('tilde fence bounds the section', extractQuickstart(tilde).section.includes('x'), false);

  // CommonMark: a closing fence must be at least as long as the opening one,
  // so the inner ``` is content rather than a terminator.
  const nested = '## Install\n````md\n```bash\n# c\n```\n````\ntail\n## End\nz';
  check('nested fence of greater length', extractQuickstart(nested).section.includes('tail'), true);
  check('nested fence bounds the section', extractQuickstart(nested).section.includes('z'), false);
}

section('extractQuickstart — degenerate input');
check('empty string', extractQuickstart('').matched, false);
check('heading with no body', extractQuickstart('## Install').section, '');
check('unclosed fence does not throw', typeof extractQuickstart('## Install\n```sh\nnpm i\n').section, 'string');

section('extractQuickstart — ATX closing sequence and indentation');
check('closing hashes stripped', extractQuickstart('## Install ##\nrun it\n').heading, 'Install');
check('trailing hash kept when part of the word', extractQuickstart('## Install C#\nrun it\n').heading, 'Install C#');
check('heading indented up to 3 spaces is recognised', extractQuickstart('   ## Quick start\nrun it\n').heading, 'Quick start');
check(
  'indented peer heading bounds the section',
  extractQuickstart('## Install\nrun it\n   ## Next\nz\n').section.includes('z'),
  false,
);
check(
  'numbered + emoji prefix still matches',
  extractQuickstart('## 1. 🚀 Getting Started\nrun it\n').heading,
  '1. 🚀 Getting Started',
);

section('extractQuickstart — ReDoS guard (quadratic backtracking regression)');
{
  // The old `[ \t]+(.+?)[ \t]*#*$` form took ~2.3s on this input, past the
  // Edge Function CPU budget, and any caller could host such a README.
  const hostile = `# Quickstart${' '.repeat(16000)}x\n\n## Install\nnpm i\n`;
  const t0 = Date.now();
  extractQuickstart(hostile);
  const elapsed = Date.now() - t0;
  check(`16k-space heading completes fast (took ${elapsed}ms)`, elapsed < 250, true);
}

section('maskCodeFences — a fence only closes on a bare fence line');
{
  const md = '## Install\n```\ncode\n```not-a-close\n# fake heading\nmore\n```\n\n## End\nz';
  const body = extractQuickstart(md).section;
  check('info-string line does not close the block', body.includes('more'), true);
  check('fake heading inside block did not truncate', body.includes('# fake heading'), true);
}

section('extractQuickstart — truncation never leaves a fence open');
{
  const long = '## Install\n```bash\n' + 'echo hello\n'.repeat(600) + '```\ndone\n';
  const body = extractQuickstart(long, 200).section;
  check('fences balanced after truncation', (body.match(/```/g) ?? []).length % 2, 0);
}

section('decodeXmlEntities — single pass, no re-scanning of output');
// A numeric entity that decodes to "&" must not combine with following text
// into an entity the same pass then decodes again.
check('numeric ampersand stays literal', decodeXmlEntities('&#38;amp;'), '&amp;');
check('hex ampersand stays literal', decodeXmlEntities('&#x26;amp;'), '&amp;');
check('unknown named entity left alone', decodeXmlEntities('&nbsp;'), '&nbsp;');
check('adjacent entities', decodeXmlEntities('&lt;&gt;&amp;'), '<>&');

section('CRLF READMEs');
check('CR stripped from heading', extractQuickstart('## Install ##\r\nrun it\r\n').heading, 'Install');
check('CRLF section body intact', extractQuickstart('## Install\r\nnpm i\r\n## End\r\nz').section.includes('npm i'), true);
check('CRLF section still bounded', extractQuickstart('## Install\r\nnpm i\r\n## End\r\nz').section.includes('z'), false);
{
  // Offsets must stay exact under CRLF, since mask indices slice the original.
  const md = '## Install\r\n```\r\n# not a heading\r\n```\r\ntail\r\n';
  check('mask length preserved under CRLF', maskCodeFences(md).length, md.length);
  check('CRLF fenced comment did not truncate', extractQuickstart(md).section.includes('tail'), true);
}

section('XML tag scanning is linear (quadratic-regex regression)');
{
  // Repeated opening tags with no closes made the old lazy-quantifier regexes
  // rescan the suffix for every candidate open.
  const hostile = '<entry>' + '<category '.repeat(20000) + '</entry>';
  const t0 = Date.now();
  decodeXmlEntities(hostile);
  const elapsed = Date.now() - t0;
  check(`20k unclosed tags decode fast (took ${elapsed}ms)`, elapsed < 250, true);
}

section('sliceTag — XML extraction on hostile and malformed bodies');
check('plain tag', sliceTag('<summary>hello</summary>', 'summary')?.text, 'hello');
check('tag with attributes', sliceTag('<summary type="text">hi</summary>', 'summary')?.text, 'hi');
check('prefix collision skipped', sliceTag('<summary_detail>x</summary_detail><summary>real</summary>', 'summary')?.text, 'real');
check('self-closing has no body', sliceTag('<summary/>tail', 'summary')?.text, '');
check('missing close returns null', sliceTag('<summary>never closed', 'summary'), null);
check('malformed open returns null', sliceTag('<summary', 'summary'), null);
check('empty input returns null', sliceTag('', 'summary'), null);
check('namespaced tag', sliceTag('<arxiv:doi>10.1/x</arxiv:doi>', 'arxiv:doi')?.text, '10.1/x');
{
  // Recursing past each collision overflowed the stack, and a 200k body admits
  // more collisions than the frame limit — so this must stay iterative.
  const hostile = '<summary_detail>'.repeat(50000) + '<summary>ok</summary>';
  const t0 = Date.now();
  const got = sliceTag(hostile, 'summary')?.text;
  check(`50k prefix collisions resolve (${Date.now() - t0}ms, no stack overflow)`, got, 'ok');
}
// A `>` inside an attribute value is not the end of the tag.
check('quoted attribute containing >', sliceTag('<summary data="a>b">real</summary>', 'summary')?.text, 'real');
check('single-quoted attribute containing >', sliceTag("<summary d='a>b'>real</summary>", 'summary')?.text, 'real');
// The first </tag> is not necessarily the matching one.
check('nested identical tags close at the outer tag', sliceTag('<summary>a<summary>b</summary>c</summary>', 'summary')?.text, 'a<summary>b</summary>c');
// A </entry> inside CDATA would otherwise make a truncated body look complete.
check('close inside CDATA ignored', sliceTag('<entry><![CDATA[</entry>]]>real</entry>', 'entry')?.text, '<![CDATA[</entry>]]>real');
check('close inside a comment ignored', sliceTag('<entry><!-- </entry> -->x</entry>', 'entry')?.text, '<!-- </entry> -->x');
check('slash mid-tag is not self-closing', sliceTag('<summary/foo>wrong</summary>', 'summary')?.text, 'wrong');
// `</summary >` is valid XML; a fixed `</tag>` comparison rejects it.
check('whitespace in closing tag', sliceTag('<summary>real</summary >', 'summary')?.text, 'real');
check('nested tags with whitespace closes', sliceTag('<s>a<s>b</s >c</s >', 's')?.text, 'a<s>b</s >c');
check('unterminated CDATA returns null', sliceTag('<entry><![CDATA[ oops', 'entry'), null);
check('unterminated comment returns null', sliceTag('<entry><!-- oops', 'entry'), null);
{
  // The author loop advances by .end, which must account for a whitespace
  // closing tag or the loop would re-read the same element forever.
  const xml = '<author><name>A</name ></author ><author><name>B</name></author>';
  const names: string[] = [];
  let at = 0;
  for (let guard = 0; guard < 10; guard++) {
    const found = sliceTag(xml, 'author', at);
    if (!found) break;
    names.push(sliceTag(found.text, 'name')?.text ?? '?');
    at = found.end;
  }
  check('author loop reads both and terminates', names, ['A', 'B']);
}
{
  // The author loop advances by .end; if that ever failed to move forward the
  // handler would spin forever.
  const xml = '<author><name>A</name></author><author><name>B</name></author>';
  const first = sliceTag(xml, 'author');
  const second = first ? sliceTag(xml, 'author', first.end) : null;
  check('end offset advances past the first match', (first?.end ?? 0) > 0, true);
  check('second author found from that offset', sliceTag(second?.text ?? '', 'name')?.text, 'B');
}

// ─── readCapped ──────────────────────────────────────────────────
// The truncated flag gates whether an ArXiv body is parsed at all, so a false
// negative means a partial response is returned as a complete record.

async function readCappedTests() {
  const CAP = 1000;
  const body = (chunks: string[]) => {
    const enc = new TextEncoder();
    return new Response(
      new ReadableStream({
        start(c) {
          for (const chunk of chunks) c.enqueue(enc.encode(chunk));
          c.close();
        },
      }),
    );
  };

  section('readCapped — truncation detection at the boundary');

  // A chunk ending exactly on the cap is ambiguous and needs an EOF probe.
  let r = await readCapped(body(['x'.repeat(CAP), 'MORE']), CAP);
  check('chunk ends at cap with more to come → truncated', r.truncated, true);

  r = await readCapped(body(['x'.repeat(CAP)]), CAP);
  check('body exactly the cap → not truncated', r.truncated, false);
  check('body exactly the cap → full text kept', r.text.length, CAP);

  r = await readCapped(body(['x'.repeat(CAP - 1)]), CAP);
  check('one under the cap → not truncated', r.truncated, false);

  r = await readCapped(body(['x'.repeat(CAP + 500)]), CAP);
  check('overflow within one chunk → truncated', r.truncated, true);
  check('overflow → text capped', r.text.length, CAP);

  r = await readCapped(body([]), CAP);
  check('empty body', [r.text, r.truncated], ['', false]);

  // The surrogate back-off leaves length one under the cap; truncation must
  // still be reported, which is why it is a flag and not a length comparison.
  r = await readCapped(body(['x'.repeat(CAP - 1) + '\u{1F600}']), CAP);
  check('surrogate back-off still reports truncation', r.truncated, true);
  check('surrogate back-off leaves no lone surrogate', /[\uD800-\uDBFF]$/.test(r.text), false);

  // A trailing incomplete UTF-8 sequence must be flushed by the decoder rather
  // than silently dropped. Here the resulting U+FFFD lies past a 4-char cap, so
  // the contract is that it is EXCLUDED from the text but the body is still
  // reported as truncated — never returned as if it were complete.
  const bytes = (parts: (string | Uint8Array)[]) => {
    const enc = new TextEncoder();
    return new Response(
      new ReadableStream({
        start(c) {
          for (const p of parts) c.enqueue(typeof p === 'string' ? enc.encode(p) : p);
          c.close();
        },
      }),
    );
  };
  r = await readCapped(bytes(['abcd', new Uint8Array([0xf0])]), 4);
  check('dangling UTF-8 byte at cap → reported truncated', r.truncated, true);
  check('dangling UTF-8 byte at cap → text stays within cap', r.text, 'abcd');
}

await readCappedTests();

// ─── summary ─────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(52)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(52)}\n`);

if (failed > 0) process.exit(1);
