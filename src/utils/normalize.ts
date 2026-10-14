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

/** Decode entities and collapse all whitespace, newlines included, to single spaces. */
export function cleanText(text: string): string {
  return decodeEntities(text).replace(/\s+/g, ' ').trim();
}

/** Plain text from an HTML fragment such as an HN `story_text`. */
export function htmlToText(html: string): string {
  return cleanText(html.replace(/<(br|\/p|p)\b[^>]*>/gi, ' ').replace(/<[^>]*>/g, ''));
}

/** Remove `utm_*` query parameters. A URL without any is returned untouched. */
export function stripTrackingParams(url: string): string {
  if (!/[?&]utm_/i.test(url)) return url;
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

export function normalizeItem(item: NewsItem): NewsItem {
  const summary = item.summary ? cleanText(item.summary).slice(0, 500) : '';
  return {
    ...item,
    title: cleanText(item.title) || 'Untitled',
    summary: summary || undefined,
    url: stripTrackingParams(item.url.trim()),
  };
}
