// `groom board-cards-reap-column-only` deletes BoardCards residue by exact key.
//
// Live shape (2026-09-23, papercut-lastdb-boardcards-default-partition-column-only-rows-20260923):
// the `default` partition held 290 rows with a `slug` atom and no `board`/`sk`
// atom, all for cards that no longer exist.
//
// Two node behaviours, both fixtures below:
//
//  - Before fold #2175 the key spine does not fall back while it is non-empty.
//    `HashKey{default}` never returns the residue. A column read of an empty
//    column does. `withKeyFieldSpine` models that: every whole-partition read
//    drops rows that have no `board` atom.
//  - Fold #2175 merges the key spine with the first projected non-key field.
//    A `[slug]` read returns the residue. A `[board]` read has no merge field
//    and does not. The plain fake already gates a one-field read on that
//    field, which is this rule for those two projections.

import { describe, expect, test } from "bun:test";

import { fakeNode, type FakeNode } from "./fake-node.ts";
import type { Config } from "../src/config.ts";
import type { QueryFilter } from "../src/client.ts";
import {
  boardCardsReapColumnOnlyCmd,
  boardCardsReapColumnOnlyResult,
  type BoardCardsReapColumnOnlyReport,
} from "../src/commands/board_cards_reap_column_only.ts";
import { boardCardsHealResult } from "../src/commands/board_cards_heal.ts";
import {
  boardToFields,
  cardToFields,
  listCardsByColumn,
  listCardsOnBoard,
  milestoneToFields,
  nowIso,
  CARD_LIST_FIELDS,
  type Card,
  type Milestone,
} from "../src/record.ts";
import { boardCardFieldsFromCard, boardCardSk } from "../src/board-cards.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: {
    card: "cardhash",
    board: "boardhash",
    board_cards: "boardcardshash",
    milestone: "milestonehash",
  },
};

const BOARD = "default";

