/**
 * The editor's output: one judgment per item, its JSON schema (sent to the API
 * as the structured-output format), and the validation every response goes
 * through before anything is stored.
 *
 * Structured outputs already constrain the shape, so validation is the second
 * line: it clamps what the schema can't express (ranges, lengths, slug shape)
 * and rejects an item it can't repair without failing the rest of its batch.
 */

// The types and audiences are shared with the MCP server, which filters by them
import { AUDIENCES, EDITOR_TYPES, type Audience, type EditorType } from '../../supabase/functions/_shared/newsroom/types.ts';
export { AUDIENCES, EDITOR_TYPES, type Audience, type EditorType };

/** As the model returns it: `ref` is the batch-local id (i1, i2, …) from the prompt. */
export interface RawJudgment {
  ref: string;
  type: EditorType;
  importance: number;
  audience: Audience;
  headline: string;
  why: string;
  story_key: string;
  followup: boolean;
}

/** After validation, keyed back to the row id. */
export interface Judgment {
  id: string;
  type: EditorType;
  importance: number;
  audience: Audience;
  headline: string;
  why: string;
  storyKey: string;
  followup: boolean;
}

/**
 * The response format. Ranges and lengths aren't expressed here: structured
 * outputs don't enforce them, so they are clamped in validateJudgments.
 */
export const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['judgments'],
  properties: {
    judgments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ref', 'type', 'importance', 'audience', 'headline', 'why', 'story_key', 'followup'],
        properties: {
          ref: { type: 'string', description: 'The item ref from the input, e.g. "i3".' },
          type: { type: 'string', enum: [...EDITOR_TYPES] },
          importance: { type: 'integer', description: '1 (noise) to 10 (industry-reshaping).' },
          audience: { type: 'string', enum: [...AUDIENCES] },
          headline: { type: 'string', description: 'Plain-language headline, at most about 90 characters.' },
          why: { type: 'string', description: 'Why it matters, at most about 25 words.' },
          story_key: { type: 'string', description: 'Lowercase hyphenated slug for the underlying story.' },
          followup: { type: 'boolean' },
        },
      },
    },
  },
} as const;

export const HEADLINE_MAX = 120;
export const WHY_MAX = 240;
export const STORY_KEY_MAX = 80;

/** Collapse whitespace, then cut at a word boundary with an ellipsis if too long. */
export function fitText(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

/** Lowercase ASCII slug: letters, digits and single hyphens. */
export function slugify(text: string): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, STORY_KEY_MAX).replace(/-+$/, '');
}

export function clampImportance(value: number): number {
  return Math.min(10, Math.max(1, Math.round(value)));
}

export interface ValidationResult {
  judgments: Judgment[];
  /** One line per rejected entry, for the log. */
  rejected: string[];
  /** Refs the response did not cover; those items stay unjudged for the next run. */
  missing: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Check a parsed response against the batch it answers. `refs` maps each
 * batch-local ref to its row id. Entries for unknown or repeated refs are
 * rejected; out-of-range numbers and over-long text are clamped; an entry with
 * a missing or wrong-typed field is rejected on its own.
 */
export function validateJudgments(parsed: unknown, refs: Map<string, string>): ValidationResult {
  const judgments: Judgment[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();

  const list = isRecord(parsed) && Array.isArray(parsed.judgments) ? parsed.judgments : null;
  if (!list) {
    return { judgments, rejected: ['response has no "judgments" array'], missing: [...refs.keys()] };
  }

  for (const entry of list) {
    if (!isRecord(entry)) {
      rejected.push(`not an object: ${JSON.stringify(entry)?.slice(0, 80)}`);
      continue;
    }
    const ref = typeof entry.ref === 'string' ? entry.ref.trim() : '';
    const id = refs.get(ref);
    if (!id) {
      rejected.push(`unknown ref ${JSON.stringify(entry.ref)}`);
      continue;
    }
    if (seen.has(ref)) {
      rejected.push(`${ref}: judged twice, first kept`);
      continue;
    }

    const problem = fieldProblem(entry);
    if (problem) {
      rejected.push(`${ref}: ${problem}`);
      continue;
    }

    const headline = fitText(entry.headline as string, HEADLINE_MAX);
    const storyKey = slugify(entry.story_key as string) || slugify(headline);
    if (!headline || !storyKey) {
      rejected.push(`${ref}: empty headline or story key`);
      continue;
    }

    seen.add(ref);
    judgments.push({
      id,
      type: entry.type as EditorType,
      importance: clampImportance(entry.importance as number),
      audience: entry.audience as Audience,
      headline,
      why: fitText(entry.why as string, WHY_MAX),
      storyKey,
      followup: entry.followup as boolean,
    });
  }

  const missing = [...refs.keys()].filter((ref) => !seen.has(ref));
  return { judgments, rejected, missing };
}

function fieldProblem(entry: Record<string, unknown>): string | null {
  if (!EDITOR_TYPES.includes(entry.type as EditorType)) return `bad type ${JSON.stringify(entry.type)}`;
  if (!AUDIENCES.includes(entry.audience as Audience)) return `bad audience ${JSON.stringify(entry.audience)}`;
  if (typeof entry.importance !== 'number' || !Number.isFinite(entry.importance)) {
    return `bad importance ${JSON.stringify(entry.importance)}`;
  }
  for (const field of ['headline', 'why', 'story_key'] as const) {
    if (typeof entry[field] !== 'string') return `bad ${field}`;
  }
  if (typeof entry.followup !== 'boolean') return 'bad followup';
  return null;
}
