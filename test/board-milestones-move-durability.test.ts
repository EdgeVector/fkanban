/**
 * A milestone state change rewrites the BoardMilestones sort key
 * (`state#position#slug`), so the destination is a different row from the
 * source and no transaction spans the two. Something is observable in between;
 * these tests pin WHICH something.
 *
 * The rule is the one `board-cards-move-durability.test.ts` already pins for
 * BoardCards: the destination row must be durable before the source row is
 * retired. Retiring first makes the in-between state "the milestone has no
 * BoardMilestones row on any board" — and `listAllBoardMilestones` is the read
 * behind `milestone list`, `milestone portfolio` and `milestone groom`, so the
 * milestone reads as one that does not exist. Worse than the card case: the
 * index read only falls back to the fat Milestone scan when the query THREW.
 * A partition that answers, minus one row, is authoritative.
 */
import { describe, expect, test } from "bun:test";

import {
  boardMilestoneFieldsFromMilestone,
  boardMilestoneSk,
  listAllBoardMilestones,
  upsertBoardMilestone,
} from "../src/board-milestones.ts";
import type { Config } from "../src/config.ts";
import type { Milestone } from "../src/record.ts";
import { fakeNode, type FakeNode } from "./fake-node.ts";

const BM = "board-milestones-hash";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://127.0.0.1:9",
  userHash: "user",
  schemaServiceUrl: "http://127.0.0.1:9",
  schemaHashes: {
    board: "board-hash",
    card: "card-hash",
    milestone: "milestone-hash",
    board_milestones: BM,
  },
};

function milestone(partial: Partial<Milestone> = {}): Milestone {
  return {
    slug: "ship-it",
    title: "Ship it",
    body: "",
    board: "default",
    state: "planned",
    position: "1",
    north_star: "ns-demo",
    driver: "",
    deps: [],
    proof_card: "",
    proof_status: "pending",
    block_reason: "",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    completed_at: "",
    ...partial,
  } as Milestone;
}

