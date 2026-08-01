/**
 * The milestone PORTFOLIO must answer membership from the same place
 * `milestone reconcile` does — the board.
 *
 * `MilestoneCards` is maintained by a node-side sibling fold off `BoardCards`
 * (see milestone-indexes.test.ts, which asserts fkanban issues no direct
 * MilestoneCards mutation). Where that fold has not converged, the index is a
 * snapshot of some earlier board, and it is wrong in BOTH directions: it holds
 * rows for cards that have since been deleted, and it lacks rows for cards
 * created since.
 *
 * `milestoneReconcileResult` already refuses to trust it alone — it unions the
 * index with board membership and validates every slug against Card truth.
 * `milestonePortfolioSnapshot` (which powers `milestone portfolio` and
 * `milestone groom`) preferred the index outright, so the two commands reported
 * different children for the same milestone.
 *
 * Measured on the live board 2026-07-31, 31 milestones: 5 agreed, 107 index rows
 * named cards with no Card record at all, and 87 live board-linked cards had no
 * index row — `ms-sync-dataloss-teardown-p1` rendered as an EMPTY milestone
 * while 13 live cards pointed at it.
 */
import { describe, expect, test } from "bun:test";

import type { Config } from "../src/config.ts";
import { fakeNode, type FakeNode } from "./fake-node.ts";
import { milestonePortfolioResult, milestoneReconcileResult } from "../src/commands/milestone.ts";
import { MILESTONE_CARDS_LAYOUT } from "../src/schemas.ts";
import { boardCardSk } from "../src/board-cards.ts";
import { boardMilestoneFieldsFromMilestone, boardMilestoneSk } from "../src/board-milestones.ts";
import type { Milestone } from "../src/record.ts";

const CARD = "cardhash";
const BOARD = "boardhash";
const MILESTONE = "milestonehash";
const BOARD_CARDS = "boardcards-hash";
const BOARD_MILESTONES = "boardms-hash";
const MILESTONE_CARDS = "mscards-hash";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: {
    card: CARD,
    board: BOARD,
    milestone: MILESTONE,
    board_cards: BOARD_CARDS,
    board_milestones: BOARD_MILESTONES,
    milestone_cards: MILESTONE_CARDS,
  },
};

function cardFields(partial: Record<string, unknown>): Record<string, unknown> {
  return {
    slug: "c",
    title: "A card",
    body: "## GOAL\nWork.\n\n## END STATE\nDone.\n",
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
    done_at: "",
    db: "",
    repo: "EdgeVector/fkanban",
    base: "main",
    kind: "pr",
    block_status: "none",
    block_reason: "",
    north_star: "ns-1",
    milestone: "m1",
    pr_url: "",
    branch: "",
    ...partial,
  };
}

/** Seed a Card + its BoardCards row, the way a converged write path leaves them. */
function seedBoardCard(node: FakeNode, partial: Record<string, unknown>): void {
  const fields = cardFields(partial);
  node.seed({ schemaHash: CARD, keyHash: String(fields.slug), fields });
  node.seed({
    schemaHash: BOARD_CARDS,
    keyHash: String(fields.board),
    rangeKey: boardCardSk(String(fields.column), String(fields.position), String(fields.slug)),
    fields: { ...fields, board: String(fields.board), sk: boardCardSk(String(fields.column), String(fields.position), String(fields.slug)) },
  });
}

/** Seed a MilestoneCards row with NO matching Card — what a stale fold leaves. */
function seedOrphanIndexRow(node: FakeNode, milestone: string, slug: string): void {
  const sk = boardCardSk("done", "10", slug);
  node.seed({
    schemaHash: MILESTONE_CARDS,
    keyHash: milestone,
    rangeKey: sk,
    fields: { ...cardFields({ slug, milestone, column: "done" }), milestone, sk, layout: MILESTONE_CARDS_LAYOUT },
  });
}

function milestoneRecord(partial: Partial<Milestone> = {}): Milestone {
  return {
    slug: "m1",
    title: "Milestone one",
    body: "",
    board: "default",
    state: "active",
    position: "10",
    north_star: "ns-1",
    driver: "last-stack-milestone-driver",
    deps: [],
    proof_card: "",
    proof_status: "pending",
    block_reason: "",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    completed_at: "",
    ...partial,
  };
}

/**
 * Seed the fat Milestone AND its BoardMilestones row. `listMilestones` reads the
 * index and treats an empty partition as authoritative, so a fixture that seeds
 * only the fat record has no milestones at all.
 */
