import { describe, expect, test } from "bun:test";

import fixtures from "./fixtures/pickup-v2/decisions.json";
import {
  comparePickupV2Cards,
  effectiveSurfaces,
  firstEligible,
  surfacesOverlap,
  type DependencyStatuses,
  type PickupV2Card,
} from "../src/pickup_v2.ts";

describe("deterministic pickup v2 decision", () => {
  for (const fixture of fixtures) {
    test(fixture.name, () => {
      const selected = firstEligible(
        fixture.todo as PickupV2Card[],
        fixture.doing as PickupV2Card[],
        fixture.dependencyStatuses as DependencyStatuses,
      );
      expect(selected?.slug ?? null).toBe(fixture.expected);
    });
  }

  test("a terminal dependency permits the card", () => {
    const candidate: PickupV2Card = {
      slug: "candidate",
      column: "todo",
      position: "1",
      created_at: "2026-01-01T00:00:00.000Z",
      repo: "EdgeVector/fkanban",
      deps: ["dep"],
      surfaces: ["src/a.ts"],
    };
    expect(firstEligible([candidate], [], { dep: true })?.slug).toBe("candidate");
  });

  test("an absent dependency status blocks the card", () => {
    const candidate: PickupV2Card = {
      slug: "candidate",
      column: "todo",
      position: "1",
      created_at: "2026-01-01T00:00:00.000Z",
      repo: "EdgeVector/fkanban",
      deps: ["missing"],
      surfaces: ["src/a.ts"],
    };
    expect(firstEligible([candidate], [], {})).toBeUndefined();
  });

  test("missing surfaces map to the complete repository", () => {
    expect(effectiveSurfaces({ surfaces: [] })).toEqual(["**"]);
    expect(surfacesOverlap(
      { repo: "EdgeVector/fkanban", surfaces: [] },
      { repo: "EdgeVector/fkanban", surfaces: ["README.md"] },
    )).toBe(true);
  });

  test("the comparator handles positions above the safe integer limit", () => {
    const base: PickupV2Card = {
      slug: "card",
      column: "todo",
      position: "0",
      created_at: "2026-01-01T00:00:00.000Z",
      repo: "EdgeVector/fkanban",
      deps: [],
      surfaces: ["src/a.ts"],
    };
    const first = { ...base, slug: "first", position: "90071992547409920" };
    const later = { ...base, slug: "later", position: "100071992547409920" };
    expect(comparePickupV2Cards(first, later)).toBeLessThan(0);
  });

  test("creation time and slug break position ties", () => {
    const base: PickupV2Card = {
      slug: "z",
      column: "todo",
      position: "10",
      created_at: "2026-01-02T00:00:00.000Z",
      repo: "EdgeVector/fkanban",
      deps: [],
      surfaces: ["src/a.ts"],
    };
    const older = { ...base, slug: "z", created_at: "2026-01-01T00:00:00.000Z" };
    expect(comparePickupV2Cards(older, base)).toBeLessThan(0);
    expect(comparePickupV2Cards({ ...base, slug: "a" }, base)).toBeLessThan(0);
  });

  test("the selector does not mutate caller order", () => {
    const later: PickupV2Card = {
      slug: "later", column: "todo", position: "20", created_at: "", repo: "r", deps: [], surfaces: ["b"],
    };
    const first: PickupV2Card = {
      slug: "first", column: "todo", position: "10", created_at: "", repo: "r", deps: [], surfaces: ["a"],
    };
    const todo = [later, first];
    expect(firstEligible(todo, [], {})?.slug).toBe("first");
    expect(todo.map((card) => card.slug)).toEqual(["later", "first"]);
  });
});
