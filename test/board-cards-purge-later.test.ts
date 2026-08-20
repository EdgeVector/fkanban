/**
 * Create/update of a BoardCards row does not run janitor purge on that
 * request. Previous-sk / orphans enqueue; a later sweeper request contains
 * the deletes. Drives the shipped upsertBoardCard path, not a copy.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import {
  boardCardFieldsFromCard,
  boardCardSk,
  listAllBoardCards,
  sweepBoardCardJanitor,
  upsertBoardCard,
} from "../src/board-cards.ts";
import {
  peekBoardCardJanitor,
  resetBoardCardJanitorForTests,
} from "../src/board-card-janitor.ts";
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
    slug: "move-me",
    title: "Move me",
    body: "",
    board: "default",
    column: "todo",
    position: "1",
    assignee: "tom",
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
  } as Card;
}

function seedRow(node: FakeNode, c: Card): void {
  node.seed({
    schemaHash: BC,
    keyHash: c.board || "default",
    rangeKey: boardCardSk(c.column, c.position, c.slug),
    fields: boardCardFieldsFromCard(c),
  });
}

describe("BoardCards create/update batches contain no Purge", () => {
  beforeEach(() => {
    resetBoardCardJanitorForTests();
  });

  test("a move's mutation batch contains only updates/creates", async () => {
    const node = fakeNode();
    const prev = card({ column: "todo", position: "1" });
    const next = card({ column: "doing", position: "2", updated_at: "2026-01-03T00:00:00.000Z" });
    seedRow(node, prev);

    await upsertBoardCard(node, cfg, next, prev);

    const bc = node.writes.filter((w) => w.schemaHash === BC);
    expect(bc.every((w) => w.op === "update" || w.op === "create")).toBe(true);
    expect(bc.some((w) => w.op === "delete")).toBe(false);
    expect(peekBoardCardJanitor().some((t) => t.sk === boardCardSk("todo", "1", "move-me"))).toBe(
      true,
    );
  });

  test("a later sweeper request contains the deletes", async () => {
    resetBoardCardJanitorForTests();
    const node = fakeNode();
    const prev = card({ column: "todo", position: "1" });
    const next = card({ column: "doing", position: "2", updated_at: "2026-01-03T00:00:00.000Z" });
    seedRow(node, prev);

    await upsertBoardCard(node, cfg, next, prev);
    const beforeSweep = node.writes.filter((w) => w.schemaHash === BC && w.op === "delete");
    expect(beforeSweep).toHaveLength(0);

    const attempted = await sweepBoardCardJanitor(node);
    expect(attempted).toBeGreaterThan(0);
    const deletes = node.writes.filter((w) => w.schemaHash === BC && w.op === "delete");
    expect(deletes.some((w) => w.rangeKey === boardCardSk("todo", "1", "move-me"))).toBe(true);
    expect(node.deleteBatches.length).toBeGreaterThan(0);

    const rows = await listAllBoardCards(node, cfg, [{ slug: "default" }]);
    expect(rows).toHaveLength(1);
    expect(rows![0]!.column).toBe("doing");
  });

  test("a create does not scan the partition or issue Purge", async () => {
    resetBoardCardJanitorForTests();
    const node = fakeNode();
    seedRow(node, card({ column: "todo", position: "1" }));
    const next = card({ column: "doing", position: "2", updated_at: "2026-01-03T00:00:00.000Z" });

    await upsertBoardCard(node, cfg, next, null);

    expect(node.writes.filter((w) => w.op === "delete")).toHaveLength(0);
    expect(node.reads.filter((r) => r.schemaHash === BC)).toHaveLength(0);
  });
});
