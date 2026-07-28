// An off-column card — one whose `column` is not in the FIXED kanban set —
// must never be silently dropped from a board view.
//
// Before this, every board surface iterated `resolveColumns()` and filtered to
// it, so a card holding `review` (written before the fixed-column decision, Tom
// 2026-07-16) rendered nowhere and was deleted outright by `capPerColumn`, i.e.
// missing from `list` AND from the capped `list --json`. `show <slug>` still
// returned it with a real column, so the board disagreed with itself and the
// only hint was a card nobody could find. On the primary this hid 21 cards.

import { describe, expect, test } from "bun:test";

import {
  OFF_COLUMN_HEADING,
  capPerColumn,
  offColumnCards,
  renderBoard,
  renderBoardGroupedByMilestone,
  buildMilestoneCardGroups,
} from "../src/board.ts";
import { emptyStructuredFields, type Board, type Card, type Milestone } from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";

const board: Board = {
  slug: "default",
  title: "Default board",
  body: "",
  columns: [...DEFAULT_COLUMNS],
  created_at: "",
  updated_at: "",
};

function card(partial: Partial<Card>): Card {
  return {
    slug: "c",
    title: "C",
    body: "",
    board: "default",
    column: "todo",
    position: "10",
    assignee: "",
    tags: [],
    deps: [],
    ...emptyStructuredFields(),
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

const legacy = card({ slug: "stuck-in-review", title: "Stuck in review", column: "review" });
const normal = card({ slug: "ship", title: "Ship it", column: "doing" });

describe("off-column cards", () => {
  test("offColumnCards picks out exactly the cards no column iterates", () => {
    expect(offColumnCards(board, [normal, legacy]).map((c) => c.slug)).toEqual(["stuck-in-review"]);
  });

  test("renderBoard surfaces the card under an off-column section with its real column", () => {
    const out = renderBoard(board, [normal, legacy], { color: false });
    expect(out).toContain(`${OFF_COLUMN_HEADING}  (1)`);
    expect(out).toContain("Stuck in review");
    expect(out).toContain("column:review");
    // It is NOT laundered into a real column — show <slug> still says `review`.
    expect(out).toContain("DOING  (1)");
    expect(out).toContain("TODO  (0)");
  });

  test("renderBoard prints no off-column section when every card is on a column", () => {
    const out = renderBoard(board, [normal], { color: false });
    expect(out).not.toContain(OFF_COLUMN_HEADING);
  });

  test("a --column view stays a view of that one real column", () => {
    const out = renderBoard(board, [normal, legacy], { color: false, column: "doing" });
    expect(out).not.toContain(OFF_COLUMN_HEADING);
    expect(out).not.toContain("Stuck in review");
  });

  test("capPerColumn pages the off-column card instead of deleting it", () => {
    expect(capPerColumn(board, [normal, legacy], 10).map((c) => c.slug))
      .toEqual(["ship", "stuck-in-review"]);
  });

  test("capPerColumn honours the cap for off-column cards too", () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      card({ slug: `legacy-${i}`, title: `Legacy ${i}`, column: "review", position: String(i) }),
    );
    const out = capPerColumn(board, many, 2);
    expect(out).toHaveLength(2);
  });

  test("capPerColumn leaves a --column view free of off-column cards", () => {
    expect(capPerColumn(board, [normal, legacy], 10, "doing").map((c) => c.slug)).toEqual(["ship"]);
  });

  test("uncapped capPerColumn is unchanged", () => {
    expect(capPerColumn(board, [normal, legacy], 0)).toHaveLength(2);
  });

  test("the milestone-grouped view surfaces it too", () => {
    const milestone: Milestone = {
      slug: "m1",
      title: "Milestone one",
      body: "",
      board: "default",
      state: "active",
      position: "1",
      created_at: "",
      updated_at: "",
    } as Milestone;
    const cards = [
      card({ ...normal, milestone: "m1" }),
      card({ ...legacy, milestone: "m1" }),
    ];
    const out = renderBoardGroupedByMilestone(
      board,
      buildMilestoneCardGroups(cards, [milestone]),
      { color: false },
    );
    expect(out).toContain(OFF_COLUMN_HEADING);
    expect(out).toContain("Stuck in review");
  });
});
