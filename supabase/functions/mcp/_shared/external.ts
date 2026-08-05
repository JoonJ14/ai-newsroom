/**
 * MCP Tool handler implementations — live lookups against external APIs.
 *
 * Unlike the handlers in `handlers.ts`, these do not read the news_items cache.
 * They resolve a single identifier (a GitHub repo, an ArXiv ID) on demand, so
 * they work for anything the user names — not just what a collector happened
 * to pick up.
 */

const USER_AGENT = 'ai-newsroom/0.1';

/** Upstream calls sit on a request-serving path, so they must not hang forever. */
const FETCH_TIMEOUT_MS = 10_000;

/** Cap on README bytes we buffer and scan — some READMEs run to megabytes. */
const MAX_README_CHARS = 200_000;

/** Same idea for the ArXiv Atom body: an unbounded response is unbounded memory. */
const MAX_XML_CHARS = 200_000;

function githubHeaders(accept: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: accept,
    'User-Agent': USER_AGENT,
  };
  const token = Deno.env.get('GITHUB_TOKEN');
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * Read at most `maxChars` from a response, then cancel the rest.
 *
 * `res.text()` would decode the entire body into memory first and only then let
 * us slice it, so the cap would bound what we scan but not peak memory — GitHub
 * serves files up to 100 MB, and this isolate has 256 MB shared across
 * concurrent requests. Reading incrementally and cancelling bounds both.
 *
 * PRECONDITION: the response must carry an abort signal. This awaits reads, so
 * a stream that neither emits nor closes would leave it pending. Every caller
 * goes through `fetchWithTimeout`, whose `AbortSignal.timeout` rejects the
 * pending read; do not call this with an unbounded stream.
 */
export async function readCapped(
  res: Response,
  maxChars: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: '', truncated: false };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = '';

  try {
    // Read until strictly PAST the cap, so overflow is self-evident from the
    // length. A separate EOF probe at exactly the cap was both ambiguous —
    // needing an extra read that could stall on a stream that neither closes
    // nor emits — and it skipped the decoder's final flush.
    while (out.length <= maxChars) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    // Always flush: a trailing incomplete UTF-8 sequence must surface as U+FFFD
    // rather than being silently dropped with the decoder.
    out += decoder.decode();
  } finally {
    // cancel() ends the body but leaves the stream locked, so releaseLock() is
    // needed too — otherwise cleanup waits on garbage collection.
    await reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      // Already released; nothing to do.
    }
  }

  if (out.length <= maxChars) return { text: out, truncated: false };

  // Never cut between the halves of a surrogate pair — a trailing lone
  // surrogate would make the returned string ill-formed UTF-16. Truncation is
  // reported as a flag rather than inferred from the returned length, which
  // this back-off would otherwise leave one short of the cap.
  let end = maxChars;
  const last = out.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return { text: out.slice(0, end), truncated: true };
}

/** Discard an unread body so the connection is not held open. */
function discardBody(res: Response): void {
  res.body?.cancel().catch(() => {});
}

/**
 * fetch() with a hard deadline. Without one, a stalled upstream holds the Edge
 * Function invocation open until the platform kills it, and the MCP client just
 * hangs with no error to show the user.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new Error(
        `Upstream request timed out after ${FETCH_TIMEOUT_MS / 1000}s: ${url}`,
      );
    }
    throw err;
  }
}

// ─── get_repo_quickstart ─────────────────────────────────────────

interface GitHubRepo {
  full_name: string;
  description: string | null;
  html_url: string;
  homepage: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  language: string | null;
  license: { spdx_id: string | null } | null;
  topics?: string[];
  pushed_at: string | null;
  created_at: string | null;
  archived: boolean;
  default_branch: string;
}

/** GitHub's own allowed character sets for account and repository names. */
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Strip a leading URL / owner prefix down to the canonical "owner/name".
 *
 * Both halves are validated against GitHub's charset before they are
 * interpolated into an API URL: without that, a value like `a/b?per_page=1`
 * would smuggle a query string onto the request, and `../..` would resolve to
 * a different API endpoint entirely and yield a garbage result instead of a
 * clean error.
 */