function card(slug: string, column: string, position: string): Card {
  const now = nowIso();
  return {
    slug,
    title: slug,
    body: "",
    board: BOARD,
    column,
    position,
    assignee: "",
    tags: [],
    deps: [],
    surfaces: [],
    created_at: now,
    updated_at: now,
    done_at: "",
    first_doing_at: "",
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

function isWholeRead(filter: QueryFilter | undefined): boolean {
  return typeof (filter as Record<string, unknown> | undefined)?.HashKey === "string";
}

/**
 * The LastDB spine rule as the fake node's BoardCards read: a whole-partition
 * read drops every row with no `board` atom (the key-field spine is not empty,
 * so there is no fallback). Column reads return what the fake stores.
 */
function withKeyFieldSpine(node: FakeNode): FakeNode {
  const real = node.queryAll.bind(node);
  node.queryAll = async (req) => {
    const res = await real(req);
    if (req.schemaHash !== "boardcardshash" || !isWholeRead(req.filter)) return res;
    const hasBoardAtom = new Set(
      node
        .rowsOf("boardcardshash")
        .filter((r) => typeof r.fields.board === "string" && r.fields.board.length > 0)
        .map((r) => r.rangeKey),
    );
    return { ...res, results: res.results.filter((r) => hasBoardAtom.has(r.key?.range ?? null)) };
  };
  return node;
}

type Fixture = {
  node: FakeNode;
  live: string[];
  residue: string[];
  cardStillExists: string;
  milestoneRow: string;
};

function fixture(mode: "fallback" | "merge" = "fallback"): Fixture {
  const node = fakeNode();
  const now = nowIso();
  node.seed({
    schemaHash: "boardhash",
    keyHash: BOARD,
    fields: boardToFields({
      slug: BOARD,
      title: BOARD,
      body: "",
      // `active` is a milestone state; the live `default` board probes it because
      // milestone rows are visible on the whole read there.
      columns: [...DEFAULT_COLUMNS, "active"],
      created_at: now,
      updated_at: now,
    }),
  });
  const live: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const c = card(`live-${i}`, "done", `100${i}`);
    node.seed({ schemaHash: "cardhash", keyHash: c.slug, fields: cardToFields(c) });
    const sk = boardCardSk(c.column, c.position, c.slug);
    node.seed({ schemaHash: "boardcardshash", keyHash: BOARD, rangeKey: sk, fields: boardCardFieldsFromCard(c) });
    live.push(sk);
  }
  // Residue: slug atom only, for cards that no longer exist. Two rows share one
  // deleted slug (the live data had ~8 rows per slug).
  const residue = [
    boardCardSk("todo", "1786649926126", "gone-a"),
    boardCardSk("todo", "1786649926999", "gone-a"),
    boardCardSk("doing", "00000007", "gone-b"),
  ];
  for (const sk of residue) {
    const slug = sk.split("#").at(-1)!;
    node.seed({ schemaHash: "boardcardshash", keyHash: BOARD, rangeKey: sk, fields: { slug } });
  }
  // A column-only row whose card DOES exist: never deleted.
  const alive = card("still-here", "backlog", "00000001");
  node.seed({ schemaHash: "cardhash", keyHash: alive.slug, fields: cardToFields(alive) });
  const cardStillExists = boardCardSk("todo", "00000009", alive.slug);
  node.seed({ schemaHash: "boardcardshash", keyHash: BOARD, rangeKey: cardStillExists, fields: { slug: alive.slug } });
  // A milestone membership row on a milestone-state column: no Card, but a
  // Milestone record — never deleted.
  const m: Milestone = {
    slug: "ms-one",
    title: "ms-one",
    body: "",
    board: BOARD,
    state: "active",
    position: "1",
    north_star: "",
    driver: "",
    deps: [],
    proof_card: "",
    proof_status: "",
    block_reason: "",
    created_at: now,
    updated_at: now,
    completed_at: "",
  };
  node.seed({ schemaHash: "milestonehash", keyHash: m.slug, fields: milestoneToFields(m) });
  const milestoneRow = boardCardSk("active", "00000001", m.slug);
  node.seed({ schemaHash: "boardcardshash", keyHash: BOARD, rangeKey: milestoneRow, fields: { slug: m.slug } });
  return {
    node: mode === "fallback" ? withKeyFieldSpine(node) : node,
    live,
    residue,
    cardStillExists,
    milestoneRow,
  };
}

function boardCardSks(node: FakeNode): string[] {
  return node.rowsOf("boardcardshash").map((r) => r.rangeKey ?? "").sort();
}

type ReadReq = { schemaHash: string; fields: string[]; filter?: QueryFilter };

/**
 * The delete runs, then the residue is put back, and later reads that
 * `fail` matches throw. The plan reads happen before the delete, so they
 * still see the residue. The read-back does not.
 */
function failReadBackAfterDelete(f: Fixture, fail: (req: ReadReq) => boolean): void {
  let applyStarted = false;
  const realQuery = f.node.queryAll.bind(f.node);
  const realDelete = f.node.deleteRecords?.bind(f.node);
  if (!realDelete) throw new Error("fake node has no deleteRecords");
  f.node.deleteRecords = async (rows) => {
    applyStarted = true;
    await realDelete(rows);
    for (const sk of f.residue) {
      const slug = sk.split("#").at(-1)!;
      f.node.seed({ schemaHash: "boardcardshash", keyHash: BOARD, rangeKey: sk, fields: { slug } });
    }
  };
  f.node.queryAll = async (req) => {
    if (applyStarted && fail(req)) throw new Error("read-back detector failed");
    return realQuery(req);
  };
}

function isBoardLead(req: ReadReq): boolean {
  const filter = req.filter as Record<string, unknown> | undefined;
  return req.schemaHash === "boardcardshash"
    && req.fields.length === 1
    && req.fields[0] === "board"
    && typeof filter?.HashKey === "string";
}

function isColumnProbe(req: ReadReq): boolean {
  const filter = req.filter as Record<string, unknown> | undefined;
  return req.schemaHash === "boardcardshash" && filter?.HashRangePrefix != null;
}

describe("groom board-cards-reap-column-only", () => {
  test("fixture reproduces the live divergence: residue is column-only", async () => {
    const f = fixture();
    const { report } = await boardCardsReapColumnOnlyResult({ cfg, node: f.node, board: BOARD });
    const b = report.boards[0]!;
    expect(b.failed).toBeNull();
    expect(b.whole_only).toEqual([]);
    expect(b.column_only).toBe(f.residue.length + 2);
    // The key-spine diff is empty: the whole-partition read never returns residue.
    expect(b.missing_key).toBe(0);
  });

  test("dry run lists the exact keys and writes nothing", async () => {
    const f = fixture();
    const before = boardCardSks(f.node);
    const { text, report } = await boardCardsReapColumnOnlyResult({ cfg, node: f.node, board: BOARD });

    expect(report.dryRun).toBe(true);
    expect(report.would_delete).toBe(f.residue.length);
    expect(report.deleted).toBe(0);
    expect(report.boards[0]!.reap.map((r) => r.sk).sort()).toEqual([...f.residue].sort());
    for (const sk of f.residue) expect(text).toContain(`would-delete board=${BOARD} sk=${sk}`);
    expect(f.node.writes.filter((w) => w.op === "delete")).toEqual([]);
    expect(boardCardSks(f.node)).toEqual(before);
  });

  test("rows whose card or milestone exists are kept with a reason", async () => {
    const f = fixture();
    const { report } = await boardCardsReapColumnOnlyResult({ cfg, node: f.node, board: BOARD });
    const kept = new Map(report.boards[0]!.kept.map((k) => [k.sk, k.reason]));
    expect(kept.get(f.cardStillExists)).toBe("card-exists");
    expect(kept.get(f.milestoneRow)).toBe("milestone-exists");
  });

  test("apply deletes only the residue, by exact key, and the reads then agree", async () => {
    const f = fixture();
    const { report } = await boardCardsReapColumnOnlyResult({
      cfg,
      node: f.node,
      board: BOARD,
      apply: true,
      readBackSleep: async () => {},
    });

    expect(report.dryRun).toBe(false);
    expect(report.deleted).toBe(f.residue.length);
    expect(report.still_visible).toBe(0);
    expect(report.read_back_unproven).toBe(0);
    const deletes = f.node.writes.filter((w) => w.op === "delete");
    expect(deletes.map((w) => w.rangeKey).sort()).toEqual([...f.residue].sort());
    for (const w of deletes) {
      expect(w.schemaHash).toBe("boardcardshash");
      expect(w.keyHash).toBe(BOARD);
    }
    const after = boardCardSks(f.node);
    for (const sk of f.residue) expect(after).not.toContain(sk);
    for (const sk of [...f.live, f.cardStillExists, f.milestoneRow]) expect(after).toContain(sk);

    // A second dry run finds nothing left to reap.
    const again = await boardCardsReapColumnOnlyResult({ cfg, node: f.node, board: BOARD });
    expect(again.report.would_delete).toBe(0);
  });

  test("a failing card read keeps the row", async () => {
    const f = fixture();
    const real = f.node.queryAll.bind(f.node);
    f.node.queryAll = async (req) => {
      if (req.schemaHash === "cardhash") throw new Error("node busy");
      return real(req);
    };
    const { report } = await boardCardsReapColumnOnlyResult({
      cfg,
      node: f.node,
      board: BOARD,
      apply: true,
      readBackSleep: async () => {},
    });
    expect(report.would_delete).toBe(0);
    expect(report.deleted).toBe(0);
    expect(report.boards[0]!.kept.every((k) => k.reason === "truth-read-failed")).toBe(true);
    expect(f.node.writes.filter((w) => w.op === "delete")).toEqual([]);
  });

  test("a failed column read-back is not proof the reaped key is gone", async () => {
    const f = fixture();
    failReadBackAfterDelete(f, isColumnProbe);
    const { output, exitCode } = await boardCardsReapColumnOnlyCmd({
      cfg,
      node: f.node,
      board: BOARD,
      apply: true,
      json: true,
      readBackSleep: async () => {},
    });
    const report = JSON.parse(output) as BoardCardsReapColumnOnlyReport;
    expect(exitCode).toBe(1);
    expect(report.deleted).toBe(f.residue.length);
    // The key-spine diff succeeds and stays empty on this node. That empty
    // set, plus the failed column detector's empty set, must not exit 0
    // while the residue is still stored.
    expect(report.still_visible).toBe(0);
    expect(report.read_back_unproven).toBe(f.residue.length);
    expect(report.boards[0]!.read_back_unproven?.sort()).toEqual([...f.residue].sort());
    expect(report.boards[0]!.read_back_failed ?? "").toContain("read-back detector failed");
    for (const sk of f.residue) expect(boardCardSks(f.node)).toContain(sk);
  });
});

describe("groom board-cards-reap-column-only under fold #2175", () => {
  test("the column-only set is empty and the key-spine diff lists the residue", async () => {
    const f = fixture("merge");
    const { text, report } = await boardCardsReapColumnOnlyResult({ cfg, node: f.node, board: BOARD });
    const b = report.boards[0]!;
    expect(b.failed).toBeNull();
    expect(b.whole_only).toEqual([]);
    expect(b.column_only).toBe(0);
    expect(b.missing_key).toBe(f.residue.length + 2);
    expect(report.dryRun).toBe(true);
    expect(report.would_delete).toBe(f.residue.length);
    expect(report.deleted).toBe(0);
    expect(b.reap.map((r) => r.sk).sort()).toEqual([...f.residue].sort());
    for (const sk of f.residue) expect(text).toContain(`would-delete board=${BOARD} sk=${sk}`);
    expect(f.node.writes.filter((w) => w.op === "delete")).toEqual([]);
  });

  test("rows whose card or milestone exists are kept", async () => {
    const f = fixture("merge");
    const { report } = await boardCardsReapColumnOnlyResult({ cfg, node: f.node, board: BOARD });
    const kept = new Map(report.boards[0]!.kept.map((k) => [k.sk, k.reason]));
    expect(kept.get(f.cardStillExists)).toBe("card-exists");
    expect(kept.get(f.milestoneRow)).toBe("milestone-exists");
  });

  test("apply deletes only the residue, by exact key", async () => {
    const f = fixture("merge");
    const { report } = await boardCardsReapColumnOnlyResult({
      cfg,
      node: f.node,
      board: BOARD,
      apply: true,
      readBackSleep: async () => {},
    });
    expect(report.deleted).toBe(f.residue.length);
    expect(report.still_visible).toBe(0);
    expect(report.read_back_unproven).toBe(0);
    const deletes = f.node.writes.filter((w) => w.op === "delete");
    expect(deletes.map((w) => w.rangeKey).sort()).toEqual([...f.residue].sort());
    const after = boardCardSks(f.node);
    for (const sk of f.residue) expect(after).not.toContain(sk);
    for (const sk of [...f.live, f.cardStillExists, f.milestoneRow]) expect(after).toContain(sk);
    const again = await boardCardsReapColumnOnlyResult({ cfg, node: f.node, board: BOARD });
    expect(again.report.would_delete).toBe(0);
    expect(again.report.boards[0]!.missing_key).toBe(2);
  });

  test("a failed key-spine read-back is not proof the reaped key is gone", async () => {
    const f = fixture("merge");
    failReadBackAfterDelete(f, isBoardLead);
    const { output, exitCode } = await boardCardsReapColumnOnlyCmd({
      cfg,
      node: f.node,
      board: BOARD,
      apply: true,
      json: true,
      readBackSleep: async () => {},
    });
    const report = JSON.parse(output) as BoardCardsReapColumnOnlyReport;
    expect(exitCode).toBe(1);
    expect(report.deleted).toBe(f.residue.length);
    // Fold #2175: the column-only set stays empty while the residue remains.
    // The failed key-spine diff must not become that same empty set.
    expect(report.boards[0]!.column_only).toBe(0);
    expect(report.still_visible).toBe(0);
    expect(report.read_back_unproven).toBe(f.residue.length);
    expect(report.boards[0]!.read_back_unproven?.sort()).toEqual([...f.residue].sort());
    expect(report.boards[0]!.read_back_failed ?? "").toContain("key-spine diff");
    for (const sk of f.residue) expect(boardCardSks(f.node)).toContain(sk);

    const shown = fixture("merge");
    failReadBackAfterDelete(shown, isBoardLead);
    const { text } = await boardCardsReapColumnOnlyResult({
      cfg,
      node: shown.node,
      board: BOARD,
      apply: true,
      readBackSleep: async () => {},
    });
    expect(text).toContain(`${shown.residue.length} unproven after a failed read-back`);
    expect(text).toContain("read-back unproven, repair not confirmed");
    for (const sk of shown.residue) expect(text).toContain(`read-back-unproven board=${BOARD} sk=${sk}`);
  });
});

describe("kanban list drops a row that has no board atom", () => {
  test("a scoped read that returns residue does not render it", async () => {
    // `dropIncompleteRows: false` is the fold #2175 client view: the node
    // returns a row that has no `board` atom. The list projection leads with
    // `board`, so the atom's absence is visible and the row is not a card.
    const node = fakeNode({ dropIncompleteRows: false });
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
    const live = card("live-card", "todo", "00000001");
    node.seed({
      schemaHash: "boardcardshash",
      keyHash: BOARD,
      rangeKey: boardCardSk(live.column, live.position, live.slug),
      fields: boardCardFieldsFromCard(live),
    });
    const ghostSk = boardCardSk("todo", "00000002", "ghost-card");
    node.seed({
      schemaHash: "boardcardshash",
      keyHash: BOARD,
      rangeKey: ghostSk,
      fields: { slug: "ghost-card" },
    });

    const onBoard = await listCardsOnBoard(node, cfg, BOARD, CARD_LIST_FIELDS);
    expect(onBoard.map((c) => c.slug)).toEqual(["live-card"]);
    const column = await listCardsByColumn(node, cfg, "todo", CARD_LIST_FIELDS, BOARD);
    expect(column.map((c) => c.slug)).toEqual(["live-card"]);
  });
});

describe("board-cards-heal reaps residue the merged spine makes visible", () => {
  test("a slug-only row with no card is delete-orphan and the partition is not refused", async () => {
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
    const live = card("live-card", "todo", "00000001");
    node.seed({ schemaHash: "cardhash", keyHash: live.slug, fields: cardToFields(live) });
    node.seed({
      schemaHash: "boardcardshash",
      keyHash: BOARD,
      rangeKey: boardCardSk(live.column, live.position, live.slug),
      fields: boardCardFieldsFromCard(live),
    });
    const ghostSk = boardCardSk("doing", "00000002", "ghost-card");
    node.seed({
      schemaHash: "boardcardshash",
      keyHash: BOARD,
      rangeKey: ghostSk,
      fields: { slug: "ghost-card" },
    });

    const { report } = await boardCardsHealResult({ cfg, node, board: BOARD, apply: true });
    expect(report.blocked).toBe(false);
    expect(report.read_divergence.some((d) => d.columnOnly.length > 0 || d.wholeOnly.length > 0)).toBe(false);
    expect(report.actions.some((a) => a.action === "delete-orphan" && a.slug === "ghost-card")).toBe(true);
    expect(node.rowsOf("boardcardshash").map((r) => r.rangeKey)).not.toContain(ghostSk);
    expect(node.rowsOf("boardcardshash").some((r) => r.fields.slug === "live-card")).toBe(true);
  });
});
