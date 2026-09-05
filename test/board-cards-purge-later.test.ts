/**
 * Create/update of a BoardCards row does not run janitor purge on that
 * REQUEST. Previous-sk / orphans enqueue; a later sweeper REQUEST contains the
 * deletes. Drives the shipped upsertBoardCard path, not a copy.
 *
 * "Later request", not "later command". Until 2026-09-05 this file read
 * `upsertBoardCard` -> queue still full -> caller sweeps, and asserted the
 * middle state as the contract. No production mutation path ever swept, so the
 * queued delete died with the CLI process and every `kanban move` left its
 * source row in the partition (9 of 13 rows in the live `doing` lane were
 * phantom on 2026-09-05T02:05Z). The request boundary is the invariant; the
 * command boundary was an accident, and pinning it hid the leak.
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

  test("the destination write request carries no delete", async () => {
    const node = fakeNode();
    const prev = card({ column: "todo", position: "1" });
    const next = card({ column: "doing", position: "2", updated_at: "2026-01-03T00:00:00.000Z" });
    seedRow(node, prev);

    await upsertBoardCard(node, cfg, next, prev);

    const bc = node.writes.filter((w) => w.schemaHash === BC);
    const destAt = bc.findIndex(
      (w) => w.op !== "delete" && w.rangeKey === boardCardSk("doing", "2", "move-me"),
    );
    expect(destAt).toBeGreaterThanOrEqual(0);
    // Every delete is a strictly later entry, so none of them rode along on
    // the create/update that put the destination row down.
    for (const [i, w] of bc.entries()) {
      if (w.op === "delete") expect(i).toBeGreaterThan(destAt);
    }
  });

  test("the deletes go out as their own request, and the queue is left empty", async () => {
    resetBoardCardJanitorForTests();
    const node = fakeNode();
    const prev = card({ column: "todo", position: "1" });
    const next = card({ column: "doing", position: "2", updated_at: "2026-01-03T00:00:00.000Z" });
    seedRow(node, prev);

    await upsertBoardCard(node, cfg, next, prev);

    // `deleteBatches` is the separate request. A non-empty queue here is the
    // 2026-09-05 leak: nothing downstream of `upsertBoardCard` drains it.
    expect(node.deleteBatches.length).toBeGreaterThan(0);
    expect(peekBoardCardJanitor()).toHaveLength(0);
    const deletes = node.writes.filter((w) => w.schemaHash === BC && w.op === "delete");
    expect(deletes.some((w) => w.rangeKey === boardCardSk("todo", "1", "move-me"))).toBe(true);

    // A second sweep has nothing left to do — the first one was real.
    expect(await sweepBoardCardJanitor(node)).toBe(0);

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
