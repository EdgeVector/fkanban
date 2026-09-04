// heal must not write while the node is serving two different views of one
// partition.
//
// 2026-09-03T22:16-22:35Z, primary lastdbd 0.23.3-1536 with its footprint
// climbing toward the 16 GiB memory guard: `kanban list --column todo` returned
// 4 rows against a truth of 17, and `--column doing` returned 2 against 8. No
// error and no `truncated` flag — a short page that reads as a complete one. At
// the same moment the wide list read enumerated every card and `kanban show`
// read each one, and after the guard restarted the daemon the rows came back
// with no repair applied. A READ-path degradation, not lost writes.
//
// In that window the hourly `board-cards-heal --apply` believed the degraded
// view and printed `delete-stale-and-upsert` for seven LIVE todo cards, while
// leaving the two rows that really are ghosts in place. Wrong in both
// directions, from one run, on a board that was never damaged.
// See `papercut-kanban-board-cards-heal-deletes-live-rows-from-a-degraded-column-read-20260903`.
//
// The file's existing safety argument does not reach this. "A row heal cannot
// see is a row it cannot delete" is a statement about ABSENCE, and it is true:
// an incomplete read under-reaps. A read that returns a DIFFERENT SET is not
// absence — the live row is invisible while its stale sibling is not, so the
// card classifies as `stale` and the delete is authorized by evidence that is
// simply wrong. Under-reaping is safe; mis-reading is not.
//
// So heal now asks the same partition twice by two different node access paths
// — the whole partition (`HashKey`) and the union of its columns
// (`HashRangePrefix`) — which address exactly the same rows because every sk is
// `column#position#slug`. Disagreement in either direction refuses the apply.

import { describe, expect, test } from "bun:test";

import { fakeNode, type FakeNode } from "./fake-node.ts";
import type { Config } from "../src/config.ts";
import type { QueryFilter } from "../src/client.ts";
import { boardCardsHealResult } from "../src/commands/board_cards_heal.ts";
import { boardCardsHealScheduledResult } from "../src/commands/board_cards_heal_scheduled.ts";
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
const COLUMN = "todo";

