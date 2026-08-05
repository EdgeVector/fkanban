// `planRankPositions` — the pure half of `rank`, which decides how many cards
// have to be written to realize a ranked order.
//
// Every write this planner emits is one `(molecule, hash)` gate acquisition on
// a single BoardCards partition, so the property under test is not "the
// positions are pretty" but "the ORDER is realized and the write count is the
// minimum the order allows". Both halves are asserted on every case: a planner
// that writes nothing passes a write-count test, and a planner that writes
// everything passes an ordering test.
import { describe, expect, test } from "bun:test";
import {
  MAX_PADDABLE_POSITION,
  isRetainablePosition,
  planRankPositions,
} from "../src/rank_positions.ts";

/** The invariant that makes a plan CORRECT: final positions increase. */
function expectStrictlyIncreasing(positions: number[]): void {
  for (let i = 1; i < positions.length; i++) {
    expect(positions[i]).toBeGreaterThan(positions[i - 1]!);
  }
}

/** The invariant that makes it SAFE: every value pads to 8 chars. */
function expectPaddable(positions: number[]): void {
  for (const p of positions) {
    expect(Number.isInteger(p)).toBe(true);
    expect(p).toBeGreaterThanOrEqual(1);
    expect(p).toBeLessThanOrEqual(MAX_PADDABLE_POSITION);
  }
}

