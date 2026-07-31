/**
 * A move rewrites the BoardCards sort key (`column#position#slug`), so the
 * destination is a different row from the source and there is no transaction
 * spanning the two. Something is observable in between; these tests pin WHICH
 * something.
 *
 * The rule: the destination row must be durable before the source row is
 * retired. Then a failed write leaves the card where it was, and a failed
 * cleanup leaves a duplicate that `listAllBoardCards` already resolves in
 * favour of the fresher row. The reverse order — retire first — makes the
 * in-between state "no membership row on any board", which every
 * BoardCards-backed read (`list`, `pickup`, `overlap`, `rank`, `milestone
 * portfolio`, dep seeding, the footer) renders as a card that does not exist.
 */
import { describe, expect, test } from "bun:test";

import {
  boardCardFieldsFromCard,
  boardCardSk,
  listAllBoardCards,
  upsertBoardCard,
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

/** Seed a BoardCards row directly, bypassing the code under test. */
function seedRow(node: FakeNode, c: Card): void {
  node.seed({
    schemaHash: BC,
    keyHash: c.board || "default",
    rangeKey: boardCardSk(c.column, c.position, c.slug),
    fields: boardCardFieldsFromCard(c),
  });
}

/** Make every write addressed at `sk` fail, as a busy node's deadline would. */
function failWritesAt(node: FakeNode, sk: string): void {
  const wrap = (orig: FakeNode["updateRecord"]) =>
    (async (args: Parameters<FakeNode["updateRecord"]>[0]) => {
      if (args.rangeKey === sk) throw new Error("deadline_exceeded");
      return orig(args);
    }) as FakeNode["updateRecord"];
  node.updateRecord = wrap(node.updateRecord.bind(node));
  node.createRecord = wrap(node.createRecord.bind(node)) as FakeNode["createRecord"];
}

const slugsOf = (rows: Card[] | null) => (rows ?? []).map((c) => c.slug);

describe("BoardCards move durability", () => {
  test("a failed destination write leaves the card on the board, where it was", async () => {
    // The regression this whole file exists for. Retiring the source row first
    // made this case delete the only membership row the card had, and the
    // card then read as absent from every board view until the next
    // `groom board-cards-heal`.
    const node = fakeNode();
    const prev = card({ column: "todo", position: "1" });
    const next = card({ column: "doing", position: "2", updated_at: "2026-01-03T00:00:00.000Z" });
    seedRow(node, prev);
    failWritesAt(node, boardCardSk(next.column, next.position, next.slug));

    await expect(upsertBoardCard(node, cfg, next, prev)).rejects.toThrow();

    const rows = await listAllBoardCards(node, cfg, [{ slug: "default" }]);
    expect(slugsOf(rows)).toEqual(["move-me"]);
    expect(rows![0]!.column).toBe("todo"); // still at the source, not vanished
  });

  test("the destination write is issued before the source delete", async () => {
    // The ordering itself, asserted directly — the durability property above is
    // a consequence of it, and an "optimisation" that reorders these two would
    // otherwise only show up as a rare lost card in production.
    const node = fakeNode();
    const prev = card({ column: "todo", position: "1" });
    const next = card({ column: "doing", position: "2", updated_at: "2026-01-03T00:00:00.000Z" });
    seedRow(node, prev);

    await upsertBoardCard(node, cfg, next, prev);

    const bc = node.writes.filter((w) => w.schemaHash === BC);
    const wroteDest = bc.findIndex(
      (w) => w.op !== "delete" && w.rangeKey === boardCardSk(next.column, next.position, next.slug),
    );
    const deletedSource = bc.findIndex(
      (w) => w.op === "delete" && w.rangeKey === boardCardSk(prev.column, prev.position, prev.slug),
    );
    expect(wroteDest).toBeGreaterThanOrEqual(0);
    expect(deletedSource).toBeGreaterThanOrEqual(0);
    expect(wroteDest).toBeLessThan(deletedSource);
  });

  test("a completed move still leaves exactly one row, at the destination", async () => {
    const node = fakeNode();
    const prev = card({ column: "todo", position: "1" });
    const next = card({ column: "doing", position: "2", updated_at: "2026-01-03T00:00:00.000Z" });
    seedRow(node, prev);

    await upsertBoardCard(node, cfg, next, prev);

    const rows = await listAllBoardCards(node, cfg, [{ slug: "default" }]);
    expect(rows).toHaveLength(1);
    expect(rows![0]!.column).toBe("doing");
    expect(node.rowsOf(BC)).toHaveLength(1);
  });

  test("a failed cleanup leaves a duplicate that resolves to the new row", async () => {
    // The failure mode we deliberately trade INTO. It must be benign, not
    // merely rarer: readers dedupe by slug and prefer the fresher `updated_at`,
    // and every mutation reaching upsert bumps that field, so the row just
    // written wins by construction. `groom board-cards-heal` reaps the loser.
    const node = fakeNode();
    const prev = card({ column: "todo", position: "1" });
    const next = card({ column: "doing", position: "2", updated_at: "2026-01-03T00:00:00.000Z" });
    seedRow(node, prev);
    const realDelete = node.deleteRecord.bind(node);
    node.deleteRecord = (async () => {
      throw new Error("deadline_exceeded");
    }) as FakeNode["deleteRecord"];

    // deleteBoardCardSk is best-effort, so the move itself still reports success.
    await upsertBoardCard(node, cfg, next, prev);
    node.deleteRecord = realDelete;

    expect(node.rowsOf(BC)).toHaveLength(2); // both rows really are present
    const rows = await listAllBoardCards(node, cfg, [{ slug: "default" }]);
    expect(rows).toHaveLength(1);
    expect(rows![0]!.column).toBe("doing"); // the fresher row wins
  });

  test("the no-previous orphan purge also runs only after the row is durable", async () => {
    // Callers that omit `previous` (legacy/add/metadata paths) purge every
    // other sk for the slug instead of one known key. Same hazard, same rule:
    // a failed destination write must not strip the membership the card has.
    const node = fakeNode();
    const stale = card({ column: "todo", position: "1" });
    const next = card({ column: "doing", position: "2", updated_at: "2026-01-03T00:00:00.000Z" });
    seedRow(node, stale);
    failWritesAt(node, boardCardSk(next.column, next.position, next.slug));

    await expect(upsertBoardCard(node, cfg, next, null)).rejects.toThrow();

    const rows = await listAllBoardCards(node, cfg, [{ slug: "default" }]);
    expect(slugsOf(rows)).toEqual(["move-me"]);
    expect(rows![0]!.column).toBe("todo");
  });

  test("the no-previous orphan purge still drops stale sks on success", async () => {
    // Deferring the purge must not cancel it: the end state is unchanged.
    const node = fakeNode();
    seedRow(node, card({ column: "todo", position: "1" }));
    seedRow(node, card({ column: "review", position: "9" }));
    const next = card({ column: "doing", position: "2", updated_at: "2026-01-03T00:00:00.000Z" });

    await upsertBoardCard(node, cfg, next, null);

    expect(node.rowsOf(BC)).toHaveLength(1);
    expect(node.rowAt(BC, "default", boardCardSk("doing", "2", "move-me"))).toBeDefined();
  });
});
