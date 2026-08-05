// Turning a ranked ORDER into `position` values, writing as few cards as the
// order actually requires.
//
// `rank` used to assign `position = (i + 1) * RANK_POSITION_STEP` across the
// whole column, so the positions were not merely ordered — they were canonical.
// That makes every run rewrite every card whose index shifted, and it makes a
// column that is already in perfect order rewrite itself from end to end as
// soon as its positions are sparse (cards leave `todo`, the survivors keep
// their old values, and nothing is at `(i+1)*10` any more).
//
// Measured on the live `default` board, 2026-08-05
// (`scripts/probe-rank-write-volume.ts`), the `todo` column pickup reads:
//
//   cards ranked                55
//   dense renumber writes       54
//   order-required writes        1
//
// Every one of those 54 is a separate `(molecule, hash)` gate acquisition on
// one BoardCards partition, and gate wait is 88.5% of board write time
// (papercut-kanban-board-cards-partition-gate-is-the-board-write-bottleneck).
// 53 of the 54 bought nothing: the cards were already in the right order
// relative to one another and only their absolute values were "wrong".
//
// So: positions are an ORDERING, not an address. Keep every position that
// already sits in increasing order along the ranked sequence, and place only
// the cards that genuinely have to move into the gaps between them.
//
// ## Why the retained set is a longest increasing subsequence
//
// A card keeps its position iff its position is greater than every retained
// card before it and less than every retained card after it — i.e. the retained
// cards' positions increase along the target order. The largest such set is
// exactly the longest strictly-increasing subsequence, so `n - LIS` is the
// minimum number of cards any correct scheme can leave to write. Nothing here
// is heuristic; the bound is tight.
//
// ## The 8-digit domain, and why a position outside it is never retained
//
// `boardCardSk` addresses a row as `column#position.padStart(8,"0")#slug` and
// the partition is read in KEY order, so ordering is lexicographic over the
// padded segment. That agrees with numeric order only while every position pads
// to the same width. A card appended by `add`/`move` carries epoch millis (13
// digits, unpadded), which sorts after every 8-digit value because those all
// begin with `0` — fine by luck, and only while nothing lands in between.
//
// Spreading a mover into the gap below a 13-digit anchor would mint exactly the
// value that breaks it: `892960580715` is numerically below
// `1785921161431` and lexicographically above it, so the row would read back
// out of order. Rather than reason about mixed widths, this planner works in
// one domain: a position is retainable only if it is an integer in
// [1, 99999999] whose own string form round-trips (`"007"` and `"1e3"` do not —
// see `unpadBoardCardPosition`), and every value it mints is in that range too.
// An epoch-positioned card is therefore always a mover, which is what the old
// dense renumber did with it anyway.
//
// ## Falling back
//
// When a run of movers cannot fit between its anchors, the planner renumbers
// the whole column densely — the previous behaviour, which also restores full
// spacing so the next run has room again. Callers can see this happened via
// `compacted`.

import { RANK_POSITION_STEP } from "./record.ts";

/** Largest position that pads to 8 characters, and so orders lexicographically. */
export const MAX_PADDABLE_POSITION = 99_999_999;

export interface RankPositionPlan {
  /** Final position per card, in the ranked order handed in. */
  positions: number[];
  /** Indices into that order whose card must be written. */
  writeIndices: number[];
  /** True when no position could be retained and the column was renumbered. */
  compacted: boolean;
}

/**
 * Is this position one we may keep, and mint alongside?
 *
 * Round-trips through `String` so that values `padStart(8, "0")` cannot
 * represent distinctly (`"007"`) or that parse to a different number
 * (`"1e3"` → 1000) are treated as movers rather than silently relocated.
 */
export function isRetainablePosition(raw: string): boolean {
  const n = Number(raw);
  if (!Number.isInteger(n)) return false;
  if (n < 1 || n > MAX_PADDABLE_POSITION) return false;
  return String(n) === raw.trim();
}

/**
 * Indices of a longest strictly-increasing subsequence of `values`, considering
 * only indices flagged `eligible`. Patience sorting, O(n log n).
 */
function longestIncreasingIndices(values: number[], eligible: boolean[]): number[] {
  // tailIdx[k] = index of the smallest tail among increasing subsequences of length k+1
  const tailIdx: number[] = [];
  const prev = new Array<number>(values.length).fill(-1);
  for (let i = 0; i < values.length; i++) {
    if (!eligible[i]) continue;
    const x = values[i]!;
    let lo = 0;
    let hi = tailIdx.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[tailIdx[mid]!]! < x) lo = mid + 1;
      else hi = mid;
    }
    prev[i] = lo > 0 ? tailIdx[lo - 1]! : -1;
    tailIdx[lo] = i;
  }
  const out: number[] = [];
  let cur = tailIdx.length > 0 ? tailIdx[tailIdx.length - 1]! : -1;
  while (cur >= 0) {
    out.push(cur);
    cur = prev[cur]!;
  }
  return out.reverse();
}

/** Renumber every card densely — the pre-2026-08-05 behaviour. */
function densePlan(current: string[], step: number): RankPositionPlan {
  const positions = current.map((_, i) => (i + 1) * step);
  const writeIndices: number[] = [];
  for (let i = 0; i < current.length; i++) {
    if (current[i] !== String(positions[i])) writeIndices.push(i);
  }
  return { positions, writeIndices, compacted: true };
}

/**
 * Plan the `position` writes that realize `current`'s order as handed in.
 *
 * `current[i]` is the position card `i` holds NOW; the array is already in the
 * ranked target order. Returns the final position of every card and the subset
 * that has to be written.
 */
export function planRankPositions(
  current: string[],
  step: number = RANK_POSITION_STEP,
): RankPositionPlan {
  const n = current.length;
  if (n === 0) return { positions: [], writeIndices: [], compacted: false };

  const values = current.map((raw) => Number(raw));
  const eligible = current.map(isRetainablePosition);
  const keep = longestIncreasingIndices(values, eligible);
  if (keep.length === 0) return densePlan(current, step);

  const kept = new Set(keep);
  const positions = new Array<number>(n).fill(0);
  for (const i of keep) positions[i] = values[i]!;

  // Fill each maximal run of movers between the anchors that bracket it.
  let i = 0;
  while (i < n) {
    if (kept.has(i)) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && !kept.has(j)) j++;
    const count = j - i;
    const lo = i > 0 ? positions[i - 1]! : 0;
    const hasUpper = j < n;

    if (!hasUpper) {
      // Tail: extend past the last anchor by whole steps.
      const last = lo + step * count;
      if (last > MAX_PADDABLE_POSITION) return densePlan(current, step);
      for (let k = 0; k < count; k++) positions[i + k] = lo + step * (k + 1);
    } else {
      const hi = positions[j]!;
      // `gap >= 1` exactly when there are at least `count` integers in (lo, hi),
      // and `lo + gap * count < hi` follows, so the run stays strictly inside.
      const gap = Math.floor((hi - lo) / (count + 1));
      if (gap < 1) return densePlan(current, step);
      for (let k = 0; k < count; k++) positions[i + k] = lo + gap * (k + 1);
    }
    i = j;
  }

  const writeIndices: number[] = [];
  for (let k = 0; k < n; k++) {
    if (current[k] !== String(positions[k])) writeIndices.push(k);
  }
  return { positions, writeIndices, compacted: false };
}
