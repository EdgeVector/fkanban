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
import { beforeEach, describe, expect, test } from "bun:test";

import {
  boardCardFieldsFromCard,
  boardCardSk,
  listAllBoardCards,
  upsertBoardCard,
} from "../src/board-cards.ts";
import { peekBoardCardJanitor, resetBoardCardJanitorForTests } from "../src/board-card-janitor.ts";
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
  beforeEach(() => {
    resetBoardCardJanitorForTests();
  });

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

  test("the source delete is a later request than the destination write, never the same one", async () => {
    // The janitor's rule is "not in the create/update REQUEST" — not "not in
    // this command". Both halves matter and only the pair pins them: the
    // delete must EXIST (it is dropped otherwise, which is the 2026-09-05
    // leak) and it must come strictly after the destination write.
    resetBoardCardJanitorForTests();
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
    expect(deletedSource).toBeGreaterThan(wroteDest);
  });

  test("the source delete is not issued until the destination write has RESOLVED", async () => {
    // The test above reads ISSUE order; the invariant is COMPLETION order, and
    // the two come apart for exactly the change most likely to be made here.
    //
    // Overlapping the two with `Promise.all([write(...), retire(...)])` still
    // issues the write first — an async function runs synchronously up to its
    // first await, so `node.writes` records it ahead of the delete and the
    // issue-order assertion above passes unchanged. Verified by patching
    // `upsertBoardCard` to that shape: this file went 4 pass / 2 fail and the
    // issue-order test was one of the four that PASSED. The durability tests
    // caught it, but the test whose NAME is the ordering could not.
    //
    // It matters because the destination row is not merely un-acked during that
    // window, it is unreadable: measured on the live primary
    // (`scripts/probe-readback-lag-by-schema.ts`) a BoardCards write is invisible
    // to a partition query for ~514ms after its own ack, 0 of 6 rows readable on
    // the first read. Issuing the delete inside that window is what opens the
    // hole where the card is on no board at all.
    const node = fakeNode();
    const prev = card({ column: "todo", position: "1" });
    const next = card({ column: "doing", position: "2", updated_at: "2026-01-03T00:00:00.000Z" });
    seedRow(node, prev);

    const destSk = boardCardSk(next.column, next.position, next.slug);
    const srcSk = boardCardSk(prev.column, prev.position, prev.slug);

    // Hold the destination write open. Nothing resolves it until we say so, so
    // "did the delete happen while the write was in flight?" is a deterministic
    // question rather than a stopwatch.
    let releaseWrite: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const realUpdate = node.updateRecord.bind(node);
    node.updateRecord = (async (args: Parameters<FakeNode["updateRecord"]>[0]) => {
      if (args.schemaHash === BC && args.rangeKey === destSk) {
        await held;
      }
      return realUpdate(args);
    }) as FakeNode["updateRecord"];

    const inFlight = upsertBoardCard(node, cfg, next, prev);

    // Give any overlapped delete every chance to land before we look.
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));

    const deletedWhilePending = node.writes.some(
      (w) => w.schemaHash === BC && w.op === "delete" && w.rangeKey === srcSk,
    );
    expect(deletedWhilePending).toBe(false);

    releaseWrite();
    await inFlight;

    // ...and it HAS happened by the time `upsertBoardCard` resolves, with no
    // help from the caller. This assertion used to require the test to call
    // `sweepBoardCardJanitor` itself first, which is precisely why the missing
    // production sweep survived: no production mutation path called it, so
    // every move leaked its source row while this file read green.
    expect(
      node.writes.some(
        (w) => w.schemaHash === BC && w.op === "delete" && w.rangeKey === srcSk,
      ),
    ).toBe(true);
  });

  test("a completed move leaves exactly one row, with no caller sweeping the janitor", async () => {
    // `kanban move` reaches `upsertBoardCard` and nothing else: no
    // `removeBoardCardsBatch`, no `groom board-cards-heal`, and the CLI has no
    // exit hook. So this test may not sweep either — it used to, and that one
    // line is what let the production leak read as covered. The empty-queue
    // assertion is the load-bearing half: it fails if the sweep moves back out
    // of `upsertBoardCard` into a caller.
    resetBoardCardJanitorForTests();
    const node = fakeNode();
    const prev = card({ column: "todo", position: "1" });
    const next = card({ column: "doing", position: "2", updated_at: "2026-01-03T00:00:00.000Z" });
    seedRow(node, prev);

    await upsertBoardCard(node, cfg, next, prev);

    expect(peekBoardCardJanitor()).toHaveLength(0);
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
    const realDeletes = node.deleteRecords?.bind(node);
    node.deleteRecord = (async () => {
      throw new Error("deadline_exceeded");
    }) as FakeNode["deleteRecord"];
    // The janitor tries the BATCH verb first and only falls back per row, so
    // both have to fail for this to be a failed cleanup rather than a slow one.
    node.deleteRecords = (async () => {
      throw new Error("deadline_exceeded");
    }) as NonNullable<FakeNode["deleteRecords"]>;

    // deleteBoardCardSk is best-effort, so the move itself still reports success.
    await upsertBoardCard(node, cfg, next, prev);
    node.deleteRecord = realDelete;
    node.deleteRecords = realDeletes;

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

  test("the no-previous path does not scan or purge on the write", async () => {
    resetBoardCardJanitorForTests();
    const node = fakeNode();
    seedRow(node, card({ column: "todo", position: "1" }));
    seedRow(node, card({ column: "review", position: "9" }));
    const next = card({ column: "doing", position: "2", updated_at: "2026-01-03T00:00:00.000Z" });

    await upsertBoardCard(node, cfg, next, null);

    expect(node.writes.some((w) => w.op === "delete")).toBe(false);
    expect(node.rowAt(BC, "default", boardCardSk("doing", "2", "move-me"))).toBeDefined();
  });
});