/** Seed a BoardMilestones row directly, bypassing the code under test. */
function seedRow(node: FakeNode, m: Milestone): void {
  node.seed({
    schemaHash: BM,
    keyHash: m.board || "default",
    rangeKey: boardMilestoneSk(m.state, m.position, m.slug),
    fields: boardMilestoneFieldsFromMilestone(m),
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

const slugsOf = (rows: Milestone[] | null) => (rows ?? []).map((m) => m.slug);
const boards = [{ slug: "default" }];

/**
 * `dropIncompleteRows: false` — the measured behaviour of THIS index, not a
 * convenience.
 *
 * `BOARD_MILESTONES_FIELDS` projects `completed_at` and
 * `boardMilestoneFieldsFromMilestone` deliberately never writes it, so under
 * the strict rule every BoardMilestones row would be dropped by its own
 * display read and these tests would assert on an empty board for the wrong
 * reason. On the live primary they are not dropped: 33 of 33 rows return,
 * 0 carrying the key (`scripts/probe-wire-projection-semantics.ts`,
 * 2026-08-01). See the `fake-node.ts` header — it names BoardMilestones as an
 * index measured NOT to drop.
 */
const bmNode = () => fakeNode({ dropIncompleteRows: false });

describe("BoardMilestones move durability", () => {
  test("a failed destination write leaves the milestone on the board, where it was", async () => {
    // The regression this file exists for. `milestone state ship-it active`
    // rewrites the sk, so retiring the source first deletes the only
    // BoardMilestones row the milestone has, and it then reads as absent from
    // `milestone list` / `portfolio` until the next `groom milestone-indexes`.
    const node = bmNode();
    const prev = milestone({ state: "planned", position: "1" });
    const next = milestone({
      state: "active",
      position: "1",
      updated_at: "2026-01-03T00:00:00.000Z",
    });
    seedRow(node, prev);
    failWritesAt(node, boardMilestoneSk(next.state, next.position, next.slug));

    await expect(upsertBoardMilestone(node, cfg, next, prev)).rejects.toThrow();

    const rows = await listAllBoardMilestones(node, cfg, boards);
    expect(slugsOf(rows)).toEqual(["ship-it"]);
    expect(rows![0]!.state).toBe("planned"); // still at the source, not vanished
  });

  test("the destination write is issued before the source delete", async () => {
    // The ordering itself, asserted directly. The durability property above is
    // a consequence of it, and a refactor that reordered these two would
    // otherwise surface only as a rare vanished milestone in production.
    const node = bmNode();
    const prev = milestone({ state: "planned", position: "1" });
    const next = milestone({
      state: "active",
      position: "1",
      updated_at: "2026-01-03T00:00:00.000Z",
    });
    seedRow(node, prev);

    await upsertBoardMilestone(node, cfg, next, prev);

    const bm = node.writes.filter((w) => w.schemaHash === BM);
    const wroteDest = bm.findIndex(
      (w) =>
        w.op !== "delete" &&
        w.rangeKey === boardMilestoneSk(next.state, next.position, next.slug),
    );
    const deletedSource = bm.findIndex(
      (w) =>
        w.op === "delete" &&
        w.rangeKey === boardMilestoneSk(prev.state, prev.position, prev.slug),
    );
    expect(wroteDest).toBeGreaterThanOrEqual(0);
    expect(deletedSource).toBeGreaterThanOrEqual(0);
    expect(wroteDest).toBeLessThan(deletedSource);
  });

  test("a completed state change still leaves exactly one row, at the destination", async () => {
    const node = bmNode();
    const prev = milestone({ state: "planned", position: "1" });
    const next = milestone({
      state: "active",
      position: "1",
      updated_at: "2026-01-03T00:00:00.000Z",
    });
    seedRow(node, prev);

    await upsertBoardMilestone(node, cfg, next, prev);

    const rows = await listAllBoardMilestones(node, cfg, boards);
    expect(rows).toHaveLength(1);
    expect(rows![0]!.state).toBe("active");
    expect(node.rowsOf(BM)).toHaveLength(1);
  });

  test("a failed cleanup leaves a duplicate that resolves to the new row", async () => {
    // The failure mode we deliberately trade INTO. It must be benign, not
    // merely rarer: `listAllBoardMilestones` dedupes by slug preferring the
    // fresher `updated_at`, and `milestoneUpsertCmd` stamps that field on every
    // mutation, so the row just written wins by construction.
    const node = bmNode();
    const prev = milestone({ state: "planned", position: "1" });
    const next = milestone({
      state: "active",
      position: "1",
      updated_at: "2026-01-03T00:00:00.000Z",
    });
    seedRow(node, prev);
    const realDelete = node.deleteRecord.bind(node);
    node.deleteRecord = (async () => {
      throw new Error("deadline_exceeded");
    }) as FakeNode["deleteRecord"];

    // deleteBoardMilestoneSk is best-effort, so the upsert still reports success.
    await upsertBoardMilestone(node, cfg, next, prev);
    node.deleteRecord = realDelete;

    expect(node.rowsOf(BM)).toHaveLength(2); // both rows really are present
    const rows = await listAllBoardMilestones(node, cfg, boards);
    expect(rows).toHaveLength(1);
    expect(rows![0]!.state).toBe("active"); // the fresher row wins
  });

  test("the no-previous orphan purge also runs only after the row is durable", async () => {
    // `milestone_indexes_heal` and the reconcile paths call with previous=null,
    // so they purge every other sk for the slug rather than one known key. Same
    // hazard, same rule — and sharper here, because a repair verb that deletes
    // more than it writes leaves the board worse than it found it.
    const node = bmNode();
    const stale = milestone({ state: "planned", position: "1" });
    const next = milestone({
      state: "active",
      position: "1",
      updated_at: "2026-01-03T00:00:00.000Z",
    });
    seedRow(node, stale);
    failWritesAt(node, boardMilestoneSk(next.state, next.position, next.slug));

    await expect(upsertBoardMilestone(node, cfg, next, null)).rejects.toThrow();

    const rows = await listAllBoardMilestones(node, cfg, boards);
    expect(slugsOf(rows)).toEqual(["ship-it"]);
    expect(rows![0]!.state).toBe("planned");
  });

  test("the no-previous orphan purge still drops stale sks on success", async () => {
    // Deferring the purge must not cancel it: the end state is unchanged.
    const node = bmNode();
    seedRow(node, milestone({ state: "planned", position: "1" }));
    seedRow(node, milestone({ state: "blocked", position: "9" }));
    const next = milestone({
      state: "active",
      position: "1",
      updated_at: "2026-01-03T00:00:00.000Z",
    });

    await upsertBoardMilestone(node, cfg, next, null);

    expect(node.rowsOf(BM)).toHaveLength(1);
    expect(node.rowAt(BM, "default", boardMilestoneSk("active", "1", "ship-it"))).toBeDefined();
  });

  test("a board change retires the old board's rows only after the new row lands", async () => {
    // Cross-board move: prevBoard !== nextBoard takes a different branch, with
    // a whole-partition purge of the SOURCE board on top of the targeted
    // delete. Both are retirements and both must wait.
    const node = bmNode();
    const prev = milestone({ board: "default", state: "planned", position: "1" });
    const next = milestone({
      board: "scratch",
      state: "planned",
      position: "1",
      updated_at: "2026-01-03T00:00:00.000Z",
    });
    seedRow(node, prev);
    failWritesAt(node, boardMilestoneSk(next.state, next.position, next.slug));

    await expect(upsertBoardMilestone(node, cfg, next, prev)).rejects.toThrow();

    const rows = await listAllBoardMilestones(node, cfg, [
      { slug: "default" },
      { slug: "scratch" },
    ]);
    expect(slugsOf(rows)).toEqual(["ship-it"]);
    expect(rows![0]!.board).toBe("default"); // still on the source board
  });
});
