// `doctor`'s two milestone parity checks must compare the wide read against a
// COMPLETE enumeration, not against another projection.
//
// A query returns a row only if the field LEADING the projection has an atom on
// it. Both milestone parity checks used a one-field `slug` spine as their
// baseline, so a row carrying neither `slug` nor the partition's hash field was
// missing from BOTH sides of the subtraction — it netted to zero and the check
// printed a green line. That is the same blind spot the BoardCards check was
// rewritten to remove, left standing on the two indexes whose loss is hardest
// to notice.
//
// It was left standing on a COST estimate — "~780ms per partition … an 8s
// doctor becomes 40s" — carried from the BoardCards `default` partition and
// never measured on either milestone index. Measured on the live primary
// 2026-08-04 (`scripts/probe-milestone-parity-baseline-cost.ts`):
// BoardMilestones 201ms → 584ms (2.9x), MilestoneCards 554ms → 1787ms (3.2x).
//
// The tests below fail against the spine-based baseline: the sparse row is
// invisible, so parity reports clean.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { fakeNode, type FakeNode } from "./fake-node.ts";
import type { Config } from "../src/config.ts";
import {
  listMilestoneCardsPartitionSpine,
  sweepMilestoneCardsPartition,
  milestoneCardSk,
} from "../src/milestone-cards.ts";
import {
  listBoardMilestonesPartitionSpine,
  sweepBoardMilestonesPartition,
  boardMilestoneSk,
} from "../src/board-milestones.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: {
    card: "cardhash",
    board: "boardhash",
    milestone: "milestonehash",
    board_milestones: "bmhash",
    milestone_cards: "mchash",
  },
};

const MS = "ms-under-test";
const BOARD = "default";

/** The sparse row: keyed into the partition, one atom, and it is not `slug`. */
const SPARSE_MC_SK = milestoneCardSk("todo", "7777", "sparse-card");
const SPARSE_BM_SK = boardMilestoneSk("active", "7777", "sparse-milestone");

function milestoneCardsPartition(): FakeNode {
  const node = fakeNode();
  node.seed({
    schemaHash: "mchash",
    keyHash: MS,
    rangeKey: milestoneCardSk("todo", "1", "live-card"),
    fields: { milestone: MS, sk: milestoneCardSk("todo", "1", "live-card"), slug: "live-card", title: "live" },
  });
  node.seed({
    schemaHash: "mchash",
    keyHash: MS,
    rangeKey: SPARSE_MC_SK,
    fields: { title: "sparse" },
  });
  return node;
}

function boardMilestonesPartition(): FakeNode {
  const node = fakeNode();
  node.seed({
    schemaHash: "bmhash",
    keyHash: BOARD,
    rangeKey: boardMilestoneSk("active", "1", "live-milestone"),
    fields: {
      board: BOARD,
      sk: boardMilestoneSk("active", "1", "live-milestone"),
      slug: "live-milestone",
      title: "live",
    },
  });
  node.seed({
    schemaHash: "bmhash",
    keyHash: BOARD,
    rangeKey: SPARSE_BM_SK,
    fields: { title: "sparse" },
  });
  return node;
}

