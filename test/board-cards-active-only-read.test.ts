/**
 * `pickup status` classifies `activeCards` and nothing else, so every row it
 * reads out of a board's terminal column is read to be discarded — 141 of 170
 * on the live board, and that ratio only worsens because the archive is
 * append-only.
 *
 * The read that fixes it is the COMPLEMENT of one column expressed as two
 * `HashRangeRange` filters. These tests pin the two things that make that
 * substitution safe rather than merely faster:
 *
 *   1. the bounds actually bracket the terminal column — no `done` row leaks
 *      in, and no active row is cut out by an off-by-one on the `#`/`$`
 *      boundary;
 *   2. the excluded column is each BOARD's own terminal column, and a board
 *      whose column list is unknown reads WHOLE.
 *
 * (2) is the one that turns a perf change into a data-loss bug: hardcoding
 * "done" would silently drop a custom board's real work and hide its finished
 * cards in the same move.
 */
import { describe, expect, test } from "bun:test";

import {
  boardCardFieldsFromCard,
  boardCardSk,
  listAllBoardCards,
  listBoardCardsPartition,
} from "../src/board-cards.ts";
import type { Config } from "../src/config.ts";
import { emptyStructuredFields, type Card } from "../src/record.ts";
import { fakeNode, type FakeNode } from "./fake-node.ts";

const BC = "board-cards-hash";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://127.0.0.1:9",
  userHash: "user",
  schemaServiceUrl: "http://127.0.0.1:9",
  schemaHashes: {
    board: "board-hash",
    card: "card-hash",
    card_list_index: "card-list-index-hash",
    board_cards: BC,
  },
};

function card(partial: Partial<Card> = {}): Card {
  return {
    slug: "c",
    title: "C",
    body: "",
    board: "default",
    column: "todo",
    position: "1",
    assignee: "",
    tags: [],
    deps: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    ...emptyStructuredFields(),
    surfaces: [],
    done_at: "",
    kind: "",
    repo: "",
    ...partial,
  } as Card;
}

function seed(node: FakeNode, c: Card): void {
  node.seed({
    schemaHash: BC,
    keyHash: c.board || "default",
    rangeKey: boardCardSk(c.column, c.position, c.slug),
    fields: boardCardFieldsFromCard(c),
  });
}

/** A board with one card in each of the four standard columns. */
function seedFourColumns(node: FakeNode, board = "default"): void {
  seed(node, card({ slug: "in-backlog", board, column: "backlog", position: "1" }));
  seed(node, card({ slug: "in-todo", board, column: "todo", position: "1" }));
  seed(node, card({ slug: "in-doing", board, column: "doing", position: "1" }));
  seed(node, card({ slug: "in-done", board, column: "done", position: "1" }));
}

const slugs = (cards: Card[] | null) => (cards ?? []).map((c) => c.slug).sort();

describe("BoardCards active-only read", () => {
  test("excludeColumn returns every column except the excluded one", async () => {
    const node = fakeNode();
    seedFourColumns(node);

    const rows = await listBoardCardsPartition(node, cfg, "default", { excludeColumn: "done" });

    // `done` sorts BETWEEN `doing` and `todo`, which is the whole reason this
    // takes two ranges rather than one: a single "everything below done" bound
    // would silently drop `todo`, and nothing about the count would look wrong.
    expect(slugs(rows)).toEqual(["in-backlog", "in-doing", "in-todo"]);
  });

  test("the excluded column is bracketed by two ranges, not filtered client-side", async () => {
    const node = fakeNode();
    seedFourColumns(node);

    await listBoardCardsPartition(node, cfg, "default", { excludeColumn: "done" });

    const filters = node.reads
      .filter((r) => r.schemaHash === BC)
      .map((r) => r.filter as unknown as { HashRangeRange?: { hash: string; start: string; end: string } });
    // Two reads, both key-restricted ranges. If this ever becomes one HashKey
    // read plus a `.filter()`, the rows come back over the wire again and the
    // change has been undone while the test above still passes.
    expect(filters).toHaveLength(2);
    expect(filters.map((f) => f.HashRangeRange?.hash)).toEqual(["default", "default"]);
    expect(filters[0]!.HashRangeRange).toEqual({ hash: "default", start: "", end: "done#" });
    expect(filters[1]!.HashRangeRange!.start).toBe("done$");
  });

  test("a slug that starts with the excluded column's name is still returned", async () => {
    // `done-with-x` is a TODO card whose slug begins with "done". The bounds
    // are on the sort key (`column#…`), so it must survive — a prefix test on
    // the slug rather than the key would eat it.
    const node = fakeNode();
    seedFourColumns(node);
    seed(node, card({ slug: "done-with-x", column: "todo", position: "2" }));

    const rows = await listBoardCardsPartition(node, cfg, "default", { excludeColumn: "done" });

    expect(slugs(rows)).toContain("done-with-x");
    expect(slugs(rows)).not.toContain("in-done");
  });

  test("each board's OWN terminal column is excluded, not a hardcoded 'done'", async () => {
    const node = fakeNode();
    seedFourColumns(node, "default");
    // A board whose terminal column is `shipped`, and which also has a column
    // literally called `done` that is NOT terminal — the case that catches a
    // hardcoded exclusion in both directions at once.
    seed(node, card({ slug: "custom-done", board: "custom", column: "done", position: "1" }));
    seed(node, card({ slug: "custom-shipped", board: "custom", column: "shipped", position: "1" }));

    const rows = await listAllBoardCards(
      node,
      cfg,
      [
        { slug: "default", columns: ["backlog", "todo", "doing", "done"] },
        { slug: "custom", columns: ["done", "shipped"] },
      ],
      { skipTerminalColumn: true },
    );

    expect(slugs(rows)).toEqual(["custom-done", "in-backlog", "in-doing", "in-todo"]);
  });

  test("a board with no known column list reads whole", async () => {
    // Degrade to correct-and-slower. Guessing a terminal column for a board we
    // cannot see the shape of would drop live rows.
    const node = fakeNode();
    seedFourColumns(node);

    const rows = await listAllBoardCards(node, cfg, [{ slug: "default" }], {
      skipTerminalColumn: true,
    });

    expect(slugs(rows)).toEqual(["in-backlog", "in-doing", "in-done", "in-todo"]);
    const filters = node.reads.filter((r) => r.schemaHash === BC).map((r) => r.filter as unknown as Record<string, unknown>);
    expect(filters).toHaveLength(1);
    expect(filters[0]!.HashKey).toBe("default");
  });

  test("without skipTerminalColumn the read is unchanged — one HashKey per board", async () => {
    const node = fakeNode();
    seedFourColumns(node);

    const rows = await listAllBoardCards(node, cfg, [
      { slug: "default", columns: ["backlog", "todo", "doing", "done"] },
    ]);

    expect(slugs(rows)).toEqual(["in-backlog", "in-doing", "in-done", "in-todo"]);
    const filters = node.reads.filter((r) => r.schemaHash === BC).map((r) => r.filter as unknown as Record<string, unknown>);
    expect(filters).toHaveLength(1);
    expect(filters[0]!.HashKey).toBe("default");
  });
});
