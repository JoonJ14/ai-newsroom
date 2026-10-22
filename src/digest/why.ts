/**
 * A guard on why-lines that describe the coverage instead of the news. The
 * rubric forbids them, but the editor still writes some: "matches the
 * existing OpenAI test-hacking coverage", "this is a video explainer on a
 * speech already covered". A reader sees only the headline and this line.
 *
 * The patterns come from the stored editor_why values of Oct 12–21, 2026
 * (docs/digest.md lists the matches). When the lead's line trips one, the
 * digest uses another item's line from the same story, or none.
 */

import type { Story } from '../editor/select.js';

export const META_WHY_PATTERNS: readonly RegExp[] = [
  /\bcoverage\b/i,                                            // "matches the existing … coverage", "wire coverage of"
  /\b(already|widely|elsewhere|only)\b[^.;]{0,20}\bcovered\b|\bcovered\b[^.;]{0,15}\b(elsewhere|already|by|from)\b/i,
  /\balready (been )?(widely )?(reported|tracked)\b/i,        // "already widely reported"
  /\bexisting\b[^.;]{0,50}\b(story|stories|entry|item|report|study)\b/i,
  /^same\b|\bsame\b[^.;]{0,40}\bas (the|an?|this)\b/i,        // "Same incident as the existing …"
  /\bsame (story|event|news)\b/i,
  /\bmatches the\b/i,
  /\bfollow-(up|on) (to|of|coverage)\b|\bfollow-on\b/i,       // "Follow-up to Character.AI's bankruptcy"
  /\b(continues|follows) the earlier\b|\bthe earlier\b[^.;]{0,30}\b(story|item|report|entry)\b/i,
  /\bexplainer\b/i,                                           // "a video explainer on a speech"
  /\breported by\b/i,
  /\bduplicate\b/i,
  /\bknown (story|stories|item)\b/i,
  /\b(another|other) (outlet|angle)\b|\bfrom another\b/i,     // "covered from another angle"
  /\brecap\b/i,
  /\bthis (item|article|piece|post|entry)\b/i,
  /\b(story key|the batch)\b/i,
];

export function isMetaWhy(why: string): boolean {
  return META_WHY_PATTERNS.some((p) => p.test(why));
}

export interface WhyChoice {
  /** The line to show; undefined to show none. */
  why?: string;
  /** The lines that tripped the guard, lead's first. */
  rejected: string[];
}

/** The lead's why-line if it is about the news; else the first other item's that is; else none. */
export function chooseWhy(story: Story): WhyChoice {
  const rejected: string[] = [];
  for (const item of story.items) {
    const why = item.judgment.why.trim();
    if (!why) continue;
    if (!isMetaWhy(why)) return { why, rejected };
    if (!rejected.includes(why)) rejected.push(why);
  }
  return { rejected };
}