describe("MilestoneCards parity baseline", () => {
  // NON-VACUITY. If the spine could already reach the sparse row there is
  // nothing to fix and the sweep test below would pass for the wrong reason.
  test("the slug spine cannot see a row with no `slug` atom", async () => {
    const spine = await listMilestoneCardsPartitionSpine(milestoneCardsPartition(), cfg, MS);

    expect(spine?.map((r) => r.sk)).not.toContain(SPARSE_MC_SK);
    expect(spine).toHaveLength(1);
  });

  test("the sweep reaches it, and takes its address off the range key", async () => {
    const sweep = await sweepMilestoneCardsPartition(milestoneCardsPartition(), cfg, MS);

    expect(sweep?.failedLeads).toEqual([]);
    const sparse = sweep?.rows.find((r) => r.sk === SPARSE_MC_SK);
    expect(sparse).toBeDefined();
    // The row has no `slug`/`column`/`position` atom — anything reading the
    // payload copies would report empty and treat the row as unaddressable.
    expect(sparse?.slug).toBe("sparse-card");
    expect(sparse?.column).toBe("todo");
    // One row per address: reached under one lead vs all 24, each appears once.
    expect(sweep?.rows).toHaveLength(2);
  });

  // The row that makes a naive sweep WRONG. `Milestone` is `Hash(slug)` and
  // `MilestoneCards` is `HashRange(milestone, sk)`, so a milestone's own record
  // sits at the same hash as its cards partition and Mini's multi-key expand
  // returns it from cards reads with `range` coerced to `""`. Verified live
  // 2026-08-04 on `ms-backup-status-truthful`: present under 9 of 24 leads —
  // exactly the fields MilestoneCards shares with BoardMilestones — and absent
  // under the `milestone` lead the wide display read uses.
  //
  // If the baseline counted it, parity would report one invisible row on every
  // milestone partition, forever, with nothing to repair. Worse, its address is
  // `(milestone_cards, hash=<milestone>, range="")` and the one thing
  // `purgeOtherMilestoneCardRows` does with a baseline row is delete it.
  test("the milestone's own Hash record is not counted as a card row", async () => {
    const node = milestoneCardsPartition();
    node.seed({
      schemaHash: "mchash",
      keyHash: MS,
      rangeKey: "",
      fields: { slug: MS, title: "The milestone itself", board: BOARD, north_star: "ns-x" },
    });

    const sweep = await sweepMilestoneCardsPartition(node, cfg, MS);
    const spine = await listMilestoneCardsPartitionSpine(node, cfg, MS);

    // Both sides exclude it, so parity nets to zero for the right reason.
    expect(sweep?.rows.map((r) => r.slug)).not.toContain(MS);
    expect(spine?.map((r) => r.slug)).not.toContain(MS);
    expect(sweep?.rows).toHaveLength(2);
    // And it is excluded by ADDRESS, not by slug — a card legitimately named
    // after its milestone must still be counted.
    expect(sweep?.rows.every((r) => r.sk.length > 0)).toBe(true);
  });

  test("a refused lead is reported, not returned as a short clean enumeration", async () => {
    const node = milestoneCardsPartition();
    const inner = node.queryAll.bind(node);
    node.queryAll = async (opts) => {
      if (opts.fields[0] === "title") throw new Error("laststore: corrupt: empty rec");
      return inner(opts);
    };

    const sweep = await sweepMilestoneCardsPartition(node, cfg, MS);

    expect(sweep?.failedLeads.map((f) => f.field)).toEqual(["title"]);
    // `title` was the ONLY lead that reached the sparse row, so the enumeration
    // is genuinely short — and says so rather than reporting 1 row cleanly.
    expect(sweep?.rows).toHaveLength(1);
  });
});

describe("BoardMilestones parity baseline", () => {
  test("the slug spine cannot see a row with no `slug` atom", async () => {
    const spine = await listBoardMilestonesPartitionSpine(boardMilestonesPartition(), cfg, BOARD);

    expect(spine?.map((r) => r.sk)).not.toContain(SPARSE_BM_SK);
    expect(spine).toHaveLength(1);
  });

  test("the sweep reaches it, and takes its address off the range key", async () => {
    const sweep = await sweepBoardMilestonesPartition(boardMilestonesPartition(), cfg, BOARD);

    expect(sweep?.failedLeads).toEqual([]);
    const sparse = sweep?.rows.find((r) => r.sk === SPARSE_BM_SK);
    expect(sparse).toBeDefined();
    expect(sparse?.slug).toBe("sparse-milestone");
    expect(sparse?.state).toBe("active");
    expect(sweep?.rows).toHaveLength(2);
  });

  test("a refused lead is reported, not returned as a short clean enumeration", async () => {
    const node = boardMilestonesPartition();
    const inner = node.queryAll.bind(node);
    node.queryAll = async (opts) => {
      if (opts.fields[0] === "title") throw new Error("laststore: corrupt: empty rec");
      return inner(opts);
    };

    const sweep = await sweepBoardMilestonesPartition(node, cfg, BOARD);

    expect(sweep?.failedLeads.map((f) => f.field)).toEqual(["title"]);
    expect(sweep?.rows).toHaveLength(1);
  });
});

// The two tests above prove the sweep is a strictly wider baseline than the
// spine. They do NOT prove doctor USES it — reverting the two call sites leaves
// every assertion above green, which is exactly the "check that cannot read
// failure" shape this codebase keeps finding in its own guards. So pin the
// wiring at the only place it exists.
describe("doctor's milestone parity checks are wired to the complete baseline", () => {
  const src = readFileSync(new URL("../src/commands/doctor.ts", import.meta.url), "utf8");

  test("doctor calls the sweeps", () => {
    expect(src).toContain("sweepMilestoneCardsPartition(node, cfg,");
    expect(src).toContain("sweepBoardMilestonesPartition(node, cfg,");
  });

  test("doctor no longer takes a baseline from either slug spine", () => {
    // The spines remain in the codebase — `purgeOther*Rows` addresses deletes
    // through them, which is correct and must not be swept. What must not come
    // back is a PARITY BASELINE read from one.
    expect(src).not.toContain("listMilestoneCardsPartitionSpine(");
    expect(src).not.toContain("listBoardMilestonesPartitionSpine(");
  });

  test("no parity line still claims a slug-lead baseline", () => {
    expect(src).not.toContain("slug-lead baseline");
  });
});
