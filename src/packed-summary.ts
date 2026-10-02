// Packed list-summary JSON and the BoardCards-compatible range key.
//
// schemas.ts must not import board-cards.ts (board-cards already imports
// schemas). The range key is the same string BoardCards writes:
// column#pos(8)#slug. Callers that already have a BoardCards sk can pass it
// through unchanged.

import { padPositionSegment } from "./position_key.ts";
import { BOARD_CARDS_FIELDS } from "./schemas.ts";

/** Version stored inside the summary JSON. Not a schema field. */
export const PACKED_SUMMARY_VERSION = 1;

export type PackedListSummary = {
  v: number;
  slug: string;
  title: string;
  column: string;
  position: string;
};

/** JSON for field `s`. Body is absent. The version is `v` inside the object. */
export function packListSummary(input: {
  slug: string;
  title: string;
  column: string;
  position: string;
}): string {
  const summary: PackedListSummary = {
    v: PACKED_SUMMARY_VERSION,
    slug: input.slug,
    title: input.title,
    column: input.column,
    position: input.position,
  };
  return JSON.stringify(summary);
}

/**
 * Eight BoardCards fields for the latency compare.
 * The wide read uses every `BOARD_CARDS_FIELDS` entry. This subset is the
 * middle read. Field `s` on the packed schema is the third read.
 */
export const LATENCY_COMPARE_SUBSET = [
  "slug",
  "title",
  "column",
  "position",
  "milestone",
  "block_status",
  "updated_at",
  "sk",
] as const;

/** Middle value. An even count uses the mean of the two middle values. */
export function medianMs(samples: readonly number[]): number {
  if (samples.length === 0) {
    throw new Error("medianMs requires at least one sample");
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid]!;
  }
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * JSON for field `s` in the latency probe.
 * The object holds the same BoardCards field values as the wide row.
 * `packListSummary` stays the four-field phase-1 helper.
 */
export function packEqualFieldMap(fields: Record<string, unknown>): string {
  const ordered: Record<string, unknown> = {};
  for (const key of BOARD_CARDS_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) {
      throw new Error(`packEqualFieldMap missing ${key}`);
    }
    ordered[key] = fields[key];
  }
  return JSON.stringify(ordered);
}

/** Same range key as BoardCards: column#pos(8)#slug. */
export function boardPackedSummarySk(
  column: string,
  position: string | number,
  slug: string,
): string {
  return `${column}#${padPositionSegment(position)}#${slug}`;
}
