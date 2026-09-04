// A repair that already holds the partition may not re-read it once per row.
//
// `board_cards_heal` enumerates each target partition end to end (a wide read
// plus a spine read) and groups every BoardCards row by `board\0slug`. From
// that point on, `rows` for a key IS every row that slug has on that partition
// — the file says so at `enumeratedBoards`: "Only for these can heal claim to
// know every row for a slug and skip the per-write orphan rescan."
//
// The delete-stale-and-upsert branch acts on that claim and passes
// `skipOrphanPurge`. The delete-orphan branch — same loop, same `rows`, same
// partition — did not, so `removeBoardCard` fell through to
// `purgeOtherBoardCardRows`, which lists the WHOLE partition to look for other
// sks carrying the slug. Once per orphan row reaped.
//
// Measured on the live `default` partition 2026-08-01: 340 rows, 448KB,
// 352-638ms per scan. The 2026-07-31 spine fix reaped 18 orphans in one pass,
// so that run paid ~8MB and several seconds re-reading rows it already had.
//
// And on THIS branch the rescan cannot even do the job it is there for. It
// lists at `BOARD_CARDS_SPINE_FIELDS`, and a projected read drops any row
// missing an atom for a projected field — which is exactly what a sparse
// orphan is, and exactly why heal needed a separate spine pass to see these
// rows at all (18 of the 19 rows the old spine dropped were Card-less
// orphans). So it scans a whole partition, per row, hunting for rows it is
// structurally unable to return.
//
// The invariant pinned here is the one that cannot go stale as heal's fixed
// overhead changes: partition reads are INDEPENDENT of how many orphans are
// reaped. Under the bug this file fails 7 != 3.

import { describe, expect, test } from "bun:test";

import { fakeNode, type FakeNode } from "./fake-node.ts";
import type { Config } from "../src/config.ts";
import { boardCardsHealResult } from "../src/commands/board_cards_heal.ts";
import { boardToFields, nowIso, type Card } from "../src/record.ts";
import { boardCardFieldsFromCard, boardCardSk } from "../src/board-cards.ts";
import { BOARD_CARDS_FIELDS, DEFAULT_COLUMNS } from "../src/schemas.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash", board_cards: "boardcardshash" },
};

const BOARD = "default";

function orphanCard(slug: string, position: string): Card {
  const now = nowIso();
  return {
    slug,
    title: slug,
    body: "",
    board: BOARD,
    column: "done",
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
 * A board with `count` BoardCards rows and NO Card record behind any of them —
 * the orphan shape. Card truth is deliberately never seeded, so both the wide
 * point-read and `cardExists` miss and heal takes the delete-orphan branch.
 */
function boardWithOrphans(count: number): FakeNode {
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
    const c = orphanCard(`orphan-${i}`, `p${i}`);
    node.seed({
      schemaHash: "boardcardshash",
      keyHash: c.board,
      rangeKey: boardCardSk(c.column, c.position, c.slug),
      fields: boardCardFieldsFromCard(c),
    });
  }
  return node;
}

/** Whole-partition reads of BoardCards — the scan a per-row purge adds. */
function partitionReads(node: FakeNode): number {
  return node.reads.filter(
    (r) =>
      r.schemaHash === "boardcardshash" &&
      typeof (r.filter as Record<string, unknown> | undefined)?.HashKey === "string",
  ).length;
}

async function healApply(node: FakeNode) {
  return boardCardsHealResult({ cfg, node, board: BOARD, json: true, apply: true });
}

describe("board-cards-heal: reaping orphans must not re-read the partition per row", () => {
  // NON-VACUITY. Everything below is meaningless if the fixture does not
  // actually drive the delete-orphan branch, so prove it does first.
  test("the fixture reaps orphans through the delete-orphan branch", async () => {
    const node = boardWithOrphans(5);
    const { report } = await healApply(node);

    expect(report.missing_card).toBe(5);
    expect(report.healed).toBe(5);
    expect(report.actions.every((a) => a.action === "delete-orphan")).toBe(true);
    // And the rows are really gone — the fix must not buy cheapness by
    // skipping the delete itself.
    expect(node.rowsOf("boardcardshash")).toHaveLength(0);
  });

  test("partition reads do not scale with the number of orphans reaped", async () => {
    const one = boardWithOrphans(1);
    const many = boardWithOrphans(5);

    await healApply(one);
    await healApply(many);

    // Heal's fixed cost is per-BOARD (a wide enumeration + a spine census),
    // not per-row. Asserting equality rather than an absolute budget keeps
    // this test honest if that fixed cost legitimately changes.
    expect(partitionReads(many)).toBe(partitionReads(one));
  });

  test("reaping 5 orphans costs no more partition reads than the board census", async () => {
    const node = boardWithOrphans(5);
    await healApply(node);

    // Belt-and-braces absolute bound: whatever the census costs, five reaped
    // rows must not add five scans on top of it.
    //
    // The census is a wide read plus one read per BoardCards field, plus the
    // read-divergence probe's whole-partition read. The per-field half is the
    // completeness sweep — a projection filters on its LEADING field, so no
    // single read can enumerate a partition and the union over leads is what
    // replaced the spine here (see `listBoardCardsPartitionComplete`). The
    // extra `1` is `readBoardCardsPartitionDivergence`, which reads the whole
    // partition once and then once per COLUMN by range prefix; only the first
    // is a `HashKey` read, so only the first is counted by `partitionReads`
    // above. Derived from the field list, so the bound tracks the schema
    // instead of drifting into a magic number, and the thing being asserted
    // stays "nothing scales with ORPHANS".
    expect(partitionReads(node)).toBeLessThanOrEqual(1 + BOARD_CARDS_FIELDS.length + 1);
  });
});
