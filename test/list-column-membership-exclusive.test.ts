/**
 * A card's BoardCards membership is exclusive per column list.
 *
 * A leftover todo row after a move to doing used to appear in both
 * `list --column todo` and `list --column doing` while `show` reported one
 * column. List now drops overlap losers against the Card tip. Move deletes
 * other-column rows even when the tip is already in the target column.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { boardCardFieldsFromCard, boardCardSk } from "../src/board-cards.ts";
import { resetBoardCardJanitorForTests } from "../src/board-card-janitor.ts";
import { listCardsByColumn, boardToFields, cardToFields, emptyStructuredFields, type Board, type Card } from "../src/record.ts";
import { moveCmd } from "../src/commands/move.ts";
import type { Config } from "../src/config.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";
import { fakeNode } from "./fake-node.ts";
import { cardsFromJson } from "./json_page.ts";
import { listCmd } from "../src/commands/list.ts";

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
    slug: "dual-member",
    title: "Dual",
    body: "",
    board: "default",
    column: "doing",
    position: "2",
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

function seedAll(node: ReturnType<typeof fakeNode>, tip: Card, extraRows: Card[]) {
  node.seed({
    schemaHash: BOARD,
    keyHash: "default",
    fields: boardToFields(board()),
  });
  node.seed({
    schemaHash: CARD,
    keyHash: tip.slug,
    fields: cardToFields(tip),
  });
  for (const row of [tip, ...extraRows]) {
    node.seed({
      schemaHash: BC,
      keyHash: row.board,
      rangeKey: boardCardSk(row.column, row.position, row.slug),
      fields: boardCardFieldsFromCard(row),
    });
  }
}

describe("column list membership is exclusive", () => {
  beforeEach(() => {
    resetBoardCardJanitorForTests();
  });

  test("list todo drops a surviving todo row when the Card tip is doing, and heals it", async () => {
    const node = fakeNode();
    const tip = card({ column: "doing", position: "2" });
    const staleTodo = card({ column: "todo", position: "1", updated_at: "2026-01-01T00:00:00.000Z" });
    seedAll(node, tip, [staleTodo]);

    const todo = await listCardsByColumn(node, cfg, "todo", ["slug", "column"], "default", {
      healStaleRows: true,
    });
    expect(todo.map((c) => c.slug)).not.toContain(tip.slug);

    const doing = await listCardsByColumn(node, cfg, "doing", ["slug", "column"], "default");
    expect(doing.map((c) => c.slug)).toContain(tip.slug);

    const leftover = node.writes.filter(
      (w) => w.op === "delete" && w.rangeKey === boardCardSk("todo", "1", tip.slug),
    );
    expect(leftover.length).toBeGreaterThan(0);
  });

  test("move into the current column still deletes leftover other-column rows", async () => {
    const node = fakeNode();
    const tip = card({ column: "doing", position: "2" });
    const staleTodo = card({ column: "todo", position: "1", updated_at: "2026-01-01T00:00:00.000Z" });
    seedAll(node, tip, [staleTodo]);

    const result = await moveCmd({
      cfg,
      node,
      slug: tip.slug,
      column: "doing",
      allowUnclaimed: true,
    });
    expect(result).toMatchObject({ slug: tip.slug, from: "doing", to: "doing" });

    const todo = cardsFromJson(
      await listCmd({ cfg, node, column: "todo", json: true }),
    ) as Array<{ slug: string }>;
    expect(todo.map((c) => c.slug)).not.toContain(tip.slug);
  });
});
