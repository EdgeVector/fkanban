

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
