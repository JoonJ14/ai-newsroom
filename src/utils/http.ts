/**
 * HTTP helpers shared by the collectors.
 *
 * Every response is either read to the end or cancelled, and every request has a
 * deadline. An unread response body keeps its socket open, and the process with
 * it, until the server drops the connection. That is why `npm run collect` used
 * to sit for 4–10 minutes after logging "Done" (6 of 33 runs hit the job's
 * 10-minute timeout): rss-parser's `parseURL` never reads or destroys the
 * response on a redirect or a non-2xx status, and never aborts on timeout.
 * Feeds are therefore fetched here and only parsed by rss-parser.
 */

/** Identifies the collector and how to reach its maintainer. */
export const USER_AGENT =
  'Mozilla/5.0 (compatible; ai-newsroom/0.2; +https://github.com/joonj14/ai-newsroom)';

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Largest body read, after decompression. The biggest responses the collectors
 * fetch are article pages and feeds of about 1 MB; past this, something is
 * wrong upstream, and buffering it could exhaust the runner's memory.
 */
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export interface FetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * GET a URL and return the response, throwing on a non-2xx status.
 * The error path cancels the body so the socket is released. The deadline
 * covers reading the body too, so the caller must read or cancel it.
 */
export async function fetchOk(url: string, options: FetchOptions = {}): Promise<Response> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, ...options.headers },
    redirect: 'follow',
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${res.status}${res.statusText ? `: ${res.statusText}` : ''}`);
  }
  return res;
}

/**
 * Read a response body, cancelling it and throwing once it passes `maxBytes`.
 */
export async function readBody(res: Response, maxBytes = DEFAULT_MAX_BYTES): Promise<Uint8Array> {
  const tooLarge = () => new Error(`Response larger than ${maxBytes} bytes`);
  if (Number(res.headers.get('content-length')) > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!res.body) return new Uint8Array(0);

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** GET a URL as text, decoded with the charset the server declares (UTF-8 otherwise). */
export async function fetchText(url: string, options: FetchOptions = {}): Promise<string> {
  const res = await fetchOk(url, options);
  const buf = await readBody(res, options.maxBytes);
  const charset = /charset=["']?([\w-]+)/i.exec(res.headers.get('content-type') ?? '')?.[1];
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf); // unknown charset label
  }
}

/** GET a URL as JSON. */
export async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const res = await fetchOk(url, {
    ...options,
    headers: { Accept: 'application/json', ...options.headers },
  });
  return JSON.parse(new TextDecoder().decode(await readBody(res, options.maxBytes))) as T;
}