describe("planRankPositions", () => {
  test("an empty column plans nothing", () => {
    const plan = planRankPositions([]);
    expect(plan.positions).toEqual([]);
    expect(plan.writeIndices).toEqual([]);
  });

  test("a column already in order is not rewritten, however sparse", () => {
    // The live `default`/`todo` shape: cards left the column, survivors kept
    // their old values, and nothing sits at (i+1)*10. The order is perfect.
    const plan = planRankPositions(["230", "240", "370", "410", "570"]);
    expect(plan.writeIndices).toEqual([]);
    expect(plan.positions).toEqual([230, 240, 370, 410, 570]);
    expect(plan.compacted).toBe(false);
  });

  test("the dense renumber it replaces would have rewritten all of them", () => {
    // Same input, scored the old way: position !== (i+1)*10 for every card.
    const current = ["230", "240", "370", "410", "570"];
    const denseWrites = current.filter((p, i) => p !== String((i + 1) * 10)).length;
    expect(denseWrites).toBe(5);
    expect(planRankPositions(current).writeIndices.length).toBe(0);
  });

  test("one card out of order costs exactly one write", () => {
    // 240 must land between 230 and 370; every other card keeps its position.
    const plan = planRankPositions(["230", "370", "410", "240", "570"]);
    expect(plan.writeIndices).toEqual([3]);
    expect(plan.positions[3]).toBeGreaterThan(410);
    expect(plan.positions[3]).toBeLessThan(570);
    expectStrictlyIncreasing(plan.positions);
  });

  test("write count is n - LIS, the tight lower bound", () => {
    // LIS of [10, 90, 20, 30, 40] is [10,20,30,40] — length 4, so one write.
    const plan = planRankPositions(["10", "90", "20", "30", "40"]);
    expect(plan.writeIndices.length).toBe(1);
    expectStrictlyIncreasing(plan.positions);
  });

  test("a fresh column with no usable positions is renumbered densely", () => {
    // What `add` leaves behind: epoch millis, out of ranked order.
    const plan = planRankPositions(["1785921025189", "1785920934864", "1785921161431"]);
    expect(plan.compacted).toBe(true);
    expect(plan.positions).toEqual([10, 20, 30]);
    expect(plan.writeIndices).toEqual([0, 1, 2]);
  });

  test("an epoch position is never retained, so no minted value can straddle it", () => {
    // 1785921161431 is numerically above every 8-digit value but sorts BELOW a
    // 12-digit one in the padded key space. Retaining it would let a mover be
    // placed at a value that reads back out of order.
    expect(isRetainablePosition("1785921161431")).toBe(false);
    const plan = planRankPositions(["100", "1785921161431", "200"]);
    expectPaddable(plan.positions);
    expectStrictlyIncreasing(plan.positions);
    expect(plan.writeIndices).toContain(1);
  });

  test.each([
    ["007", "pads ambiguously — 007 and 7 share a key"],
    ["1e3", "parses to a different number than it prints"],
    ["-5", "is below the domain"],
    ["0", "is below the domain"],
    ["", "is not a number"],
    ["abc", "is not a number"],
    ["1.5", "is not an integer"],
    [String(MAX_PADDABLE_POSITION + 1), "is above the 8-digit domain"],
  ])("position %p is not retainable — it %s", (raw) => {
    expect(isRetainablePosition(raw)).toBe(false);
  });

  test("plain in-domain integers are retainable", () => {
    for (const raw of ["1", "10", "230", String(MAX_PADDABLE_POSITION)]) {
      expect(isRetainablePosition(raw)).toBe(true);
    }
  });

  test("movers with no room between anchors force a dense compaction", () => {
    // Two cards must fit strictly between 10 and 11. They cannot.
    const plan = planRankPositions(["10", "1785921025189", "1785920934864", "11"]);
    expect(plan.compacted).toBe(true);
    expect(plan.positions).toEqual([10, 20, 30, 40]);
    expectStrictlyIncreasing(plan.positions);
  });

  test("compaction restores spacing, so the next run has room again", () => {
    const first = planRankPositions(["10", "1785921025189", "1785920934864", "11"]);
    expect(first.compacted).toBe(true);
    // Re-planning the compacted column in the same order writes nothing.
    const second = planRankPositions(first.positions.map(String));
    expect(second.writeIndices).toEqual([]);
  });

  test("a head run is placed below the first anchor", () => {
    const plan = planRankPositions(["1785921025189", "100"]);
    expect(plan.compacted).toBe(false);
    expect(plan.positions[0]).toBeGreaterThanOrEqual(1);
    expect(plan.positions[0]).toBeLessThan(100);
    expect(plan.positions[1]).toBe(100);
    expectStrictlyIncreasing(plan.positions);
  });

  test("a tail run extends past the last anchor by whole steps", () => {
    const plan = planRankPositions(["100", "1785921025189", "1785920934864"]);
    expect(plan.compacted).toBe(false);
    expect(plan.positions).toEqual([100, 110, 120]);
  });

  test("a tail that would leave the paddable domain compacts instead", () => {
    const plan = planRankPositions([String(MAX_PADDABLE_POSITION), "1785921025189"]);
    expect(plan.compacted).toBe(true);
    expectPaddable(plan.positions);
    expectStrictlyIncreasing(plan.positions);
  });

  test("duplicate positions cannot both be retained", () => {
    const plan = planRankPositions(["50", "50", "60"]);
    expect(plan.writeIndices.length).toBeGreaterThanOrEqual(1);
    expectStrictlyIncreasing(plan.positions);
    expectPaddable(plan.positions);
  });

  test("every plan over pseudo-random columns is ordered, paddable, and minimal", () => {
    // Deterministic LCG — a fixed seed keeps a failure reproducible.
    let seed = 20260805;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let trial = 0; trial < 300; trial++) {
      const n = 1 + rnd(40);
      const current: string[] = [];
      for (let i = 0; i < n; i++) {
        // Mostly in-domain values, with epochs and junk mixed in.
        const roll = rnd(10);
        if (roll === 0) current.push(String(1785921025189 + rnd(1000)));
        else if (roll === 1) current.push(["", "abc", "007", "1e3"][rnd(4)]!);
        else current.push(String(1 + rnd(2000)));
      }
      const plan = planRankPositions(current);
      expectStrictlyIncreasing(plan.positions);
      expectPaddable(plan.positions);
      expect(plan.positions.length).toBe(n);
      // Every index NOT written must have kept its exact position.
      const written = new Set(plan.writeIndices);
      for (let i = 0; i < n; i++) {
        if (!written.has(i)) expect(String(plan.positions[i])).toBe(current[i]!);
      }
      // And the plan never writes more than the dense renumber it replaced.
      const denseWrites = current.filter((p, i) => p !== String((i + 1) * 10)).length;
      expect(plan.writeIndices.length).toBeLessThanOrEqual(denseWrites);
    }
  });
});
