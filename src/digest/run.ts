/**
 * One digest run: read the window, build the document, and (only when
 * sending) deliver it and record it in digest_state. Storage and delivery are
 * passed in, so tests can check that a preview never sends and never writes.
 */

import type { NewsItem, SourceConfig } from '../collectors/types.js';
import type { SourceDirectory } from '../editor/select.js';
import { digestWindow, previousDate, type TimeWindow } from '../editor/window.js';
import { buildDigest, type DigestPlan } from './build.js';
import type { DigestLayout, DigestSettings } from './config.js';
import type { DigestDocument } from './render.js';
import type { DigestStore } from './store.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `send`: the real digest. `dry-run`: the real window, printed, nothing sent
 * or stored. `preview`: a past 9:00 AM window from stored judgments, read-only.
 */
export type RunMode = 'send' | 'dry-run' | 'preview';

export interface RunOptions {
  mode: RunMode;
  store: DigestStore;
  /** Start of the run; the end of a send's or dry run's window. */
  now: Date;
  /** preview: the digest's date, YYYY-MM-DD. */
  date?: string;
  settings: DigestSettings;
  layout: DigestLayout;
  sources: SourceConfig[];
  dir: SourceDirectory;
  deliver?: (doc: DigestDocument, layout: DigestLayout) => Promise<void>;
  summarize?: (items: NewsItem[]) => Promise<string | undefined>;
}

export interface RunResult extends DigestPlan {
  window: TimeWindow;
  ledBefore: string[];
  sent: boolean;
}

export async function runDigest(o: RunOptions): Promise<RunResult> {
  const plan = (window: TimeWindow, ledBefore: string[]) =>
    o.store.items(window.from, window.to).then(({ items, editorColumns }) =>
      buildDigest({
        items, editorColumns, now: window.to, sources: o.sources, dir: o.dir, settings: o.settings,
        ledBefore: new Set(ledBefore), summarize: o.summarize,
      }),
    );

  if (o.mode === 'preview') {
    if (!o.date) throw new Error('a preview needs a date');
    // The anon key can't read digest_state, so the previous morning's top
    // stories are rebuilt from its own window instead
    const before = await plan(digestWindow(previousDate(o.date)), []);
    const window = digestWindow(o.date);
    const result = await plan(window, before.shown.top);
    return { ...result, window, ledBefore: before.shown.top, sent: false };
  }

  const since = (await o.store.lastDigestAt()) ?? new Date(o.now.getTime() - DAY_MS).toISOString();
  const window = { from: new Date(since), to: o.now };
  const ledBefore = (await o.store.lastShown())?.top ?? [];
  const result = await plan(window, ledBefore);

  if (o.mode !== 'send') return { ...result, window, ledBefore, sent: false };
  if (!o.deliver) throw new Error('sending needs a delivery function');
  await o.deliver(result.doc, o.layout);
  // The window's end, not the time of sending: an item fetched while this
  // run was building is in the next window, not lost between the two
  await o.store.save(window.to.toISOString(), result.shown);
  return { ...result, window, ledBefore, sent: true };
}
