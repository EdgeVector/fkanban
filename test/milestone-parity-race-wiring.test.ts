// Proof that the confirmation is actually WIRED to the two milestone indexes —
// not merely available to them.
//
// `confirmParityDrop` shipped index-agnostic and pure, and then sat behind one
// call site. `test/parity-with-confirmation.test.ts` proves the decision is
// right against injected sweeps; it says nothing about whether the REAL
// `sweepMilestoneCardsPartition` / `sweepBoardMilestonesPartition` produce the
// `{ sk, slug }` shape it consumes, or whether a row that leaves the partition
// mid-check reaches it at all. That gap is the one run (g) fell into: a
// deferred half that typechecked, passed 1483 tests, and emitted nothing.
//
// So these run the confirmation over the actual sweep and wide-read functions,
// with the partition mutated between the two reads — the live race, constructed.
import { describe, expect, test } from "bun:test";

import { fakeNode, type FakeNode } from "./fake-node.ts";
import type { Config } from "../src/config.ts";
import { parityWithConfirmation } from "../src/membership_schema_guard.ts";
import {
  listMilestoneCardsPartition,
  sweepMilestoneCardsPartition,
  milestoneCardSk,
} from "../src/milestone-cards.ts";
import {
  listBoardMilestonesPartition,
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

const MC_STAYS = milestoneCardSk("todo", "1", "stays");
const MC_LEAVES = milestoneCardSk("todo", "2", "leaves");
const BM_STAYS = boardMilestoneSk("active", "1", "stays-ms");
const BM_LEAVES = boardMilestoneSk("active", "2", "leaves-ms");

// `hash_else_lead` is the rule the node was measured to apply, and also the
// fake's default; it is named explicitly because these tests ARE about the
// projection and the `hashFields` below only mean anything under it. Under the
// superseded `any_missing` a wide read of these partitions returns ZERO rows
// and every test below passes for the wrong reason.
const measured = () =>
  fakeNode({
    projectionRule: "hash_else_lead",
    hashFields: { mchash: "milestone", bmhash: "board" },
  });

/** Both rows carry the gating field, so only the mid-check delete can move them. */
function milestoneCardsPartition(): FakeNode {
  const node = measured();
  for (const [sk, slug] of [[MC_STAYS, "stays"], [MC_LEAVES, "leaves"]] as const) {
    node.seed({
      schemaHash: "mchash",
      keyHash: MS,
      rangeKey: sk,
      fields: { milestone: MS, sk, slug, title: slug, column: "todo", board: BOARD },
    });
  }
  return node;
}

function boardMilestonesPartition(): FakeNode {
  const node = measured();
  for (const [sk, slug] of [[BM_STAYS, "stays-ms"], [BM_LEAVES, "leaves-ms"]] as const) {
    node.seed({
      schemaHash: "bmhash",
      keyHash: BOARD,
      rangeKey: sk,
      fields: { board: BOARD, sk, slug, title: slug, state: "active" },
    });
  }
  return node;
}

describe("MilestoneCards parity confirmation", () => {
  test("a row deleted between the sweep and the wide read is churn, not drift", async () => {
    const node = milestoneCardsPartition();
    const sweep = await sweepMilestoneCardsPartition(node, cfg, MS);
    expect(sweep?.failedLeads).toEqual([]);

    // The race: `rank` and the reaper both delete mid-check.
    await node.deleteRecord({ schemaHash: "mchash", keyHash: MS, rangeKey: MC_LEAVES });

    const wide = await listMilestoneCardsPartition(node, cfg, MS);
    const got = await parityWithConfirmation({
      firstSweep: sweep!.rows,
      wideSlugs: new Set(wide!.map((c) => c.slug)),
      wideRows: wide!.length,
      resweep: () => sweepMilestoneCardsPartition(node, cfg, MS),
    });

    // Before the wiring this was RED with `run kanban milestone reconcile` —
    // a WRITE repair aimed at a partition that is fine.
    expect(got.parity.ok).toBe(true);
    expect(got.moved).toEqual(["leaves"]);
    expect(got.confirmed).toBe(true);
  });

  // NON-VACUITY. If the confirmation swallowed real drift too, the test above
  // would pass for the wrong reason and the check would be worthless.
  test("a row that stays and the wide read cannot serve is still reported", async () => {
    const node = milestoneCardsPartition();
    // A row with no `slug` atom. `MILESTONE_CARDS_PAYLOAD_FIELDS` excludes
    // `milestone`, so under HASH-ELSE-LEAD the gate is the LEAD, `slug` —
    // not the hash field doctor used to name in this verdict.
    const SK = milestoneCardSk("todo", "3", "gated");
    node.seed({
      schemaHash: "mchash",
      keyHash: MS,
      rangeKey: SK,
      fields: { milestone: MS, sk: SK, title: "gated", column: "todo" },
    });

    const sweep = await sweepMilestoneCardsPartition(node, cfg, MS);
    const wide = await listMilestoneCardsPartition(node, cfg, MS);
    expect(wide?.map((c) => c.slug)).not.toContain("gated");

    const got = await parityWithConfirmation({
      firstSweep: sweep!.rows,
      wideSlugs: new Set(wide!.map((c) => c.slug)),
      wideRows: wide!.length,
      resweep: () => sweepMilestoneCardsPartition(node, cfg, MS),
    });

    expect(got.parity.ok).toBe(false);
    if (!got.parity.ok) {
      expect(got.parity.dropped).toBe(1);
      expect(got.parity.reason).toContain("gated");
    }
    expect(got.moved).toEqual([]);
  });

  test("drift and a delete in the SAME window are separated, over the real reads", async () => {
    const node = milestoneCardsPartition();
    const SK = milestoneCardSk("todo", "3", "gated");
    node.seed({
      schemaHash: "mchash",
      keyHash: MS,
      rangeKey: SK,
      fields: { milestone: MS, sk: SK, title: "gated", column: "todo" },
    });

    const sweep = await sweepMilestoneCardsPartition(node, cfg, MS);
    await node.deleteRecord({ schemaHash: "mchash", keyHash: MS, rangeKey: MC_LEAVES });
    const wide = await listMilestoneCardsPartition(node, cfg, MS);

    const got = await parityWithConfirmation({
      firstSweep: sweep!.rows,
      wideSlugs: new Set(wide!.map((c) => c.slug)),
      wideRows: wide!.length,
      resweep: () => sweepMilestoneCardsPartition(node, cfg, MS),
    });

    // One casualty, one race — and the count-based verdict would have said
    // "2 dropped" and sent the operator to reconcile a healthy row.
    expect(got.parity.ok).toBe(false);
    if (!got.parity.ok) expect(got.parity.dropped).toBe(1);
    expect(got.moved).toEqual(["leaves"]);
  });
});

describe("BoardMilestones parity confirmation", () => {
  test("a milestone deleted between the sweep and the wide read is churn, not drift", async () => {
    const node = boardMilestonesPartition();
    const sweep = await sweepBoardMilestonesPartition(node, cfg, BOARD);
    expect(sweep?.failedLeads).toEqual([]);

    await node.deleteRecord({ schemaHash: "bmhash", keyHash: BOARD, rangeKey: BM_LEAVES });

    const wide = await listBoardMilestonesPartition(node, cfg, BOARD);
    const got = await parityWithConfirmation({
      firstSweep: sweep!.rows,
      wideSlugs: new Set(wide!.map((m) => m.slug)),
      wideRows: wide!.length,
      resweep: () => sweepBoardMilestonesPartition(node, cfg, BOARD),
      remedy: "run `kanban milestone reconcile <slug>` for the affected milestone(s)",
    });

    expect(got.parity.ok).toBe(true);
    expect(got.moved).toEqual(["leaves-ms"]);
  });

  test("a milestone with no `board` atom is still reported, with its own remedy", async () => {
    const node = boardMilestonesPartition();
    const SK = boardMilestoneSk("active", "3", "gated-ms");
    node.seed({
      schemaHash: "bmhash",
      keyHash: BOARD,
      rangeKey: SK,
      fields: { sk: SK, slug: "gated-ms", title: "gated", state: "active" },
    });

    const sweep = await sweepBoardMilestonesPartition(node, cfg, BOARD);
    const wide = await listBoardMilestonesPartition(node, cfg, BOARD);

    const got = await parityWithConfirmation({
      firstSweep: sweep!.rows,
      wideSlugs: new Set(wide!.map((m) => m.slug)),
      wideRows: wide!.length,
      resweep: () => sweepBoardMilestonesPartition(node, cfg, BOARD),
      remedy: "run `kanban milestone reconcile <slug>` for the affected milestone(s)",
    });

    expect(got.parity.ok).toBe(false);
    if (!got.parity.ok) {
      expect(got.parity.reason).toContain("gated-ms");
      // The wrong remedy is worse than none: it looks actionable, then reports
      // success against rows it cannot touch.
      expect(got.parity.reason).toContain("milestone reconcile");
      expect(got.parity.reason).not.toContain("board-cards-heal");
    }
  });
});