export function normalizeRepo(input: string): string {
  let repo = input.trim();
  repo = repo.replace(/^https?:\/\/(www\.)?github\.com\//i, '');
  repo = repo.replace(/[?#].*$/, '');
  repo = repo.replace(/\.git$/i, '');
  repo = repo.replace(/^\/+|\/+$/g, '');

  const parts = repo.split('/');
  const invalid = new Error(
    `Invalid repo "${input}". Expected "owner/name" (e.g. "anthropics/claude-code").`,
  );
  if (parts.length < 2) throw invalid;

  const [owner, name] = parts;
  if (!OWNER_RE.test(owner) || !REPO_NAME_RE.test(name)) throw invalid;

  // `.` and `..` satisfy the charset but are dot-segments: `repos/a/..`
  // resolves to `repos/`, hitting a different endpoint whose payload has no
  // full_name, which would render as "undefined" instead of erroring. GitHub
  // rejects these as repository names anyway.
  if (name === '.' || name === '..') throw invalid;

  return `${owner}/${name}`;
}

/**
 * Heading patterns that signal a quickstart, best first. Anchored at the start
 * of the heading text so a passing mention ("Data collection, usage, and
 * retention") doesn't outrank a real "Getting started". A leading emoji or
 * numbering prefix is skipped before matching.
 */
const QUICKSTART_PATTERNS: RegExp[] = [
  /^(quick\s?start|getting\s+started|get\s+started|try\s+it)\b/i,
  /^(installation|installing|install|setup|set\s+up)\b/i,
  /^(usage|basic\s+usage|how\s+to\s+use|use\s+it)\b/i,
];

/**
 * Blank out fenced code blocks, preserving every offset.
 *
 * Shell snippets in a quickstart are full of `# install the thing` comments,
 * which are indistinguishable from markdown headings to a line-anchored regex.
 * Left unmasked they both hijack heading selection and truncate the section at
 * the opening fence, so the caller receives an unterminated code block and none
 * of the actual commands. Each masked line is replaced by spaces of the same
 * length and newlines are kept, so indices found in the mask are valid in the
 * original string.
 */
export function maskCodeFences(markdown: string): string {
  const lines = markdown.split('\n');
  let open: { char: string; length: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const fence = /^[ \t]{0,3}(`{3,}|~{3,})([^\n]*)$/.exec(lines[i]);

    if (open === null) {
      if (fence) {
        open = { char: fence[1][0], length: fence[1].length };
        lines[i] = ' '.repeat(lines[i].length);
      }
    } else {
      // Per CommonMark a closing fence uses the same character, is at least as
      // long as the opening one, and carries nothing but whitespace after it —
      // so both a ``` inside a ```` block and a line like ```not-a-close are
      // content rather than terminators.
      const closes =
        fence !== null &&
        fence[1][0] === open.char &&
        fence[1].length >= open.length &&
        fence[2].trim() === '';
      lines[i] = ' '.repeat(lines[i].length);
      if (closes) open = null;
    }
  }

  return lines.join('\n');
}

/**
 * Truncate without splitting a surrogate pair.
 *
 * A cut landing between the halves of an astral character leaves a lone
 * surrogate, making the returned string ill-formed UTF-16. `readCapped` already
 * backs off; these slices did not.
 */
function truncateSafely(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let end = maxChars;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return text.slice(0, end);
}

/**
 * Close a code fence left open by truncation.
 *
 * Cutting at a fixed character count can land inside a fenced block, which would
 * hand the caller Markdown that renders as one runaway code block swallowing
 * everything after it.
 */
function closeDanglingFence(text: string): string {
  const lines = text.split('\n');
  let open: { char: string; length: number } | null = null;

  for (const line of lines) {
    const fence = /^[ \t]{0,3}(`{3,}|~{3,})([^\n]*)$/.exec(line);
    if (!fence) continue;

    if (open === null) {
      open = { char: fence[1][0], length: fence[1].length };
    } else if (
      fence[1][0] === open.char &&
      fence[1].length >= open.length &&
      fence[2].trim() === ''
    ) {
      open = null;
    }
  }

  return open ? `${text}\n${open.char.repeat(open.length)}` : text;
}

/**
 * Remove an ATX closing sequence (`## Title ##`) and surrounding whitespace.
 *
 * Done with index arithmetic rather than a regex: the equivalent pattern
 * (`[ \t]*#*[ \t]*$`) is applied to attacker-supplied heading text, and anchored
 * trailing patterns of that shape are exactly what made the previous heading
 * regex quadratic. This is O(n) with no backtracking.
 */
function stripClosingHashes(text: string): string {
  // \r counts as trailing whitespace: HEADING_RE captures to the newline, so a
  // CRLF README leaves the carriage return on every heading. Without it,
  // "## Install ##\r" keeps both the hashes and the \r.
  const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\r';
  let start = 0;
  let end = text.length;

  while (end > start && isSpace(text[end - 1])) end--;
  const beforeHashes = end;
  while (end > start && text[end - 1] === '#') end--;
  // Only a run of hashes preceded by whitespace is a closing sequence —
  // "C#" and "F#" must keep their trailing hash.
  if (end < beforeHashes && end > start && !isSpace(text[end - 1])) {
    end = beforeHashes;
  }
  while (end > start && isSpace(text[end - 1])) end--;
  while (start < end && isSpace(text[start])) start++;

  return text.slice(start, end);
}

/**
 * Pull the install/usage section out of a README.
 *
 * Scans every heading, ranks the quickstart-looking ones by pattern priority
 * (earliest in the document wins ties), and returns that section's body up to
 * the next heading at the same or higher level. Falls back to the top of the
 * README when nothing matches, which is usually still the useful part.
 *
 * Heading detection runs against a fence-masked copy so code comments cannot be
 * mistaken for headings; the returned text is always sliced from the original.
 */
export function extractQuickstart(
  markdown: string,
  maxChars = 4000,
): { section: string; heading: string | null; matched: boolean } {
  // Deliberately greedy and with nothing optional after the capture. The earlier
  // form `[ \t]+(.+?)[ \t]*#*$` backtracked quadratically: a heading followed by
  // a long run of spaces and one non-space made `(.+?)` re-expand across the
  // whole run for every position. 16k spaces cost ~2.3s — past the Edge Function
  // CPU budget, and reachable by anyone who can name a repo they control. The
  // ATX closing sequence is stripped below in linear time instead.
  // Up to three leading spaces still make a valid ATX heading in CommonMark;
  // without allowing them an indented peer heading fails to bound the section.
  const HEADING_RE = /^[ ]{0,3}(#{1,4})[ \t]+([^\n]*)$/gm;
  const masked = maskCodeFences(markdown);

  let best:
    | { level: number; heading: string; bodyStart: number; rank: number }
    | null = null;

  for (const m of masked.matchAll(HEADING_RE)) {
    if (m.index === undefined) continue;
    const headingText = stripClosingHashes(m[2]);
    if (!headingText) continue;
    // Skip leading emoji, numbering, or punctuation before ranking. Numbering is
    // stripped first, then any remaining symbol run, so both "1. Getting
    // started" and "1. 🚀 Getting started" reduce to the same comparable text.
    const comparable = headingText
      .replace(/^[\s\p{P}\p{S}]*/u, '')
      .replace(/^\d+[.)][\s\p{P}\p{S}]*/u, '');

    const rank = QUICKSTART_PATTERNS.findIndex((re) => re.test(comparable));
    if (rank === -1) continue;

    if (!best || rank < best.rank) {
      best = {
        level: m[1].length,
        heading: headingText,
        bodyStart: m.index + m[0].length,
        rank,
      };
      // Nothing can beat a top-priority match, so stop at the first one.
      if (rank === 0) break;
    }
  }

  if (!best) {
    if (markdown.length <= maxChars) {
      return { section: markdown, heading: null, matched: false };
    }
    // Same treatment as the matched path: this fallback previously truncated
    // raw, so a README whose opening code block crossed the boundary came back
    // with an unmatched fence.
    const head = truncateSafely(markdown, maxChars);
    return {
      section: closeDanglingFence(`${head}\n…(truncated)`),
      heading: null,
      matched: false,
    };
  }

  const { level, heading, bodyStart } = best;

  // Find the next heading at the same or higher level to bound the section.
  // Searched in the mask so a `#` comment inside a code block cannot end it,
  // then sliced out of the original so the content is intact.
  const nextHeading = new RegExp(`^[ ]{0,3}#{1,${level}}\\s`, 'm').exec(
    masked.slice(bodyStart),
  );
  let section = nextHeading
    ? markdown.slice(bodyStart, bodyStart + nextHeading.index)
    : markdown.slice(bodyStart);

  section = section.trim();
  if (section.length > maxChars) {
    section = closeDanglingFence(`${truncateSafely(section, maxChars)}\n…(truncated)`);
  }

  return { section, heading, matched: true };
}

export async function handleGetRepoQuickstart(
  params: Record<string, unknown>,
) {
  const rawRepo = params.repo;
  if (typeof rawRepo !== 'string' || rawRepo.trim() === '') {
    throw new Error('Missing required parameter: repo (expected a string)');
  }

  const repo = normalizeRepo(rawRepo);

  const metaRes = await fetchWithTimeout(`https://api.github.com/repos/${repo}`, {
    headers: githubHeaders('application/vnd.github+json'),
  });

  if (!metaRes.ok) {
    // Nothing below reads the body on these paths, so release it explicitly —
    // an unread body keeps the connection out of the pool.
    discardBody(metaRes);
    if (metaRes.status === 404) {
      throw new Error(`Repo not found: ${repo}`);
    }
    if (metaRes.status === 403 || metaRes.status === 429) {
      throw new Error(
        'GitHub API rate limit reached. Set GITHUB_TOKEN on the Edge Function to raise the limit.',
      );
    }
    throw new Error(`GitHub API error ${metaRes.status}: ${metaRes.statusText}`);
  }

  const meta = (await metaRes.json()) as GitHubRepo;

  // README is optional — a repo without one is still a valid answer. The whole
  // fetch is guarded, not just the non-ok status: a timeout or network error
  // here throws, and letting it escape would discard the metadata we already
  // successfully retrieved and fail the entire call.
  let readme = '';
  let readmeTruncated = false;
  let readmeError: string | null = null;
  try {
    const readmeRes = await fetchWithTimeout(
      `https://api.github.com/repos/${repo}/readme`,
      { headers: githubHeaders('application/vnd.github.raw') },
    );
    if (readmeRes.ok) {
      const capped = await readCapped(readmeRes, MAX_README_CHARS);
      readme = capped.text;
      // Kept, not discarded: a section starting near the 200k cap can be cut
      // short and still come in under the 4k section limit, so extractQuickstart
      // adds no marker of its own and the commands would look complete.
      readmeTruncated = capped.truncated;
    } else {
      discardBody(readmeRes);
      readmeError =
        readmeRes.status === 404
          ? 'This repo has no README.'
          : `Could not fetch README (HTTP ${readmeRes.status}).`;
    }
  } catch (err) {
    readmeError = `Could not fetch README: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }

  const quickstart = readme
    ? extractQuickstart(readme)
    : { section: '', heading: null, matched: false };

  // extractQuickstart only marks its own 4k section cut. If the README itself
  // was cut at MAX_README_CHARS, a section near that boundary is incomplete
  // without either marker, so say so rather than presenting partial commands as
  // the whole thing. Skipped when the section already carries the marker.
  if (
    readmeTruncated &&
    quickstart.section &&
    !quickstart.section.includes('…(truncated)')
  ) {
    quickstart.section +=
      '\n\n…(the README exceeded the size this tool reads, so these instructions may be incomplete — see the repo for the full text)';
  }

  const stars = meta.stargazers_count.toLocaleString('en-US');
  const text = [
    `${meta.full_name}${meta.archived ? ' (ARCHIVED)' : ''}`,
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    meta.description ?? '(no description)',
    '',
    `★ ${stars}  ·  ${meta.forks_count.toLocaleString('en-US')} forks  ·  ${meta.open_issues_count} open issues`,
    `Language: ${meta.language ?? 'n/a'}  ·  License: ${meta.license?.spdx_id ?? 'n/a'}`,
    `Last pushed: ${meta.pushed_at ?? 'unknown'}`,
    meta.homepage ? `Homepage: ${meta.homepage}` : null,
    `Repo: ${meta.html_url}`,
    '',
    readmeError
      ? readmeError
      : quickstart.matched
        ? `── ${quickstart.heading} ──\n${quickstart.section}`
        : `── README (opening section) ──\n${quickstart.section}`,
  ]
    .filter((line) => line !== null)
    .join('\n');

  return {
    type: 'text',
    text,
    repo: meta.full_name,
    url: meta.html_url,
    description: meta.description,
    homepage: meta.homepage,
    stars: meta.stargazers_count,
    forks: meta.forks_count,
    openIssues: meta.open_issues_count,
    language: meta.language,
    license: meta.license?.spdx_id ?? null,
    topics: meta.topics ?? [],
    archived: meta.archived,
    defaultBranch: meta.default_branch,
    createdAt: meta.created_at,
    lastPushedAt: meta.pushed_at,
    quickstart: quickstart.section || null,
    quickstartHeading: quickstart.heading,
    quickstartFound: quickstart.matched,
    /** True when the README exceeded the read cap, so the section may be partial. */
    readmeTruncated,
  };
}

// ─── get_paper_brief ─────────────────────────────────────────────

/** Accepts "2501.12345", "arXiv:2501.12345v2", or an arxiv.org URL. */
export function normalizeArxivId(input: string): string {
  let id = input.trim();
  id = id.replace(/^https?:\/\/(www\.)?arxiv\.org\/(abs|pdf)\//i, '');
  // Links copied from arXiv listing and search pages carry a query or fragment
  // (`/abs/1706.03762?context=cs`). The schema advertises that arxiv.org URLs
  // work, so these must be stripped rather than failing validation — the same
  // treatment normalizeRepo gives github.com URLs.
  id = id.replace(/[?#].*$/, '');
  id = id.replace(/\.pdf$/i, '');
  id = id.replace(/^arxiv:/i, '');
  id = id.replace(/^\/+|\/+$/g, '');

  // Modern (2501.12345v2) or legacy (cs.AI/0701001) identifiers.
  if (!/^(\d{4}\.\d{4,5}(v\d+)?|[a-z-]+(\.[A-Z]{2})?\/\d{7}(v\d+)?)$/i.test(id)) {
    throw new Error(
      `Invalid arxiv_id "${input}". Expected something like "2501.12345" or an arxiv.org URL.`,
    );
  }
  return id;
}

/**
 * `&amp;` is decoded last so an escaped entity (`&amp;lt;`) survives as literal
 * text rather than being decoded twice. Numeric forms use fromCodePoint, since
 * fromCharCode silently truncates anything above U+FFFF.
 */
export function decodeXmlEntities(str: string): string {
  const fromCode = (code: number) =>
    code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';

  const NAMED: Record<string, string> = {
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    amp: '&',
  };

  // Surrogates are deliberately NOT rejected during decoding: feeds sometimes
  // encode an astral character as its UTF-16 pair (`&#xD83D;&#xDE00;`), and
  // those halves must be allowed to sit next to each other and combine. Only
  // surrogates still unpaired afterwards are dropped, since one of those would
  // make the returned text ill-formed UTF-16.
  const LONE_SURROGATE =
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

  // One pass over the input, so nothing a replacement produces is itself
  // re-scanned. Sequential per-entity replaces got this wrong twice over:
  // `&amp;lt;` decoded to a real `<`, and `&#38;amp;` decoded to `&` because
  // the numeric pass synthesised an `&` that the later `&amp;` pass consumed.
  // Both must survive as literal text.
  return str
    .replace(
      /&(?:([a-z]+)|#(\d+)|#x([0-9a-f]+));/gi,
      (whole, name: string | undefined, dec: string | undefined, hex: string | undefined) => {
        if (name !== undefined) {
          const decoded = NAMED[name.toLowerCase()];
          // Unknown named entity: leave it exactly as it was.
          return decoded ?? whole;
        }
        if (dec !== undefined) return fromCode(Number(dec));
        return fromCode(parseInt(hex as string, 16));
      },
    )
    .replace(LONE_SURROGATE, '');
}

/**
 * Extract the body of the first `<tag …>…</tag>`, by index scan.
 *
 * The regex form (`<tag[^>]*>([\s\S]*?)</tag>`) is quadratic: on a body with
 * many opening tags and no matching closes, every candidate open rescans the
 * whole remaining suffix. Measured ~4x cost for 2x input. A response body is
 * untrusted input even when it comes from a known host, and this runs in an
 * isolate shared with every other request, so the scan is done with indexOf —
 * linear, and no backtracking to reason about.
 */
/**
 * Index of the `>` that ends a tag, skipping any inside quoted attributes.
 *
 * A plain indexOf('>') stops at the first `>` even when it sits inside an
 * attribute value, so `<summary data="a>b">real</summary>` yielded `b">real`.
 */
function findTagEnd(xml: string, from: number): number {
  let quote: string | null = null;

  for (let i = from; i < xml.length; i++) {
    const c = xml[i];
    if (quote !== null) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return i;
    }
  }

  return -1;
}

/**
 * Index of `</tag>` at nesting depth zero, ignoring CDATA and comments.
 *
 * Taking the first `</tag>` closed on an inner tag of the same name, and a
 * `</entry>` appearing inside CDATA could make a body truncated at the cap look
 * complete — returning a plausible record with fields silently missing.
 */
function findMatchingClose(xml: string, tag: string, from: number): number {
  const open = `<${tag}`;
  const close = `</${tag}`;
  let depth = 0;

  // `</summary >` is valid XML, so a closing tag is matched by name boundary
  // and then scanned to its `>` rather than compared to a fixed `</tag>`.
  const closeEndsAt = (i: number): number => {
    if (!xml.startsWith(close, i)) return -1;
    let j = i + close.length;
    while (j < xml.length && /\s/.test(xml[j])) j++;
    return xml[j] === '>' ? j : -1;
  };

  for (let i = from; i < xml.length; ) {
    if (xml.startsWith('<![CDATA[', i)) {
      const end = xml.indexOf(']]>', i + 9);
      if (end === -1) return -1;
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<!--', i)) {
      const end = xml.indexOf('-->', i + 4);
      if (end === -1) return -1;
      i = end + 3;
      continue;
    }
    const closeEnd = closeEndsAt(i);
    if (closeEnd !== -1) {
      if (depth === 0) return i;
      depth--;
      i = closeEnd + 1;
      continue;
    }
    if (xml.startsWith(open, i) && isNameBoundary(xml[i + tag.length + 1])) {
      const end = findTagEnd(xml, i + tag.length + 1);
      if (end === -1) return -1;
      if (xml[end - 1] !== '/') depth++;
      i = end + 1;
      continue;
    }
    i++;
  }

  return -1;
}

/** A tag name ends at whitespace, `>` or `/` — not at an arbitrary character. */
function isNameBoundary(c: string | undefined): boolean {
  return c === undefined || c === '>' || c === '/' || /\s/.test(c);
}

export function sliceTag(xml: string, tag: string, from = 0): { text: string; end: number } | null {
  // Iterative on purpose. Recursing past each prefix collision overflowed the
  // stack: `<summary_detail>` is 16 chars, so a 200k body admits ~12.5k
  // collisions against a ~10k frame limit — inside the cap, therefore reachable.
  let at = from;

  for (;;) {
    const openAt = xml.indexOf(`<${tag}`, at);
    if (openAt === -1) return null;

    // A prefix collision: <summary> must not match <summary_detail>.
    if (!isNameBoundary(xml[openAt + tag.length + 1])) {
      at = openAt + 1;
      continue;
    }

    const openEnd = findTagEnd(xml, openAt + tag.length + 1);
    if (openEnd === -1) return null;

    // Self-closing (<tag ... />) has no body. `/` anywhere else in the tag is
    // part of an attribute, so only a `/` immediately before `>` counts.
    if (xml[openEnd - 1] === '/') return { text: '', end: openEnd + 1 };

    const closeAt = findMatchingClose(xml, tag, openEnd + 1);
    if (closeAt === -1) return null;

    // Scan to the actual `>` — a closing tag may carry trailing whitespace, so
    // its length is not always tag.length + 3.
    const closeEnd = findTagEnd(xml, closeAt + tag.length + 2);
    return {
      text: xml.slice(openEnd + 1, closeAt),
      end: closeEnd === -1 ? xml.length : closeEnd + 1,
    };
  }
}

function tagText(xml: string, tag: string): string | null {
  const found = sliceTag(xml, tag);
  if (!found) return null;
  return decodeXmlEntities(found.text).replace(/\s+/g, ' ').trim();
}

export async function handleGetPaperBrief(params: Record<string, unknown>) {
  const rawId = params.arxiv_id;
  if (typeof rawId !== 'string' || rawId.trim() === '') {
    throw new Error('Missing required parameter: arxiv_id (expected a string)');
  }

  const arxivId = normalizeArxivId(rawId);

  const res = await fetchWithTimeout(
    `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}&max_results=1`,
    { headers: { 'User-Agent': USER_AGENT } },
  );
  if (!res.ok) {
    discardBody(res);
    throw new Error(`ArXiv API error ${res.status}: ${res.statusText}`);
  }

  // Capped like the README: an unbounded upstream body is unbounded memory.
  const capped = await readCapped(res, MAX_XML_CHARS);

  // A body cut at the cap must not be parsed as if it were whole — that would
  // return a plausible-looking record with fields silently missing. This uses
  // the reader's own flag: probing for a '</feed>' substring was both
  // context-blind (the text can appear inside CDATA or a comment) and defeated
  // by the surrogate back-off leaving the string one char under the cap.
  if (capped.truncated) {
    throw new Error(
      `ArXiv response for ${arxivId} exceeded ${MAX_XML_CHARS} characters and was truncated.`,
    );
  }

  const xml = capped.text;

  const entryFound = sliceTag(xml, 'entry');
  if (!entryFound) {
    throw new Error(`No ArXiv paper found for ID: ${arxivId}`);
  }
  const entry = entryFound.text;

  // ArXiv returns a placeholder entry with this title for unresolvable IDs.
  const title = tagText(entry, 'title');
  if (!title || title.toLowerCase() === 'error') {
    throw new Error(`No ArXiv paper found for ID: ${arxivId}`);
  }

  const abstract = tagText(entry, 'summary') ?? '';
  const published = tagText(entry, 'published');
  const updated = tagText(entry, 'updated');
  const comment = tagText(entry, 'arxiv:comment');
  const journalRef = tagText(entry, 'arxiv:journal_ref');
  const doi = tagText(entry, 'arxiv:doi');

  // Index scan rather than a lazy-quantifier regex, for the same reason as
  // sliceTag: linear cost on a body we do not control the shape of.
  const authors: string[] = [];
  for (let at = 0; ; ) {
    const found = sliceTag(entry, 'author', at);
    if (!found) break;
    const name = decodeXmlEntities(sliceTag(found.text, 'name')?.text ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    if (name) authors.push(name);
    at = found.end;
  }

  // `term="…"` is bounded by a negated class on both sides, so it stays linear.
  const categories = [...entry.matchAll(/<category\s[^>]*?term="([^"]*)"/g)].map(
    (m) => m[1],
  );
  const primaryCategory =
    /<arxiv:primary_category\s[^>]*?term="([^"]*)"/.exec(entry)?.[1] ??
    categories[0] ??
    null;

  const absUrl = `https://arxiv.org/abs/${arxivId}`;
  const pdfUrl = `https://arxiv.org/pdf/${arxivId}`;

  const authorLine =
    authors.length === 0
      ? '(authors unavailable)'
      : authors.length > 8
        ? `${authors.slice(0, 8).join(', ')}, +${authors.length - 8} more`
        : authors.join(', ');

  const text = [
    title,
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    authorLine,
    '',
    `Published: ${published ?? 'unknown'}${updated && updated !== published ? `  ·  Updated: ${updated}` : ''}`,
    `Categories: ${categories.length ? categories.join(', ') : 'n/a'}${primaryCategory ? ` (primary: ${primaryCategory})` : ''}`,
    journalRef ? `Journal ref: ${journalRef}` : null,
    doi ? `DOI: ${doi}` : null,
    comment ? `Comments: ${comment}` : null,
    '',
    '── Abstract ──',
    abstract || '(no abstract available)',
    '',
    `Abstract page: ${absUrl}`,
    `PDF: ${pdfUrl}`,
  ]
    .filter((line) => line !== null)
    .join('\n');

  return {
    type: 'text',
    text,
    arxivId,
    title,
    abstract,
    authors,
    categories,
    primaryCategory,
    publishedAt: published,
    updatedAt: updated,
    comment,
    journalRef,
    doi,
    url: absUrl,
    pdfUrl,
  };
}
