/**
 * Clean-up applied to every collected item before filtering, scoring and
 * dedup (src/collectors/index.ts), so no collector has to remember it.
 *
 * - Titles and summaries: HTML entities decoded (The Verge's feed sends
 *   `&#8217;`), and newlines and runs of whitespace collapsed to one space.
 * - URLs: `utm_*` parameters removed. The URL is half of a row's identity
 *   `(url, source)`, so tracking parameters must go before it is stored.
 */

import type { NewsItem } from '../collectors/types.js';

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  laquo: '«', raquo: '»', middot: '·', bull: '•', copy: '©', reg: '®', trade: '™',
  deg: '°', times: '×', euro: '€', pound: '£',
};

/** Decode HTML character references once. Unknown named entities are left as they are. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi, (match, ref: string) => {
    if (ref[0] === '#') {
      const hex = ref[1] === 'x' || ref[1] === 'X';
      const code = parseInt(ref.slice(hex ? 2 : 1), hex ? 16 : 10);
      const valid = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
      return valid ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? match;
  });
}

/** Half of an emoji (a UTF-16 surrogate pair), as left by cutting text at a fixed length. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Drop control characters (a decoded `&#27;` is a terminal escape in the
 * collector's log) and lone surrogates (PostgreSQL rejects them, failing the
 * whole upsert batch), and collapse all whitespace, newlines included, to
 * single spaces. For text that is already decoded, such as cheerio's.
 */
export function collapseText(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    .replace(LONE_SURROGATE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The first `max` UTF-16 units of `text`, without splitting a surrogate pair. */
export function cutText(text: string, max: number): string {
  const cut = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** Decode entities, then collapseText. */
export function cleanText(text: string): string {
  return collapseText(decodeEntities(text));
}

/**
 * Plain text from an HTML fragment such as an HN `story_text`: tags removed,
 * whitespace collapsed. Entities are left for normalizeItem, which decodes
 * every item's text once; decoding here too would turn a literal
 * "&amp;lt;" into "<".
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(br|\/p|p)\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Remove `utm_*` query parameters. A URL without any is returned untouched. */
export function stripTrackingParams(url: string): string {
  // Also percent-encoded, as in `utm%5Fsource` or `%55TM_source`, which URLSearchParams decodes
  if (!/[?&](?:u|%[57]5)(?:t|%[57]4)(?:m|%[46]d)(?:_|%5f)/i.test(url)) return url;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  for (const key of [...u.searchParams.keys()]) {
    if (/^utm_/i.test(key)) u.searchParams.delete(key);
  }
  return u.toString();
}

/**
 * `decoded`: the collector's text is already decoded (cheerio's is), so
 * decoding again would turn a literal "&lt;" in the page's text into "<".
 */
export function normalizeItem(item: NewsItem, { decoded = false }: { decoded?: boolean } = {}): NewsItem {
  const clean = decoded ? collapseText : cleanText;
  const summary = item.summary ? cutText(clean(item.summary), 500) : '';
  return {
    ...item,
    title: clean(item.title) || 'Untitled',
    summary: summary || undefined,
    url: stripTrackingParams(item.url.trim()),
  };
}
