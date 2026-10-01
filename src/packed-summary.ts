// Packed list-summary JSON and the BoardCards-compatible range key.
//
// schemas.ts must not import board-cards.ts (board-cards already imports
// schemas). The range key is the same string BoardCards writes:
// column#pos(8)#slug. Callers that already have a BoardCards sk can pass it
// through unchanged.

import { padPositionSegment } from "./position_key.ts";

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

/** Same range key as BoardCards: column#pos(8)#slug. */
export function boardPackedSummarySk(
  column: string,
  position: string | number,
  slug: string,
): string {
  return `${column}#${padPositionSegment(position)}#${slug}`;
}
