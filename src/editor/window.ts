/**
 * Digest windows in New York time. The digest goes out at 9:00 AM ET
 * (docs/scheduling.md), and America/New_York is UTC-4 or UTC-5 depending on
 * the date, so the UTC instants are computed rather than assumed.
 */

const NY = 'America/New_York';

/** Minutes NY is ahead of UTC at an instant (-240 in summer, -300 in winter). */
function nyOffsetMinutes(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: NY, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((wall - at.getTime()) / 60000);
}

function parseDate(date: string): [number, number, number] {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`expected a date as YYYY-MM-DD, got "${date}"`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** The instant it is `hour`:00 on `date` (YYYY-MM-DD) in New York. */
export function nyWallTime(date: string, hour: number): Date {
  const [y, m, d] = parseDate(date);
  const guess = Date.UTC(y, m - 1, d, hour);
  let t = guess - nyOffsetMinutes(new Date(guess)) * 60000;
  // Near a DST change the offset at the guess and at the answer can differ
  const offset = nyOffsetMinutes(new Date(t));
  t = guess - offset * 60000;
  return new Date(t);
}

/** The day before `date`, as YYYY-MM-DD. */
export function previousDate(date: string): string {
  const [y, m, d] = parseDate(date);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

export interface TimeWindow {
  from: Date;
  to: Date;
}

/**
 * The window the 9:00 AM digest on `date` covers: since the previous day's
 * digest. The real digest starts from `digest_state.last_digest_at`, which a
 * late or skipped run moves; this uses the nominal times.
 */
export function digestWindow(date: string, hour = 9): TimeWindow {
  return { from: nyWallTime(previousDate(date), hour), to: nyWallTime(date, hour) };
}

/** "--window 2026-10-07T13:00Z,2026-10-08T13:00Z" */
export function parseWindow(arg: string): TimeWindow {
  const [a, b] = arg.split(',');
  const from = new Date(a ?? '');
  const to = new Date(b ?? '');
  if (isNaN(from.getTime()) || isNaN(to.getTime()) || from >= to) {
    throw new Error(`--window expects START,END as ISO 8601 times with START before END, got "${arg}"`);
  }
  return { from, to };
}

export function formatNy(at: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: NY, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(at);
}
