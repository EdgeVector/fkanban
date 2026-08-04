/**
 * A membership read may SUPPLY a partial row. It may not DENY one.
 *
 * `MilestoneCards` and `BoardMilestones` each carried a `layout` marker check
 * written as
 *
 *     if (String(f.layout ?? "") !== LAYOUT) return null;
 *
 * which reads an ABSENT marker as a FOREIGN one. That is safe only if the node
 * never returns a row missing a projected field — and it does. Measured on the
 * live primary 2026-08-01 (`scripts/probe-layout-marker-denial.ts`,
 * `scripts/probe-wire-projection-semantics.ts`):
 *
 *   - MilestoneCards, `lastdb-0231-read-regression-fixes`: 56 rows at `["slug"]`,
 *     and 9 of them come back with no `layout` key at 24-field width. The node
 *     returned them; the client threw them away.
 *   - BoardMilestones, `default`: all 33 rows come back with no `completed_at`
 *     key, because no writer has ever written that field.
 *
 * A denied row is invisible to `milestone detail`, to `milestone reconcile`,
 * and to `purgeOther*Rows` — so it cannot be reported and cannot be deleted.
 * That is a permanent orphan, and reconcile re-issues the same repair against
 * it on every run.
 *
 * The second half is the address. Both purges rebuilt the sk from the
 * `column`/`position`/`slug` (or `state`/`position`/`slug`) payload COPIES,
 * which the same measurement shows going missing — 9 of those 56 rows had no
 * `sk` copy either. A rebuilt key that addresses nothing deletes nothing and
 * still counts a deletion. The row's real range key comes back on `QueryRow.key.range`
 * and was, before this, never read anywhere in `src/`.
 *
 * These tests run against `dropIncompleteRows: false` — the measured behaviour
 * of these two indexes (see `test/fake-node.ts`).
 */
import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config.ts";
import { fakeNode, type FakeNode } from "./fake-node.ts";
import {
  listMilestoneCardsPartition,
  listMilestoneCardsPartitionSpine,
  purgeOtherMilestoneCardRows,
  milestoneCardSk,
} from "../src/milestone-cards.ts";
import {
  listBoardMilestonesPartition,
  listBoardMilestonesPartitionSpine,
  purgeOtherBoardMilestoneRows,
  boardMilestoneSk,
} from "../src/board-milestones.ts";
import { MILESTONE_CARDS_LAYOUT, BOARD_MILESTONES_LAYOUT } from "../src/schemas.ts";

const MC_HASH = "milestone-cards-hash";
const BM_HASH = "board-milestones-hash";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://127.0.0.1:9",
  userHash: "user",
  schemaServiceUrl: "http://127.0.0.1:9",
  schemaHashes: { milestone_cards: MC_HASH, board_milestones: BM_HASH },
};

/** The node these two indexes were measured to be: partial rows, no drops. */
function partialRowNode(): FakeNode {
  return fakeNode({ baseUrl: cfg.nodeUrl, userHash: cfg.userHash, dropIncompleteRows: false });
}

function mcRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    milestone: "ms-a",
    sk: milestoneCardSk("todo", "10", "card-a"),
    slug: "card-a",
    title: "Card A",
    board: "default",
    column: "todo",
    position: "10",
    assignee: "",
    tags: [],
    deps: [],
    surfaces: [],
    created_at: "2026-01-01T00:00:00.000Z",
    created_by: "test",
    updated_at: "2026-01-01T00:00:00.000Z",
    db: "",
    repo: "",
    base: "",
    kind: "pr",
    block_status: "",
    block_reason: "",
    north_star: "",
    pr_url: "",
    branch: "",
    layout: MILESTONE_CARDS_LAYOUT,
    ...over,
  };
}

function seedMc(node: FakeNode, fields: Record<string, unknown>, sk: string): void {
  node.seed({ schemaHash: MC_HASH, keyHash: String(fields.milestone ?? "ms-a"), rangeKey: sk, fields });
}

describe("the oracle models what the node was measured to do", () => {
  /**
   * On the primary, `"completed_at" in row.fields` is FALSE for all 33
   * BoardMilestones rows — the node omits the key, it does not hand back a key
   * holding `undefined`. A guard written as `"x" in fields` has to fail here
   * for the same reason it fails in production, so the fake must omit too.
   */
  test("a projected field with no atom is omitted, not set to undefined", async () => {
    const node = partialRowNode();
    const row = mcRow();
    delete row.layout;
    seedMc(node, row, String(row.sk));

    const res = await node.queryAll({
      schemaHash: MC_HASH,
      fields: ["slug", "layout"],
      filter: { HashKey: "ms-a" },
    });

    const fields = res.results[0]!.fields;
    expect("slug" in fields).toBe(true);
    expect("layout" in fields).toBe(false);
  });

  test("the row's real range key is reported on `key.range`", async () => {
    const node = partialRowNode();
    const sk = milestoneCardSk("todo", "10", "card-a");
    seedMc(node, mcRow(), sk);

    const res = await node.queryAll({
      schemaHash: MC_HASH,
      fields: ["slug"],
      filter: { HashKey: "ms-a" },
    });

    expect(res.results[0]!.key.range).toBe(sk);
  });
});