function seedMilestone(node: FakeNode, partial: Partial<Milestone> = {}): void {
  const m = milestoneRecord(partial);
  node.seed({ schemaHash: MILESTONE, keyHash: m.slug, fields: { ...m } });
  node.seed({
    schemaHash: BOARD_MILESTONES,
    keyHash: m.board,
    rangeKey: boardMilestoneSk(m.state, m.position, m.slug),
    // `completed_at` is added on top of `boardMilestoneFieldsFromMilestone`,
    // which deliberately omits it — while `listBoardMilestonesPartition`
    // projects all 17 BOARD_MILESTONES_FIELDS including it.
    //
    // This fixture used to justify itself with "as the live primary's rows do".
    // MEASURED 2026-08-01, and both halves of that were wrong: the primary's
    // rows do NOT have the atom (0 of 33 carry a `completed_at` key), and the
    // node does NOT drop them for it (all 33 come back). See
    // `scripts/probe-wire-projection-semantics.ts`. The atom stays here only so
    // these tests keep exercising the completion path with a value; the
    // partial-row behaviour they were silently modelling away is covered by
    // `test/membership-partial-row-provenance.test.ts`.
    fields: { ...boardMilestoneFieldsFromMilestone(m), completed_at: m.completed_at },
  });
}

function seedFixture(): FakeNode {
  const node = fakeNode();
  node.seed({
    schemaHash: BOARD,
    keyHash: "default",
    fields: {
      slug: "default",
      title: "Default",
      body: "",
      columns: ["backlog", "todo", "doing", "done"],
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
  });
  seedMilestone(node);
  return node;
}

describe("milestone portfolio membership comes from the board, not a stale index", () => {
  test("a live board-linked card with no index row is still a child", async () => {
    const node = seedFixture();
    // The 87-card case: created since the fold last converged, so BoardCards
    // carries the milestone link and MilestoneCards has nothing.
    seedBoardCard(node, { slug: "live-card", milestone: "m1" });

    const portfolio = await milestonePortfolioResult({ cfg, node });
    const entry = portfolio.entries.find((e) => e.slug === "m1");
    expect(entry?.ready).toContain("live-card");
  });

  test("an index row whose card no longer exists is NOT a child", async () => {
    const node = seedFixture();
    seedBoardCard(node, { slug: "live-card", milestone: "m1" });
    // The 107-row case: the Card and its BoardCards row are gone; only the
    // membership row survives. Counting it as a child reports finished-and-
    // deleted work as live milestone content.
    seedOrphanIndexRow(node, "m1", "deleted-card");

    const portfolio = await milestonePortfolioResult({ cfg, node });
    const entry = portfolio.entries.find((e) => e.slug === "m1");
    expect(entry?.ready).not.toContain("deleted-card");
    expect(portfolio.entries.flatMap((e) => e.ready)).toEqual(["live-card"]);
  });

  test("portfolio and reconcile agree on the same milestone", async () => {
    const node = seedFixture();
    seedBoardCard(node, { slug: "live-card", milestone: "m1" });
    seedOrphanIndexRow(node, "m1", "deleted-card");

    // The defect was not "the portfolio is slow", it was "the portfolio and
    // reconcile disagree". This is the assertion that has to hold.
    const portfolio = await milestonePortfolioResult({ cfg, node });
    const reconcile = await milestoneReconcileResult({ cfg, node, slug: "m1" });
    expect(portfolio.entries.find((e) => e.slug === "m1")?.ready)
      .toEqual(reconcile.ready.map((c) => c.slug));
  });

  test("the portfolio does not fan out one keyed read per milestone", async () => {
    const node = seedFixture();
    seedBoardCard(node, { slug: "live-card", milestone: "m1" });

    await milestonePortfolioResult({ cfg, node });
    // Per-milestone MilestoneCards partition reads were the most expensive part
    // of this command (31 keyed reads, ~7.4s of node time on the live board) AND
    // the source of the wrong answer. One board partition read replaces them.
    expect(node.reads.filter((r) => r.schemaHash === MILESTONE_CARDS)).toEqual([]);
    expect(node.reads.filter((r) => r.schemaHash === BOARD_CARDS).length).toBe(1);
  });
});

describe("proof cards are read narrowly and deduped before the fan-out", () => {
  test("two milestones sharing a proof card issue ONE proof read", async () => {
    const node = fakeNode();
    node.seed({
      schemaHash: BOARD,
      keyHash: "default",
      fields: {
        slug: "default", title: "Default", body: "",
        columns: ["backlog", "todo", "doing", "done"],
        created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
      },
    });
    seedMilestone(node, { slug: "m1", proof_card: "shared-proof" });
    seedMilestone(node, { slug: "m2", title: "Milestone two", position: "20", proof_card: "shared-proof" });
    seedBoardCard(node, { slug: "shared-proof", milestone: "m1", kind: "validation", body: "PROOF: PASS\n" });

    await milestonePortfolioResult({ cfg, node });

    // The old `if (!proofs.has(slug)) proofs.set(slug, await findCard(slug))`
    // inside a Promise.all was check-then-act: the guard runs before any set
    // lands, so both milestones read the same card. Live on the real board —
    // `search-as-app-ns-terminal-verification` is the proof card for two
    // milestones, and cost 29 reads for 28 distinct slugs.
    const proofReads = node.reads.filter(
      (r) => r.schemaHash === CARD && (r.filter as { HashKey?: string })?.HashKey === "shared-proof",
    );
    expect(proofReads.length).toBe(1);
  });

  test("the proof read projects only the fields the verdict uses", async () => {
    const node = fakeNode();
    node.seed({
      schemaHash: BOARD,
      keyHash: "default",
      fields: {
        slug: "default", title: "Default", body: "",
        columns: ["backlog", "todo", "doing", "done"],
        created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
      },
    });
    seedMilestone(node, { slug: "m1", proof_card: "the-proof" });
    seedBoardCard(node, { slug: "the-proof", milestone: "m1", kind: "validation", body: "PROOF: PASS\n" });

    await milestonePortfolioResult({ cfg, node });

    const proofRead = node.reads.find(
      (r) => r.schemaHash === CARD && (r.filter as { HashKey?: string })?.HashKey === "the-proof",
    );
    // Not a byte-saving nicety: every projected field is another atom that can
    // be absent, and an absent atom drops the WHOLE row. A 23-field proof read
    // makes a merely-sparse card report as missing.
    expect(proofRead).toBeDefined();
    expect(new Set(proofRead!.fields)).toEqual(
      new Set(["slug", "board", "column", "milestone", "tags", "body"]),
    );
  });
});

describe("the board card read does not sit on the critical path", () => {
  /** A second board, so "every board" and "only the milestone's board" differ. */
  function seedSecondBoard(node: FakeNode): void {
    node.seed({
      schemaHash: BOARD,
      keyHash: "scratch",
      fields: {
        slug: "scratch", title: "Scratch", body: "",
        columns: ["backlog", "todo", "doing", "done"],
        created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
      },
    });
    seedBoardCard(node, { slug: "scratch-card", board: "scratch", milestone: "" });
  }

  test("card partitions are requested BEFORE the milestone list is read", async () => {
    const node = seedFixture();
    seedSecondBoard(node);
    seedBoardCard(node, { slug: "live-card", milestone: "m1" });

    await milestonePortfolioResult({ cfg, node });

    // This ordering IS the fix. Deriving the board slugs from the milestone list
    // chained boards -> milestones -> cards, which put the single most expensive
    // read in the command (789ms measured on the live primary) on the critical
    // path — this command got 15-20% slower in wall clock even as its node time
    // fell 32-40%. `listBoards` already names every board, so the fetch is
    // knowable before the milestone list returns; the milestone list only
    // decides which rows to KEEP.
    const firstCards = node.reads.findIndex((r) => r.schemaHash === BOARD_CARDS);
    const firstMilestones = node.reads.findIndex((r) => r.schemaHash === BOARD_MILESTONES);
    expect(firstCards).toBeGreaterThanOrEqual(0);
    expect(firstMilestones).toBeGreaterThanOrEqual(0);
    expect(firstCards).toBeLessThan(firstMilestones);
  });

  test("without a board filter, every board's partition is read exactly once", async () => {
    const node = seedFixture();
    seedSecondBoard(node);
    seedBoardCard(node, { slug: "live-card", milestone: "m1" });

    await milestonePortfolioResult({ cfg, node });

    // The acknowledged cost of fetching before the milestone list is known: a
    // board no milestone lives on is still read. One keyed partition read each,
    // against the 31 this path used to issue — but it must not be more than one.
    const boardsRead = node.reads
      .filter((r) => r.schemaHash === BOARD_CARDS)
      .map((r) => (r.filter as { HashKey?: string })?.HashKey);
    expect([...boardsRead].sort()).toEqual(["default", "scratch"]);
  });

  test("with a board filter there is no speculation — only that board is read", async () => {
    const node = seedFixture();
    seedSecondBoard(node);
    seedBoardCard(node, { slug: "live-card", milestone: "m1" });

    await milestonePortfolioResult({ cfg, node, board: "default" });

    const boardsRead = node.reads
      .filter((r) => r.schemaHash === BOARD_CARDS)
      .map((r) => (r.filter as { HashKey?: string })?.HashKey);
    expect(boardsRead).toEqual(["default"]);
  });

  test("a milestone's children still come only from its own board", async () => {
    const node = seedFixture();
    seedSecondBoard(node);
    seedBoardCard(node, { slug: "live-card", milestone: "m1" });
    // Same milestone slug, different board: reading every board's cards must not
    // let another board's rows leak into this milestone's children.
    seedBoardCard(node, { slug: "impostor", board: "scratch", milestone: "m1" });

    const portfolio = await milestonePortfolioResult({ cfg, node });
    expect(portfolio.entries.find((e) => e.slug === "m1")?.ready).toEqual(["live-card"]);
  });
});
