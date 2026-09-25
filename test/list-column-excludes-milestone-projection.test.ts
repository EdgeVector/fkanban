/**
 * Column-scoped reads exclude `milestone` from projection to prevent rows
 * without `milestone` atoms from being silently dropped by the hash field gate.
 *
 * The BoardCards schema has `milestone` as its hash field, which gates from any
 * position in the projection. When reading a specific column with HashRangePrefix,
 * including `milestone` in the projection drops every row with no `milestone`
 * atom, causing a divergence between `list --column todo` (empty) and
 * `list --all` (shows todo cards).
 *
 * Measured on the live board 2026-09-25:
 * - `kanban list --column todo` with milestone: 0 rows (wrong)
 * - `kanban list --column todo` without milestone: 3 rows (correct)
 *
 * See: papercut-kanban-list-column-todo-empty-while-all-shows-todo-cards-20260924
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { boardCardFieldsFromCard, boardCardSk, listBoardCardsPartition } from "../src/board-cards.ts";
import { listCardsByColumn, boardToFields, cardToFields, emptyStructuredFields, type Board, type Card } from "../src/record.ts";
import type { Config } from "../src/config.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";
import { fakeNode } from "./fake-node.ts";

const CARD = "card-hash";
const BOARD = "board-hash";
const BC = "board-cards-hash";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://127.0.0.1:9",
  userHash: "user",
  schemaServiceUrl: "http://127.0.0.1:9",
  schemaHashes: {
    board: BOARD,
    card: CARD,
    board_cards: BC,
  },
};

function board(): Board {
  return {
    slug: "default",
    title: "Default",
    body: "",
    columns: [...DEFAULT_COLUMNS],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function card(partial: Partial<Card> = {}): Card {
  return {
    slug: "test-card",
    title: "Test",
    body: "",
    board: "default",
    column: "todo",
    position: "1",
    assignee: "worker",
    tags: [],
    deps: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    ...emptyStructuredFields(),
    surfaces: [],
    done_at: "",
    kind: "pr",
    repo: "EdgeVector/fkanban",
    ...partial,
  };
}

describe("column-scoped reads exclude milestone from projection", () => {
  beforeEach(() => {});

  test("list --column todo returns cards without milestone atoms", async () => {
    const node = fakeNode();
    const brd = board();
    node.seed({
      schemaHash: BOARD,
      keyHash: brd.slug,
      fields: boardToFields(brd),
    });

    // Create a card in todo WITHOUT a milestone atom (empty string)
    const cardWithoutMilestone = card({
      slug: "no-milestone",
      column: "todo",
      position: "1",
      milestone: "", // Empty milestone = no atom in BoardCards
    });
    node.seed({
      schemaHash: CARD,
      keyHash: cardWithoutMilestone.slug,
      fields: cardToFields(cardWithoutMilestone),
    });
    const fields = boardCardFieldsFromCard(cardWithoutMilestone);
    node.seed({
      schemaHash: BC,
      keyHash: cardWithoutMilestone.board,
      rangeKey: boardCardSk(cardWithoutMilestone.column, cardWithoutMilestone.position, cardWithoutMilestone.slug),
      fields,
    });

    // Read the todo column specifically
    const todoCards = await listCardsByColumn(node, cfg, "todo", ["slug", "column"], "default");

    // The card should be visible even though it has no milestone atom
    expect(todoCards.map((c) => c.slug)).toContain("no-milestone");
    expect(todoCards).toHaveLength(1);
  });

  test("list --column todo sees the same cards as list --all filtered to todo", async () => {
    const node = fakeNode();
    const brd = board();
    node.seed({
      schemaHash: BOARD,
      keyHash: brd.slug,
      fields: boardToFields(brd),
    });

    // Create multiple cards in todo without milestones
    const cards = [
      card({ slug: "card-1", column: "todo", position: "1", milestone: "" }),
      card({ slug: "card-2", column: "todo", position: "2", milestone: "" }),
      card({ slug: "card-3", column: "doing", position: "1", milestone: "" }),
    ];

    for (const c of cards) {
      node.seed({
        schemaHash: CARD,
        keyHash: c.slug,
        fields: cardToFields(c),
      });
      const fields = boardCardFieldsFromCard(c);
      node.seed({
        schemaHash: BC,
        keyHash: c.board,
        rangeKey: boardCardSk(c.column, c.position, c.slug),
        fields,
      });
    }

    // Read the todo column specifically
    const todoCards = await listCardsByColumn(node, cfg, "todo", ["slug", "column"], "default");

    // Should see exactly the 2 todo cards
    const todoSlugs = todoCards.map((c) => c.slug).sort();
    expect(todoSlugs).toEqual(["card-1", "card-2"]);
  });

  test("listBoardCardsPartition with column filter returns cards without milestone", async () => {
    const node = fakeNode();

    // Create a card in todo without milestone
    const cardNoMilestone = card({
      slug: "no-milestone",
      column: "todo",
      position: "1",
      milestone: "",
    });
    const fields = boardCardFieldsFromCard(cardNoMilestone);
    node.seed({
      schemaHash: BC,
      keyHash: cardNoMilestone.board,
      rangeKey: boardCardSk(cardNoMilestone.column, cardNoMilestone.position, cardNoMilestone.slug),
      fields,
    });

    // Read with column filter
    const result = await listBoardCardsPartition(node, cfg, "default", {
      column: "todo",
    });

    expect(result).not.toBeNull();
    expect(result!.map((c) => c.slug)).toContain("no-milestone");
  });

  test("pickup partition (todo column) includes cards with and without milestone atoms", async () => {
    const node = fakeNode();
    const brd = board();
    node.seed({
      schemaHash: BOARD,
      keyHash: brd.slug,
      fields: boardToFields(brd),
    });

    // Create cards with mixed milestone states in the todo column
    const cards = [
      card({ slug: "with-milestone", column: "todo", position: "1", milestone: "v1.0" }),
      card({ slug: "no-milestone-1", column: "todo", position: "2", milestone: "" }),
      card({ slug: "no-milestone-2", column: "todo", position: "3", milestone: "" }),
      card({ slug: "doing-card", column: "doing", position: "1", milestone: "" }),
    ];

    for (const c of cards) {
      node.seed({
        schemaHash: CARD,
        keyHash: c.slug,
        fields: cardToFields(c),
      });
      const fields = boardCardFieldsFromCard(c);
      node.seed({
        schemaHash: BC,
        keyHash: c.board,
        rangeKey: boardCardSk(c.column, c.position, c.slug),
        fields,
      });
    }

    // Read the pickup partition: todo column of default board
    // This is the exact read path used by `kanban pickup ready`
    const pickupCards = await listCardsByColumn(
      node,
      cfg,
      "todo",
      ["slug", "column", "milestone"],
      "default",
    );

    // Should see all 3 todo cards, including those without milestone atoms
    const pickupSlugs = pickupCards.map((c) => c.slug).sort();
    expect(pickupSlugs).toEqual(["no-milestone-1", "no-milestone-2", "with-milestone"]);

    // Verify each card is in the todo column
    expect(pickupCards.every((c) => c.column === "todo")).toBe(true);

    // Should NOT include the doing column card
    expect(pickupSlugs).not.toContain("doing-card");
  });
});