describe("MilestoneCards: an absent layout marker is not a foreign one", () => {
  test("a row whose `layout` did not come back is still a child of the milestone", async () => {
    const node = partialRowNode();
    const whole = mcRow();
    const partial = mcRow({ slug: "card-b", sk: milestoneCardSk("doing", "20", "card-b"), column: "doing", position: "20" });
    delete partial.layout;
    seedMc(node, whole, String(whole.sk));
    seedMc(node, partial, String(partial.sk));

    const kids = await listMilestoneCardsPartition(node, cfg, "ms-a");
    expect(kids!.map((c) => c.slug).sort()).toEqual(["card-a", "card-b"]);
  });

  test("a row carrying a DIFFERENT layout is still denied — the guard keeps its job", async () => {
    const node = partialRowNode();
    seedMc(node, mcRow(), String(mcRow().sk));
    const foreign = mcRow({ slug: "not-ours", sk: milestoneCardSk("todo", "30", "not-ours"), position: "30", layout: "hashrange_v1_board_partition" });
    seedMc(node, foreign, String(foreign.sk));

    const kids = await listMilestoneCardsPartition(node, cfg, "ms-a");
    expect(kids!.map((c) => c.slug)).toEqual(["card-a"]);
  });

  test("identity comes from the range key when the payload copies did not", async () => {
    const node = partialRowNode();
    const sk = milestoneCardSk("done", "44", "recovered");
    const stripped = mcRow({ milestone: "ms-a" });
    delete stripped.slug;
    delete stripped.column;
    delete stripped.position;
    delete stripped.layout;
    seedMc(node, stripped, sk);

    const kids = await listMilestoneCardsPartition(node, cfg, "ms-a");
    expect(kids!.length).toBe(1);
    expect(kids![0]).toMatchObject({ slug: "recovered", column: "done", position: "44" });
  });
});

describe("MilestoneCards: the purge deletes the row's real address", () => {
  test("an orphan whose `layout` and `sk` copies are gone is still purged", async () => {
    const node = partialRowNode();
    const keepSk = milestoneCardSk("done", "90", "card-a");
    const staleSk = milestoneCardSk("backlog", "10", "card-a");
    seedMc(node, mcRow({ sk: keepSk, column: "done", position: "90" }), keepSk);
    const stale = mcRow({ column: "backlog", position: "10" });
    delete stale.layout;
    delete stale.sk;
    seedMc(node, stale, staleSk);

    const n = await purgeOtherMilestoneCardRows(node, cfg, "ms-a", "card-a", keepSk);

    expect(n).toBe(1);
    const left = node.rowsOf(MC_HASH).map((r) => r.rangeKey);
    expect(left).toEqual([keepSk]);
  });

  test("the kept row is never deleted, even when its own copies are missing", async () => {
    const node = partialRowNode();
    const keepSk = milestoneCardSk("todo", "10", "card-a");
    const kept = mcRow();
    delete kept.column;
    delete kept.position;
    seedMc(node, kept, keepSk);

    const n = await purgeOtherMilestoneCardRows(node, cfg, "ms-a", "card-a", keepSk);

    expect(n).toBe(0);
    expect(node.rowsOf(MC_HASH).map((r) => r.rangeKey)).toEqual([keepSk]);
  });

  /**
   * The row shape that made the purge need its own read.
   *
   * On the live primary exactly ONE field drops rows from this index: the
   * partition key `milestone` (56 -> 49 in the probed partition, 2026-08-01).
   * `listMilestoneCardsPartition` used to project all 24 fields, `milestone`
   * among them — so those rows were invisible to it, and a purge routed through
   * it could not delete an orphan it could not see. The spine read omits the
   * partition key precisely so that it can.
   *
   * Since 2026-08-04 the display read omits it too
   * (`MILESTONE_CARDS_PAYLOAD_FIELDS`), so the row is visible to both and the
   * precondition below asserts that rather than the old blindness. What the
   * test is FOR is unchanged: the purge addresses rows by their real range key,
   * and must delete this one whether or not any display read can see it.
   */
  test("an orphan missing the partition-key atom is visible to the display read and purged by address", async () => {
    const node = fakeNode({ baseUrl: cfg.nodeUrl, userHash: cfg.userHash });
    const keepSk = milestoneCardSk("done", "90", "card-a");
    const staleSk = milestoneCardSk("backlog", "10", "card-a");
    seedMc(node, mcRow({ sk: keepSk, column: "done", position: "90" }), keepSk);
    const stale = mcRow({ column: "backlog", position: "10" });
    delete stale.milestone;
    seedMc(node, stale, staleSk);

    // Precondition: the display read now reaches both rows, including the one
    // whose partition-key copy is gone.
    const visible = await listMilestoneCardsPartition(node, cfg, "ms-a");
    expect(visible!.length).toBe(2);
    expect(visible!.every((c) => c.milestone === "ms-a")).toBe(true);

    const n = await purgeOtherMilestoneCardRows(node, cfg, "ms-a", "card-a", keepSk);

    expect(n).toBe(1);
    expect(node.rowsOf(MC_HASH).map((r) => r.rangeKey)).toEqual([keepSk]);
  });

  test("the spine read does not project the partition key", async () => {
    const node = partialRowNode();
    seedMc(node, mcRow(), String(mcRow().sk));

    await listMilestoneCardsPartitionSpine(node, cfg, "ms-a");

    const read = node.reads.filter((r) => r.schemaHash === MC_HASH).at(-1);
    expect(read!.fields).not.toContain("milestone");
  });
});

