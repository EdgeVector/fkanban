import { describe, expect, test } from "bun:test";

import { firstEligible, surfacesOverlap, type PickupV2Card } from "../src/pickup_v2.ts";

function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function shuffle<T>(values: readonly T[], random: () => number): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other]!, result[index]!];
  }
  return result;
}

function candidate(index: number, blockedDependency: boolean, area: number): PickupV2Card {
  return {
    slug: `card-${index}`,
    column: "todo",
    position: String(index + 1),
    created_at: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
    repo: "EdgeVector/fkanban",
    deps: blockedDependency ? [`dep-${index}`] : [],
    surfaces: [`area-${area}/file.ts`],
  };
}

function doing(area: number): PickupV2Card {
  return {
    slug: `doing-${area}`,
    column: "doing",
    position: "1",
    created_at: "2026-01-01T00:00:00.000Z",
    repo: "EdgeVector/fkanban",
    deps: [],
    surfaces: [`area-${area}/**`],
  };
}

describe("pickup v2 generated properties", () => {
  test("selects the first eligible board-position card for 500 generated cases", () => {
    for (let seed = 1; seed <= 500; seed += 1) {
      const random = generator(seed);
      const count = 1 + Math.floor(random() * 20);
      const blockedAreas = new Set<number>();
      for (let area = 0; area < 8; area += 1) {
        if (random() < 0.35) blockedAreas.add(area);
      }
      const doingCards = [...blockedAreas].map(doing);
      const statuses: Record<string, boolean> = {};
      const cards = Array.from({ length: count }, (_, index) => {
        const blockedDependency = random() < 0.3;
        if (blockedDependency) statuses[`dep-${index}`] = random() < 0.5;
        return candidate(index, blockedDependency, Math.floor(random() * 8));
      });
      const expected = cards.find((card) =>
        card.deps.every((dep) => statuses[dep] === true) &&
        !doingCards.some((peer) => surfacesOverlap(card, peer))
      );

      const input = shuffle(cards, random);
      const before = input.map((card) => card.slug);
      const selected = firstEligible(input, doingCards, statuses);

      expect(selected?.slug).toBe(expected?.slug);
      expect(input.map((card) => card.slug)).toEqual(before);
      if (selected) {
        expect(selected.deps.every((dep) => statuses[dep] === true)).toBe(true);
        expect(doingCards.some((peer) => surfacesOverlap(selected, peer))).toBe(false);
      }
    }
  });

  test("input permutations do not change the decision", () => {
    const cards = Array.from({ length: 12 }, (_, index) => candidate(index, false, index));
    for (let seed = 1; seed <= 100; seed += 1) {
      expect(firstEligible(shuffle(cards, generator(seed)), [], {})?.slug).toBe("card-0");
    }
  });

  test("returns none when every card has an open dependency or a surface conflict", () => {
    const cards = Array.from({ length: 20 }, (_, index) =>
      candidate(index, index % 2 === 0, index % 2)
    );
    const statuses = Object.fromEntries(cards.flatMap((card) => card.deps.map((dep) => [dep, false])));
    expect(firstEligible(cards, [doing(1)], statuses)).toBeUndefined();
  });
});
