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
// The sweep's real lead count. Imported rather than restated so the wave
// arithmetic below fails when the schema grows a field, instead of quietly
// describing a partition sweep that no longer exists.
import { BOARD_CARDS_FIELDS } from "../src/schemas.ts";

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
    expect(PARTITION_READ_CONCURRENCY).toBe(12);
    expect(POINT_READ_CONCURRENCY).toBe(16);
  });

  // The width the partition path's OWN measurement produced, and the shape of
  // the evidence that produced it — recorded as an assertion because the number
  // alone reads like a round guess, and the next person to "tidy" these two
  // constants back together will be looking at 12 and 16 and seeing no reason
  // they should not both be 16.
  //
  // Measured on the live 24-lead sweep (2026-08-03,
  // `scripts/probe-partition-read-concurrency-width.ts`): 6 -> 780ms (4 waves),
  // 12 -> 437ms (2 waves), 16 -> 458ms (2 waves). Sixteen is SLOWER than
  // twelve while buying no wave, which is why the partition width is not simply
  // pinned to the point-read width.
  test("the partition width is a wave boundary of the sweep it governs", () => {
    // BOARD_CARDS_FIELDS.length, READ — not the literal 24 it happens to be
    // today. A hardcoded lead count here would be the sixth instance of this
    // repo's recurring bug: the assertion would keep passing while the schema
    // grew a 25th field, i.e. precisely when the wave arithmetic below stopped
    // being true. The check has to be able to see the thing it is about.
    const waves = Math.ceil(BOARD_CARDS_FIELDS.length / PARTITION_READ_CONCURRENCY);
    expect(waves).toBe(2);
  });

  test("the partition width never degenerates to unbounded for the sweep", () => {
    // A width >= the number of leads is `Promise.all` wearing a bound's name:
    // every lead in flight at once, on the heaviest read kanban issues and the
    // one the shed threshold would show up on first. The measurement that
    // raised this constant found zero shed to 24 and a flat neighbour cost —
    // that is a reason to stop fearing the guard, not a reason to delete it.
    expect(PARTITION_READ_CONCURRENCY).toBeLessThan(BOARD_CARDS_FIELDS.length);
    expect(
      Math.ceil(BOARD_CARDS_FIELDS.length / PARTITION_READ_CONCURRENCY),
    ).toBeGreaterThan(1);
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