describe("BoardMilestones: same rule, same index family", () => {
  function bmRow(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      board: "default",
      sk: boardMilestoneSk("active", "10", "ms-a"),
      slug: "ms-a",
      title: "MS A",
      body: "",
      state: "active",
      position: "10",
      north_star: "",
      driver: "",
      deps: [],
      proof_card: "",
      proof_status: "pending",
      block_reason: "",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      layout: BOARD_MILESTONES_LAYOUT,
      ...over,
    };
  }

  test("a milestone whose `layout` did not come back still appears on the board", async () => {
    const node = partialRowNode();
    const whole = bmRow();
    const partial = bmRow({ slug: "ms-b", sk: boardMilestoneSk("planned", "20", "ms-b"), state: "planned", position: "20" });
    delete partial.layout;
    node.seed({ schemaHash: BM_HASH, keyHash: "default", rangeKey: String(whole.sk), fields: whole });
    node.seed({ schemaHash: BM_HASH, keyHash: "default", rangeKey: String(partial.sk), fields: partial });

    const part = await listBoardMilestonesPartition(node, cfg, "default");
    expect(part!.map((m) => m.slug).sort()).toEqual(["ms-a", "ms-b"]);
  });

  test("`completed_at` is never written and must not empty the read", async () => {
    const node = partialRowNode();
    const row = bmRow();
    delete row.completed_at;
    node.seed({ schemaHash: BM_HASH, keyHash: "default", rangeKey: String(row.sk), fields: row });

    const part = await listBoardMilestonesPartition(node, cfg, "default");
    expect(part!.map((m) => m.slug)).toEqual(["ms-a"]);
  });

  test("the purge deletes the stale row at its real range key", async () => {
    const node = partialRowNode();
    const keepSk = boardMilestoneSk("complete", "90", "ms-a");
    const staleSk = boardMilestoneSk("active", "10", "ms-a");
    node.seed({ schemaHash: BM_HASH, keyHash: "default", rangeKey: keepSk, fields: bmRow({ sk: keepSk, state: "complete", position: "90" }) });
    const stale = bmRow();
    delete stale.layout;
    delete stale.state;
    node.seed({ schemaHash: BM_HASH, keyHash: "default", rangeKey: staleSk, fields: stale });

    const n = await purgeOtherBoardMilestoneRows(node, cfg, "default", "ms-a", keepSk);

    expect(n).toBe(1);
    expect(node.rowsOf(BM_HASH).map((r) => r.rangeKey)).toEqual([keepSk]);
  });

  test("the spine recovers state and position from the address", async () => {
    const node = partialRowNode();
    const sk = boardMilestoneSk("proving", "77", "ms-c");
    const row = bmRow({ slug: "ms-c", sk });
    delete row.state;
    delete row.position;
    delete row.slug;
    node.seed({ schemaHash: BM_HASH, keyHash: "default", rangeKey: sk, fields: row });

    const spine = await listBoardMilestonesPartitionSpine(node, cfg, "default");
    expect(spine![0]).toMatchObject({ slug: "ms-c", state: "proving", position: "77" });
  });
});
