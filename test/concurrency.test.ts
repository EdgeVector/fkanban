// `mapWithConcurrency` is the shared ceiling on point-read fan-out. LastDB Mini
// sheds with "too many concurrent reads", so the bound is a correctness
// property of every caller (`groom board-cards-heal`, `migrate legacy-columns`),
// not a tuning knob — an unbounded Promise.all over N slugs gets rejected.

import { describe, expect, test } from "bun:test";

import {
  PARTITION_READ_CONCURRENCY,
  POINT_READ_CONCURRENCY,
  mapWithConcurrency,
} from "../src/concurrency.ts";

describe("mapWithConcurrency", () => {
  test("preserves input order regardless of completion order", async () => {
    const out = await mapWithConcurrency([5, 1, 4, 2, 3], async (n) => {
      // Later items finish first, so a naive push-on-settle would reorder.
      await new Promise((r) => setTimeout(r, n));
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30]);
  });

  test("never exceeds the requested width", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
      },
      3,
    );
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  test("defaults to the modest shared point-read width", async () => {
    let peak = 0;
    let inFlight = 0;
    await mapWithConcurrency(Array.from({ length: 50 }, (_, i) => i), async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
    });
    expect(peak).toBeLessThanOrEqual(POINT_READ_CONCURRENCY);
  });

  test("an empty input does no work and returns an empty array", async () => {
    let calls = 0;
    const out = await mapWithConcurrency([], async () => {
      calls += 1;
    });
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });

  test("width never exceeds the item count", async () => {
    let peak = 0;
    let inFlight = 0;
    await mapWithConcurrency([1, 2], async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
    }, 16);
    expect(peak).toBeLessThanOrEqual(2);
  });

  test("passes the index through to the callback", async () => {
    expect(await mapWithConcurrency(["a", "b", "c"], async (item, i) => `${i}:${item}`))
      .toEqual(["0:a", "1:b", "2:c"]);
  });
});

// The two fan-out widths are separate constants because they bound two
// different COST CLASSES against the same shared node. Point reads measured
// zero shed at 96 concurrent (`scripts/probe-point-read-shed-threshold.ts`);
// partition reads — hundreds of rows, and the node's #1 consumer of wall time —
// have never been measured past 2-wide.
//
// These tests exist because the hazard is silent. `listAllBoardCards` and
// `sweepBoardCardsPartition` both used to pass POINT_READ_CONCURRENCY, so
// tuning the cheap class on point-read evidence silently widened the expensive
// one. Nothing failed when that was true — which is exactly why it needs a
// check that CAN fail.
describe("read-pool widths are separated by cost class", () => {
  test("the partition width does not track the point-read width", () => {
    // Not `toBeLessThan`: the point is that they are INDEPENDENT, so this must
    // fail if someone re-couples them by aliasing one to the other, even
    // though an alias would still satisfy every inequality below today.
    expect(PARTITION_READ_CONCURRENCY).toBe(6);
    expect(POINT_READ_CONCURRENCY).toBe(16);
  });

  test("the partition width stays at or below the point-read width", () => {
    // Direction matters: a partition read is strictly heavier per request, so
    // it must never be the wider fan-out.
    expect(PARTITION_READ_CONCURRENCY).toBeLessThanOrEqual(POINT_READ_CONCURRENCY);
  });

  test("both widths stay bounded — neither is 'unbounded'", () => {
    // The bound's job is politeness to a node shared with lastgit and brain.
    // The shed threshold being further away than folklore claimed is not a
    // reason to remove the bound.
    for (const width of [POINT_READ_CONCURRENCY, PARTITION_READ_CONCURRENCY]) {
      expect(width).toBeGreaterThan(0);
      expect(width).toBeLessThanOrEqual(32);
      expect(Number.isFinite(width)).toBe(true);
    }
  });

  // The call sites that must bind the partition width are pinned against the
  // REAL functions in `test/read-fanout-concurrency.test.ts`. Asserting it here
  // by calling `mapWithConcurrency(items, fn, PARTITION_READ_CONCURRENCY)`
  // directly would be a check that cannot fail: it would pass a call site that
  // had reverted to the default, because it never calls the call site.
});
