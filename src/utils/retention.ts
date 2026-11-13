/**
 * How long news_items keeps a row. Two rules, applied by `npm run cleanup`
 * after every collect run (collect.yml):
 *
 * - Every row: 90 days after it was fetched.
 * - Rows the AI editor judged minor: importance 2 or lower
 *   (CLEANUP_LOW_IMPORTANCE_MAX), 14 days after they were fetched
 *   (CLEANUP_LOW_IMPORTANCE_DAYS). Mostly Show HN, Dev.to and papers rated
 *   1–2. Unjudged rows keep the 90 days: nobody has rated them yet.
 *
 * The shorter period stays beyond the 7 days that the editor's story-key
 * context and the digest's story history look back, so it never removes a
 * row either of them reads. That is why it can't be set below 8 days.
 *
 * No I/O here: src/utils/supabase.ts runs the deletes.
 */

export const RETENTION_DAYS = 90;

export interface LowImportanceRule {
  /** Judged rows rated at or below this importance… */
  maxImportance: number;
  /** …are deleted this many days after they were fetched. */
  days: number;
}

export const DEFAULT_LOW_IMPORTANCE_RULE: LowImportanceRule = { maxImportance: 2, days: 14 };

/** The variables and their bounds. CLEANUP_LOW_IMPORTANCE_MAX=0 switches the rule off. */
const BOUNDS = {
  maxImportance: { name: 'CLEANUP_LOW_IMPORTANCE_MAX', min: 0, max: 10 },
  days: { name: 'CLEANUP_LOW_IMPORTANCE_DAYS', min: 8, max: RETENTION_DAYS },
} as const;

type Env = Record<string, string | undefined>;

/**
 * The rule from the environment (repository variables on Actions). Unset or
 * empty means the default. A bad value is reported and the default used:
 * the defaults are the conservative choice. Null when switched off.
 */
export function lowImportanceRule(env: Env = process.env): { rule: LowImportanceRule | null; warnings: string[] } {
  const warnings: string[] = [];
  const rule = { ...DEFAULT_LOW_IMPORTANCE_RULE };
  for (const [field, { name, min, max }] of Object.entries(BOUNDS) as [keyof LowImportanceRule, (typeof BOUNDS)[keyof LowImportanceRule]][]) {
    const raw = env[name]?.trim();
    if (!raw) continue;
    const n = Number(raw);
    if (Number.isInteger(n) && n >= min && n <= max) rule[field] = n;
    else warnings.push(`${name} must be an integer from ${min} to ${max}, got "${raw}"; using ${rule[field]}`);
  }
  return { rule: rule.maxImportance === 0 ? null : rule, warnings };
}

/** The fetched_at cutoff, `days` before `now`. */
export function cutoffIso(now: Date, days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** The filter methods the rule uses, as PostgREST's query builder has them. */
export interface RetentionFilters<T> {
  not(column: string, operator: string, value: unknown): T;
  lte(column: string, value: unknown): T;
  lt(column: string, value: unknown): T;
}

/**
 * The rows the low-importance rule deletes: judged (editor_judged_at set),
 * rated at most `maxImportance`, fetched before the cutoff. Applied to a
 * query, so the database does the selecting and nothing is read first.
 */
export function whereLowImportanceExpired<T extends RetentionFilters<T>>(query: T, rule: LowImportanceRule, now: Date): T {
  return query
    .not('editor_judged_at', 'is', null)
    .lte('editor_importance', rule.maxImportance)
    .lt('fetched_at', cutoffIso(now, rule.days));
}
