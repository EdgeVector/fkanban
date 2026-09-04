// `board-cards-heal --apply` must never leave a card with zero BoardCards
// membership.
//
// 2026-09-04T19:20-19:45Z, kanban-factory-manager: seven single-slug
// `--apply` runs, one card at a time, each classified `delete-stale-and-upsert`.
// All seven ended `kanban list` = (missing) while `kanban show` still returned
// `column=doing` for four of them. `kanban search` on an exact title returned
// no match. The plan-time read-divergence guard
// (`heal-refuses-divergent-partition-reads.test.ts`) did not fire on any of
// the seven runs — it is evaluated once, before the first write, and the
// partition read degraded some time after that.
//
// The two guards this file pins:
//
//   1. UPSERT — VERIFY — THEN enqueue the delete. A stale row's delete is
//      queued only once the replacement is confirmed visible through the same
//      search-shaped read `awaitBoardCardSearchVisible` already uses
//      elsewhere in this codebase (`createCardRecord` / `updateCardRecord`).
//      An upsert that acks but stays invisible leaves the stale row in place
//      instead of authorizing its removal.
//   2. Re-check partition/column agreement immediately before the delete
//      sweep, not only at plan time. A node that agreed with itself when heal
//      planned and disagrees with itself by the time heal is about to delete
//      must not have that delete run on the strength of the earlier, now-false
//      agreement.
//
// See papercut-kanban-board-cards-heal-apply-deletes-all-membership-and-the-upsert-never-lands-20260904.

import { describe, expect, test } from "bun:test";

import { fakeNode, type FakeNode } from "./fake-node.ts";
import type { Config } from "../src/config.ts";
import type { QueryFilter } from "../src/client.ts";
import { boardCardsHealResult } from "../src/commands/board_cards_heal.ts";
import { boardToFields, nowIso, cardToFields, type Card } from "../src/record.ts";
import { boardCardFieldsFromCard, boardCardSk } from "../src/board-cards.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash", board_cards: "boardcardshash" },
};

const BOARD = "default";
const SLUG = "drifted-card";
const TRUE_COLUMN = "doing";
const STALE_COLUMN = "todo";
const POSITION = "p1";

function truthCard(): Card {
  const now = nowIso();
  return {
    slug: SLUG,
    title: SLUG,
    body: "",
    board: BOARD,
    column: TRUE_COLUMN,
    position: POSITION,
    assignee: "",
    tags: [],
    deps: [],
    surfaces: [],
    created_at: now,
    updated_at: now,
    done_at: "",
    db: "",
    kind: "pr",
    priority: "",
    block_status: "none",
    block_reason: "",
    north_star: "",
    milestone: "",
    repo: "EdgeVector/fkanban",
    base: "main",
    pr_url: "",
    branch: "",
    created_by: "test",
  } as Card;
}

/**
 * A board with one card whose Card truth says `doing`, but whose only
 * BoardCards row is still at the stale `todo` sk — the `delete-stale-and-upsert`
 * shape.
 */
function boardWithDriftedCard(): FakeNode {
  const node = fakeNode();
  const now = nowIso();
  node.seed({
    schemaHash: "boardhash",
    keyHash: BOARD,
    fields: boardToFields({
      slug: BOARD,
      title: BOARD,
      body: "",
      columns: [...DEFAULT_COLUMNS],
      created_at: now,
      updated_at: now,
    }),
  });
  const truth = truthCard();
  node.seed({ schemaHash: "cardhash", keyHash: SLUG, fields: cardToFields(truth) });
  const stale = { ...truth, column: STALE_COLUMN };
  node.seed({
    schemaHash: "boardcardshash",
    keyHash: BOARD,
    rangeKey: boardCardSk(STALE_COLUMN, POSITION, SLUG),
    fields: boardCardFieldsFromCard(stale),
  });
  return node;
}

function isColumnRead(filter: QueryFilter | undefined): boolean {
  return typeof (filter as Record<string, unknown> | undefined)?.HashRangePrefix === "object";
}

const noSleep = { visibilitySleep: async () => {} };

describe("board-cards-heal: upsert-then-verify-then-delete", () => {
  test("non-vacuity: the fixture drives delete-stale-and-upsert on a healthy node", async () => {
    const node = boardWithDriftedCard();
    const { report } = await boardCardsHealResult({ cfg, node, board: BOARD, apply: true, ...noSleep });

    expect(report.actions.some((a) => a.action === "delete-stale-and-upsert")).toBe(true);
    expect(report.unverified_upserts ?? 0).toBe(0);
    expect(report.delete_sweep_skipped ?? false).toBe(false);
    const rows = node.rowsOf("boardcardshash");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fields.column).toBe(TRUE_COLUMN);
  });

  test("an upsert that never becomes search-visible leaves the stale row in place", async () => {
    const node = boardWithDriftedCard();
    // The write acks (it lands in the store) but no search-shaped read of the
    // partition is ever allowed to see it — the silent-write-not-durable shape
    // the incident describes ("the upsert is written ... and reads back
    // nothing").
    const real = node.queryAll.bind(node);
    node.queryAll = async (req) => {
      const res = await real(req);
      if (req.schemaHash !== "boardcardshash") return res;
      if (isColumnRead(req.filter)) return res;
      // Whole-partition / HashKey reads: hide the newly-written truth row from
      // every such read, as if it were durable-but-unreadable.
      return { ...res, results: res.results.filter((r) => r.key?.range !== boardCardSk(TRUE_COLUMN, POSITION, SLUG)) };
    };

    const { report } = await boardCardsHealResult({ cfg, node, board: BOARD, apply: true, ...noSleep });

    expect(report.unverified_upserts).toBe(1);
    // The delete must not have run: the stale row is still there.
    const staleSk = boardCardSk(STALE_COLUMN, POSITION, SLUG);
    expect(node.rowsOf("boardcardshash").some((r) => r.rangeKey === staleSk)).toBe(true);
    // A live card never reads as having zero membership rows on this board.
    expect(node.rowsOf("boardcardshash").length).toBeGreaterThan(0);
  });

  test("divergence appearing between plan and delete-sweep skips the sweep, not just the plan", async () => {
    const node = boardWithDriftedCard();
    let writeHappened = false;
    const real = node.queryAll.bind(node);
    node.queryAll = async (req) => {
      const res = await real(req);
      if (!writeHappened && node.writes.length > 0) writeHappened = true;
      if (!writeHappened) return res;
      if (req.schemaHash !== "boardcardshash" || !isColumnRead(req.filter)) return res;
      // After the write lands, column-shaped reads of the partition go short —
      // the plan-time check (before any write) saw an agreeing view; the
      // pre-delete-sweep recheck must not.
      return { ...res, results: [] };
    };

    const { report } = await boardCardsHealResult({ cfg, node, board: BOARD, apply: true, ...noSleep });

    expect(report.blocked).toBe(false);
    expect(report.delete_sweep_skipped).toBe(true);
    // The upsert still landed — this run is not required to undo a write it
    // already safely made.
    const rows = node.rowsOf("boardcardshash");
    expect(rows.some((r) => r.fields.column === TRUE_COLUMN)).toBe(true);
    // But the stale row's delete never ran — a card is never reduced to zero
    // membership on the strength of a plan later shown to be wrong.
    const staleSk = boardCardSk(STALE_COLUMN, POSITION, SLUG);
    expect(rows.some((r) => r.rangeKey === staleSk)).toBe(true);
  });
});