function card(slug: string, position: string): Card {
  const now = nowIso();
  return {
    slug,
    title: slug,
    body: "",
    board: BOARD,
    column: COLUMN,
    position,
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
 * A healthy board: `count` live cards, each with Card truth AND the matching
 * BoardCards row. Nothing here is drifted, so any write at all is a defect.
 */
function healthyBoard(count: number): FakeNode {
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
  for (let i = 0; i < count; i += 1) {
    const c = card(`live-${i}`, `p${i}`);
    node.seed({ schemaHash: "cardhash", keyHash: c.slug, fields: cardToFields(c) });
    node.seed({
      schemaHash: "boardcardshash",
      keyHash: c.board,
      rangeKey: boardCardSk(c.column, c.position, c.slug),
      fields: boardCardFieldsFromCard(c),
    });
  }
  return node;
}

function isColumnRead(filter: QueryFilter | undefined): boolean {
  return typeof (filter as Record<string, unknown> | undefined)?.HashRangePrefix === "object";
}

function isWholeRead(filter: QueryFilter | undefined): boolean {
  return typeof (filter as Record<string, unknown> | undefined)?.HashKey === "string";
}

/**
 * The incident, reproduced: BoardCards column reads come back SHORT — no error,
 * no flag, just fewer rows — while every other read of the same partition is
 * complete.
 */
function withShortColumnPages(node: FakeNode, keep: number): FakeNode {
  const real = node.queryAll.bind(node);
  node.queryAll = async (req) => {
    const res = await real(req);
    if (req.schemaHash !== "boardcardshash" || !isColumnRead(req.filter)) return res;
    return { ...res, results: res.results.slice(0, keep) };
  };
  return node;
}

/** The other direction: the WHOLE-partition read is the short one. */
function withShortWholePage(node: FakeNode, keep: number): FakeNode {
  const real = node.queryAll.bind(node);
  let seen = 0;
  node.queryAll = async (req) => {
    const res = await real(req);
    if (req.schemaHash !== "boardcardshash" || !isWholeRead(req.filter)) return res;
    seen += 1;
    // Only the divergence probe's own whole read, so the enumeration heal
    // classifies from stays complete and the ONLY thing under test is whether
    // the disagreement is noticed.
    return seen === 1 ? res : { ...res, results: res.results.slice(0, keep) };
  };
  return node;
}

/** EVERY BoardCards read short, by the same amount — the uniform case. */
function withUniformlyShortReads(node: FakeNode, keep: number): FakeNode {
  const real = node.queryAll.bind(node);
  node.queryAll = async (req) => {
    const res = await real(req);
    if (req.schemaHash !== "boardcardshash") return res;
    return { ...res, results: res.results.slice(0, keep) };
  };
  return node;
}

/** A column read that FAILS outright — coverage, not disagreement. */
function withFailingColumnRead(node: FakeNode): FakeNode {
  const real = node.queryAll.bind(node);
  node.queryAll = async (req) => {
    if (req.schemaHash === "boardcardshash" && isColumnRead(req.filter)) {
      throw new Error("laststore: corrupt: empty rec");
    }
    return real(req);
  };
  return node;
}

describe("board-cards-heal refuses to write on divergent partition reads", () => {
  // NON-VACUITY. Every refusal below is meaningless if the same fixture without
  // the degradation also refuses, so prove the healthy path runs clean first.
  test("a node that agrees with itself reports no divergence and is not blocked", async () => {
    const node = healthyBoard(5);
    const { report } = await boardCardsHealResult({ cfg, node, board: BOARD, apply: true });

    expect(report.blocked).toBe(false);
    expect(report.blocked_reason).toBeUndefined();
    expect(report.read_divergence).toHaveLength(1);
    expect(report.read_divergence[0]!.board).toBe(BOARD);
    expect(report.read_divergence[0]!.wholeOnly).toEqual([]);
    expect(report.read_divergence[0]!.columnOnly).toEqual([]);
    expect(report.read_divergence[0]!.failed).toBeNull();
    // Every column the board declares is probed, not only the occupied one: a
    // column whose rows the whole read dropped entirely is exactly the shape of
    // the incident, and observed-columns-only cannot see it.
    expect(report.read_divergence[0]!.columnsProbed.sort()).toEqual([...DEFAULT_COLUMNS].sort());
  });

  test("short column pages block the apply and write nothing", async () => {
    const node = withShortColumnPages(healthyBoard(5), 2);
    const before = node.rowsOf("boardcardshash").length;

    const { report, text } = await boardCardsHealResult({ cfg, node, board: BOARD, apply: true });

    expect(report.blocked).toBe(true);
    expect(report.blocked_reason).toBe("read-divergence");
    expect(report.healed).toBe(0);
    expect(report.would_heal).toBe(0);
    expect(report.actions).toEqual([]);
    // 5 rows in the whole read, 2 in the column read: the 3 the column page
    // dropped are the disagreement.
    expect(report.read_divergence[0]!.wholeOnly).toHaveLength(3);
    expect(text).toContain("BLOCKED");
    // The board is untouched — no delete, no upsert, not even a "safe" one.
    expect(node.rowsOf("boardcardshash")).toHaveLength(before);
    expect(node.writes).toHaveLength(0);
    expect(node.deleteBatches.flat()).toHaveLength(0);
  });

  test("a short whole-partition page blocks it too — the check is symmetric", async () => {
    const node = withShortWholePage(healthyBoard(5), 2);

    const { report } = await boardCardsHealResult({ cfg, node, board: BOARD, apply: true });

    expect(report.blocked).toBe(true);
    expect(report.blocked_reason).toBe("read-divergence");
    expect(report.read_divergence[0]!.columnOnly).toHaveLength(3);
    expect(node.writes).toHaveLength(0);
  });

  test("a dry run reports the divergence instead of hiding it", async () => {
    const node = withShortColumnPages(healthyBoard(5), 2);

    const { report } = await boardCardsHealResult({ cfg, node, board: BOARD, apply: false });

    // Not blocked — a dry run writes nothing, so there is nothing to refuse —
    // but the signal has to be IN the dry report, because that is the report
    // the scheduled wrapper decides to apply from.
    expect(report.blocked).toBe(false);
    expect(report.read_divergence[0]!.wholeOnly).toHaveLength(3);
  });

  test("a column read that FAILS is coverage, not disagreement, and does not block", async () => {
    const node = withFailingColumnRead(healthyBoard(5));

    const { report } = await boardCardsHealResult({ cfg, node, board: BOARD, apply: true });

    // A read that throws leaves the comparison unproven. Reporting that as
    // divergence would refuse the apply on a signal that does not mean the node
    // is serving inconsistent pages — and heal already models missing coverage
    // as `incomplete_leads`, where an incomplete read can only under-reap.
    expect(report.read_divergence[0]!.failed).toContain("laststore: corrupt");
    expect(report.read_divergence[0]!.wholeOnly).toEqual([]);
    expect(report.blocked).toBe(false);
  });

  test("a UNIFORMLY short partition is not divergence, and issues no delete", async () => {
    // Pinning the boundary rather than leaving it implied. When every view
    // agrees, there is nothing to disagree about and the guard stays silent —
    // and it is correct that it does: a uniform short page cannot authorize a
    // wrong delete. `delete-orphan` needs the CARD to be absent, a different
    // plane and a different read; `delete-stale-and-upsert` needs a stale row to
    // be visible, and a row nobody returned is not. What is left is
    // `upsert-truth` for cards that already have a row: a redundant write of the
    // value already there.
    const node = withUniformlyShortReads(healthyBoard(5), 2);

    const { report } = await boardCardsHealResult({ cfg, node, board: BOARD, apply: true });

    expect(report.blocked).toBe(false);
    expect(report.read_divergence[0]!.wholeOnly).toEqual([]);
    expect(report.read_divergence[0]!.columnOnly).toEqual([]);
    expect(report.actions.some((a) => a.action.startsWith("delete-"))).toBe(false);
    expect(node.deleteBatches.flat()).toHaveLength(0);
    // The 3 rows the short pages hid are still on the board — under-reading
    // cost redundant writes, not membership.
    expect(node.rowsOf("boardcardshash")).toHaveLength(5);
  });
});

describe("the hourly scheduled heal stops before the apply", () => {
  test("divergence in the dry run means the apply run is never issued", async () => {
    const node = withShortColumnPages(healthyBoard(5), 2);
    const applyCalls: boolean[] = [];

    const { report, text } = await boardCardsHealScheduledResult({
      cfg,
      node,
      board: BOARD,
      heal: async (opts) => {
        applyCalls.push(opts.apply === true);
        return boardCardsHealResult(opts);
      },
    });

    expect(report.blocked).toBe(true);
    expect(report.applied).toBe(false);
    expect(report.reason).toBe("read-divergence");
    // The dry run, and nothing else. This wrapper is what
    // `last-stack-fkanban-watch` runs hourly.
    expect(applyCalls).toEqual([false]);
    expect(text).toContain("READ DIVERGENCE");
    // `drifted` is not a lower bound here — it is no bound at all — so the text
    // must not reuse the incomplete-coverage wording that says it is.
    expect(text).not.toContain("LOWER BOUND");
  });

  test("divergence outranks drifted=0: a run that saw two boards may not call one clean", async () => {
    // The healthy fixture drifts by nothing, so without the guard this run
    // reports `reason=clean` — the verdict `healWasIncomplete` exists to stop a
    // run making about a board it did not see. A run that saw two boards has
    // even less standing to pronounce on either.
    const node = withShortColumnPages(healthyBoard(5), 2);

    const { report } = await boardCardsHealScheduledResult({ cfg, node, board: BOARD });

    expect(report.drifted).toBe(0);
    expect(report.reason).toBe("read-divergence");
  });
});
