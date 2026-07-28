// `mapWithConcurrency` is the shared ceiling on point-read fan-out. LastDB Mini
// sheds with "too many concurrent reads", so the bound is a correctness
// property of every caller (`groom board-cards-heal`, `migrate legacy-columns`),
// not a tuning knob — an unbounded Promise.all over N slugs gets rejected.

import { describe, expect, test } from "bun:test";

import { POINT_READ_CONCURRENCY, mapWithConcurrency } from "../src/concurrency.ts";

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
