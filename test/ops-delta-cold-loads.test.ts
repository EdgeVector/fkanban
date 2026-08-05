// `lastdb ops` prints a table titled "Top by cold shard loads (read cost, not
// wall time)". Its values are cumulative over the daemon's whole life, so
// dividing them by the lifetime call count produces something that LOOKS like a
// per-call cost and is not one.
//
// That number sent two consecutive chief-engineer runs after a non-problem.
// `probe-ops-delta.ts` had computed the windowed cold-load delta since it was
// written and never printed it — the one column that would have caught this was
// the column being thrown away.
//
// The fixtures below are the real shape, measured on the live primary
// 2026-08-05:
//
//   client=kanban kind=mutation schema=board_cards
//     lifetime  loads=14484 count=3734   -> 3.88 loads/call
//     36min win loads=1     count=137    -> 0.007 loads/call
//
// A 530x gap, in a bucket whose per-request samples were measured at ZERO loads
// across 76 controlled writes.
import { describe, expect, test } from "bun:test";

import { misleadingColdLoadRows, type ColdLoadRow } from "../scripts/lib/ops-delta-rows.ts";

const BOARD_CARDS = "39a0424fa085";

const row = (o: Partial<ColdLoadRow> & { count: number; loads: number }): ColdLoadRow => ({
  client: "kanban",
  kind: "mutation",
  schema: BOARD_CARDS,
  ...o,
});

describe("misleadingColdLoadRows", () => {
  test("flags the board_cards row that misled two chief-engineer runs", () => {
    const found = misleadingColdLoadRows([
      row({ count: 137, loads: 1, lifetimeCount: 3734, lifetimeLoads: 14484 }),
    ]);

    expect(found).toHaveLength(1);
    expect(found[0]!.lifetime).toBeCloseTo(3.88, 2);
    expect(found[0]!.live).toBeCloseTo(0.0073, 3);
    // The whole point of the row: the two numbers tell different stories.
    expect(found[0]!.ratio).toBeGreaterThan(100);
  });

  test("stays silent when the window agrees with the lifetime table", () => {
    // A genuinely load-heavy workload: lifetime and live both ~4 loads/call.
    expect(
      misleadingColdLoadRows([
        row({ count: 200, loads: 780, lifetimeCount: 3734, lifetimeLoads: 14484 }),
      ]),
    ).toEqual([]);
  });

  test("a quiet window cannot contradict anything", () => {
    // Same lifetime ratio, but only 3 calls observed. Three calls that happened
    // to miss cache are not evidence about the workload, in either direction —
    // reporting this row would replace one unfounded claim with another.
    expect(
      misleadingColdLoadRows([
        row({ count: 3, loads: 0, lifetimeCount: 3734, lifetimeLoads: 14484 }),
      ]),
    ).toEqual([]);
  });

  test("ignores rows that are cheap over their whole life", () => {
    // `client=kanban kind=query schema=card`, live shape: 1385 loads over 33342
    // calls is 0.04/call. It can be 40x the window rate and still not be worth
    // an operator's attention.
    expect(
      misleadingColdLoadRows([
        row({ kind: "query", count: 500, loads: 0, lifetimeCount: 33342, lifetimeLoads: 1385 }),
      ]),
    ).toEqual([]);
  });

  test("skips rows with no lifetime counters rather than treating them as zero", () => {
    // `probe-ops-delta.ts` synthesizes an "(unattributed)" row from the
    // `app_verb` rollup, which carries no cold-load counter at all. Scoring it
    // as lifetime=0 would be inventing a measurement.
    expect(
      misleadingColdLoadRows([row({ schema: "(unattributed)", count: 100, loads: 0 })]),
    ).toEqual([]);
  });

  test("ranks by lifetime rate, so the most misleading row reads first", () => {
    const found = misleadingColdLoadRows([
      row({ schema: "aaaa", count: 100, loads: 0, lifetimeCount: 1000, lifetimeLoads: 900 }),
      row({ schema: "bbbb", count: 100, loads: 0, lifetimeCount: 1000, lifetimeLoads: 5000 }),
    ]);
    expect(found.map((f) => f.row.schema)).toEqual(["bbbb", "aaaa"]);
  });
});
