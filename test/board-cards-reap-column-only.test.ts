// `groom board-cards-reap-column-only` deletes, by exact key, the BoardCards
// rows only a column read returns — and nothing else.
//
// Live shape (2026-09-23, papercut-lastdb-boardcards-default-partition-column-only-rows-20260923):
// the `default` partition held 290 rows with a `slug` atom and no `board`/`sk`
// atom, all for cards that no longer exist. LastDB takes a HashRange row spine
// from the key field (`board`) and falls back to the projected field only when
// that spine is empty in the range, so `HashKey{default}` never returns the
// residue and `HashRangePrefix{default,"todo#"}` (a column with no live card)
// does. The fixture below reproduces that read rule on the fake node.

import { describe, expect, test } from "bun:test";

import { fakeNode, type FakeNode } from "./fake-node.ts";
import type { Config } from "../src/config.ts";
import type { QueryFilter } from "../src/client.ts";
import { boardCardsReapColumnOnlyResult } from "../src/commands/board_cards_reap_column_only.ts";
import {
  boardToFields,
  cardToFields,
  milestoneToFields,
  nowIso,
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

function fixture(): Fixture {
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
  return { node: withKeyFieldSpine(node), live, residue, cardStillExists, milestoneRow };
}

function boardCardSks(node: FakeNode): string[] {
  return node.rowsOf("boardcardshash").map((r) => r.rangeKey ?? "").sort();
}

describe("groom board-cards-reap-column-only", () => {
  test("fixture reproduces the live divergence: residue is column-only", async () => {
    const f = fixture();
    const { report } = await boardCardsReapColumnOnlyResult({ cfg, node: f.node, board: BOARD });
    const b = report.boards[0]!;
    expect(b.failed).toBeNull();
    expect(b.whole_only).toEqual([]);
    expect(b.column_only).toBe(f.residue.length + 2);
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
});
