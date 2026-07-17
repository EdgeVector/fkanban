import { describe, expect, test } from "bun:test";

import {
  bucketReadyCards,
  buildLaneStatus,
  emptyPickupLaneState,
  laneOf,
  orderCandidatesByLanes,
  orderProgramLanes,
  parsePickupLaneState,
  recordLaneClaim,
  upsertPickupLaneStateInBody,
  type PickupLaneState,
} from "../src/pickup_lanes.ts";
import { emptyStructuredFields, nowIso, type Card } from "../src/record.ts";

function card(partial: Partial<Card> & { slug: string; title?: string }): Card {
  const now = nowIso();
  return {
    ...emptyStructuredFields(),
    slug: partial.slug,
    title: partial.title ?? partial.slug,
    body: partial.body ?? "",
    board: partial.board ?? "default",
    column: partial.column ?? "todo",
    assignee: partial.assignee ?? "",
    tags: partial.tags ?? [],
    deps: partial.deps ?? [],
    surfaces: partial.surfaces ?? [],
    position: partial.position ?? 0,
    created_at: partial.created_at ?? now,
    updated_at: partial.updated_at ?? now,
    repo: partial.repo ?? "EdgeVector/fold",
    base: partial.base ?? "main",
    kind: partial.kind ?? "pr",
    north_star: partial.north_star ?? "",
    branch: partial.branch ?? "",
    pr_url: partial.pr_url ?? "",
    block_status: partial.block_status ?? "none",
    block_reason: partial.block_reason ?? "",
  };
}

describe("laneOf", () => {
  test("P0 → p0-now", () => {
    expect(laneOf(card({ slug: "a", tags: ["p0"] }))).toBe("p0-now");
  });

  test("north_star → program lane", () => {
    expect(
      laneOf(card({ slug: "b", tags: ["p1"], north_star: "north-star-lastgit-native-forge" })),
    ).toBe("program:north-star-lastgit-native-forge");
  });

  test("routine-error → papercut", () => {
    expect(laneOf(card({ slug: "routine-error-foo", tags: ["p1"] }))).toBe("papercut");
  });

  test("routine-error stays papercut even when tagged P0", () => {
    expect(laneOf(card({ slug: "routine-error-foo", tags: ["p0"] }))).toBe("papercut");
  });

  test("explicit lane tag wins over north_star", () => {
    expect(
      laneOf(
        card({
          slug: "x",
          tags: ["lane:papercut", "p1"],
          north_star: "north-star-lastgit-native-forge",
        }),
      ),
    ).toBe("papercut");
  });
});

describe("orderCandidatesByLanes", () => {
  test("p0-now before program before papercut", () => {
    const ready = [
      card({ slug: "papercut-1", tags: ["p1", "papercut"], created_at: "2026-07-01T00:00:00Z" }),
      card({
        slug: "prog-a",
        tags: ["p1"],
        north_star: "ns-a",
        created_at: "2026-07-01T00:00:00Z",
      }),
      card({ slug: "p0-fix", tags: ["p0"], created_at: "2026-07-02T00:00:00Z" }),
    ];
    const ordered = orderCandidatesByLanes(ready, ready, emptyPickupLaneState());
    expect(ordered.map((c) => c.slug)).toEqual(["p0-fix", "prog-a", "papercut-1"]);
  });

  test("starved program lane (0 doing) beats program with doing", () => {
    const ready = [
      card({
        slug: "ready-busy-prog",
        tags: ["p1"],
        north_star: "ns-busy",
        created_at: "2026-07-01T00:00:00Z",
      }),
      card({
        slug: "ready-starved",
        tags: ["p1"],
        north_star: "ns-starved",
        created_at: "2026-07-02T00:00:00Z",
      }),
    ];
    const doing = [
      card({
        slug: "doing-busy",
        column: "doing",
        tags: ["p1"],
        north_star: "ns-busy",
      }),
    ];
    const ordered = orderCandidatesByLanes(ready, [...ready, ...doing], emptyPickupLaneState());
    expect(ordered[0]!.slug).toBe("ready-starved");
    expect(ordered[1]!.slug).toBe("ready-busy-prog");
  });

  test("prefer-repo does not reorder ahead of p0-now", () => {
    const ready = [
      card({ slug: "p0-x", tags: ["p0"], repo: "EdgeVector/other" }),
      card({
        slug: "prog-fold",
        tags: ["p1"],
        north_star: "ns-a",
        repo: "EdgeVector/fold",
      }),
    ];
    const ordered = orderCandidatesByLanes(
      ready,
      ready,
      emptyPickupLaneState(),
      "default",
      ["EdgeVector/fold"],
    );
    expect(ordered[0]!.slug).toBe("p0-x");
  });
});

describe("pickup lane state fence", () => {
  test("round-trip parse/upsert", () => {
    let state = emptyPickupLaneState();
    state = recordLaneClaim(state, "program:ns-a", "card-a", "2026-07-17T12:00:00Z");
    const body = upsertPickupLaneStateInBody("Hello board\n", state);
    const parsed = parsePickupLaneState(body);
    expect(parsed.sequence).toBe(1);
    expect(parsed.last_claim_slug).toBe("card-a");
    expect(parsed.lane_last_claim_at["program:ns-a"]).toBe("2026-07-17T12:00:00Z");
  });
});

describe("orderProgramLanes", () => {
  test("never-claimed before recently claimed when doing equal", () => {
    const programs = new Map([
      ["program:a", [card({ slug: "a1", north_star: "a", created_at: "2026-07-02T00:00:00Z" })]],
      ["program:b", [card({ slug: "b1", north_star: "b", created_at: "2026-07-01T00:00:00Z" })]],
    ]);
    const state: PickupLaneState = {
      version: 1,
      sequence: 3,
      lane_last_claim_at: { "program:b": "2026-07-17T10:00:00Z" },
    };
    const order = orderProgramLanes(programs, new Map(), state);
    expect(order[0]).toBe("program:a");
  });
});

describe("buildLaneStatus", () => {
  test("marks starved lanes", () => {
    const ready = [
      card({ slug: "r1", tags: ["p1"], north_star: "ns-x" }),
    ];
    const rows = buildLaneStatus(ready, ready, emptyPickupLaneState());
    const prog = rows.find((r) => r.lane === "program:ns-x");
    expect(prog?.starved).toBe(true);
    expect(prog?.ready).toBe(1);
    expect(prog?.doing).toBe(0);
  });
});

describe("bucketReadyCards", () => {
  test("splits bands", () => {
    const b = bucketReadyCards([
      card({ slug: "p0", tags: ["p0"] }),
      card({ slug: "pr", tags: ["p1"], north_star: "ns" }),
      card({ slug: "routine-error-z", tags: ["p1"] }),
      card({ slug: "misc", tags: ["p2"] }),
    ]);
    expect(b.p0.map((c) => c.slug)).toEqual(["p0"]);
    expect(b.programs.get("program:ns")?.map((c) => c.slug)).toEqual(["pr"]);
    expect(b.papercut.map((c) => c.slug)).toEqual(["routine-error-z"]);
    expect(b.unlaned.map((c) => c.slug)).toEqual(["misc"]);
  });
});
