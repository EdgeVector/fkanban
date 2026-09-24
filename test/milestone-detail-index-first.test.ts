/**
 * `milestone detail` reads a milestone's members from MilestoneCards
 * (hash=milestone), not from the whole BoardCards partition (hash=board).
 *
 * Measured 2026-09-23 on the live primary: the default board partition is 298
 * rows, 238 of them done cards, and each `milestone detail` spent 7-31s of
 * `hydrate_atoms` on it to keep a handful of members. The `fkanban-validate`
 * routines call `detail` 12-20 times an hour.
 *
 * The board union stays on the repair verbs (`milestone reconcile`,
 * `groom milestone-indexes-heal`): only the board can show them a member whose
 * MilestoneCards row never folded. `detail` falls back to the board only when
 * the index cannot answer (unbound/refused) or names no implementation child.
 */
import { describe, expect, test } from "bun:test";

import type { Config } from "../src/config.ts";
import { fakeNode, type FakeNode } from "./fake-node.ts";
import { milestoneDetailResult, milestoneReconcilePayload, milestoneReconcileResult } from "../src/commands/milestone.ts";
import { boardCardSk } from "../src/board-cards.ts";
import { boardMilestoneFieldsFromMilestone, boardMilestoneSk } from "../src/board-milestones.ts";
import { milestoneCardFieldsFromCard } from "../src/milestone-cards.ts";
import type { Card, Milestone } from "../src/record.ts";

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
    title: `Card ${String(partial.slug ?? "c")}`,
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
    milestone: "",
    pr_url: "",
    branch: "",
    ...partial,
  };
}

/** Card primary + BoardCards row, and the folded MilestoneCards row when `indexed`. */
function seedCard(node: FakeNode, partial: Record<string, unknown>, indexed = true): void {
  const fields = cardFields(partial);
  const sk = boardCardSk(String(fields.column), String(fields.position), String(fields.slug));
  node.seed({ schemaHash: CARD, keyHash: String(fields.slug), fields });
  node.seed({ schemaHash: BOARD_CARDS, keyHash: String(fields.board), rangeKey: sk, fields: { ...fields, sk } });
  const ms = milestoneCardFieldsFromCard(fields as unknown as Card);
  if (indexed && ms) {
    node.seed({ schemaHash: MILESTONE_CARDS, keyHash: String(ms.milestone), rangeKey: String(ms.sk), fields: ms });
  }
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
    proof_card: "proof-card",
    proof_status: "pending",
    block_reason: "",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    completed_at: "",
    ...partial,
  };
}

function seedMilestone(node: FakeNode, partial: Partial<Milestone> = {}): void {
  const m = milestoneRecord(partial);
  node.seed({ schemaHash: MILESTONE, keyHash: m.slug, fields: { ...m } });
  node.seed({
    schemaHash: BOARD_MILESTONES,
    keyHash: m.board,
    rangeKey: boardMilestoneSk(m.state, m.position, m.slug),
    fields: { ...boardMilestoneFieldsFromMilestone(m), completed_at: m.completed_at },
  });
}

/**
 * A milestone with members in four columns, one of them dep-blocked on a card
 * that is NOT a member, on a board that carries many non-member cards — the
 * live shape (most of the partition is someone else's done cards).
 */
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
  seedCard(node, { slug: "m-backlog", milestone: "m1", column: "backlog", position: "10" });
  seedCard(node, { slug: "m-ready", milestone: "m1", column: "todo", position: "10" });
  seedCard(node, { slug: "m-blocked", milestone: "m1", column: "todo", position: "20", deps: ["other-open"] });
  seedCard(node, { slug: "m-doing", milestone: "m1", column: "doing", position: "10" });
  seedCard(node, { slug: "m-done", milestone: "m1", column: "done", position: "10" });
  seedCard(node, { slug: "proof-card", milestone: "m1", column: "doing", position: "20", kind: "validation" });
  // Non-members: another milestone's cards, a dep target, and done filler.
  seedCard(node, { slug: "other-open", milestone: "m2", column: "doing", position: "30" });
  for (let i = 0; i < 40; i++) {
    seedCard(node, { slug: `filler-${i}`, column: "done", position: String(100 + i), milestone: i % 2 ? "m2" : "" });
  }
  return node;
}

function boardPartitionReads(node: FakeNode): number {
  return node.reads.filter((r) => r.schemaHash === BOARD_CARDS && r.filter?.HashKey === "default").length;
}

describe("milestone detail is index-first", () => {
  test("(a) detail issues no whole-board BoardCards read", async () => {
    const node = seedFixture();
    await milestoneDetailResult({ cfg, node, slug: "m1" });
    expect(boardPartitionReads(node)).toBe(0);
    // Nor any other BoardCards read: members come from the milestone partition.
    expect(node.reads.filter((r) => r.schemaHash === BOARD_CARDS)).toEqual([]);
    expect(node.reads.filter((r) => r.schemaHash === MILESTONE_CARDS && r.filter?.HashKey === "m1").length).toBeGreaterThan(0);
  });

  test("(b) output for a milestone with members in several columns is unchanged", async () => {
    const node = seedFixture();
    const detail = await milestoneDetailResult({ cfg, node, slug: "m1" });

    // Reference: the board-union read of the same data, which is what detail
    // returned before this change.
    const union = await milestoneReconcileResult({ cfg, node: seedFixture(), slug: "m1", apply: false, membership: "board-union" });
    const { columns, ...payload } = detail.detail;
    expect(payload).toEqual(milestoneReconcilePayload(union));
    expect(detail.repairs).toEqual(union.repairs);

    expect(Object.fromEntries(Object.entries(columns).map(([c, cards]) => [c, cards.map((card) => card.slug)]))).toEqual({
      backlog: ["m-backlog"],
      todo: ["m-ready", "m-blocked"],
      doing: ["m-doing", "proof-card"],
      done: ["m-done"],
    });
    expect(columns.todo?.find((c) => c.slug === "m-blocked")).toMatchObject({ blocked: true, blockedBy: ["other-open"] });
    expect(detail.detail.ready.map((c) => c.slug)).toEqual(["m-ready"]);
    expect(detail.text).toContain("TODO (2)");
    expect(detail.text).toContain("🔒 Card m-blocked  m-blocked");
    expect(detail.text).toContain("ready frontier: m-ready");
    // No non-member leaks in.
    expect(detail.text).not.toContain("filler-");
    expect(detail.text).not.toContain("other-open  other-open");
  });

  test("(c) reconcile still reads the whole board partition", async () => {
    const node = seedFixture();
    await milestoneReconcileResult({ cfg, node, slug: "m1", apply: false });
    expect(boardPartitionReads(node)).toBe(1);
  });

  test("reconcile still finds a member whose MilestoneCards row never folded", async () => {
    const node = seedFixture();
    seedCard(node, { slug: "m-unfolded", milestone: "m1", column: "todo", position: "30" }, false);
    const rec = await milestoneReconcileResult({ cfg, node, slug: "m1", apply: false });
    expect(rec.children.map((c) => c.slug)).toContain("m-unfolded");
    expect(rec.repairs.upserts).toBe(1);
  });

  test("an index with no implementation member falls back to the board", async () => {
    // Every member's fold missing: the index reads empty, and an empty
    // milestone is the one index answer detail never trusts on its own.
    const node = fakeNode();
    node.seed({
      schemaHash: BOARD,
      keyHash: "default",
      fields: { slug: "default", title: "Default", body: "", columns: ["backlog", "todo", "doing", "done"], created_at: "", updated_at: "" },
    });
    seedMilestone(node);
    seedCard(node, { slug: "m-ready", milestone: "m1", column: "todo", position: "10" }, false);
    seedCard(node, { slug: "proof-card", milestone: "m1", column: "doing", position: "20", kind: "validation" });

    const detail = await milestoneDetailResult({ cfg, node, slug: "m1" });
    expect(boardPartitionReads(node)).toBe(1);
    expect(detail.detail.children.map((c) => c.slug).sort()).toEqual(["m-ready", "proof-card"]);
    // The drift is reported, not hidden: reconcile is named as the repair.
    expect(detail.repairs).toMatchObject({ applied: false, upserts: 1, issued: 0 });
    expect(detail.text).toContain("kanban milestone reconcile m1");
  });

  test("an unbound MilestoneCards index falls back to the board", async () => {
    const node = seedFixture();
    const { milestone_cards: _unbound, ...hashes } = cfg.schemaHashes;
    const unbound: Config = { ...cfg, schemaHashes: hashes };
    const detail = await milestoneDetailResult({ cfg: unbound, node, slug: "m1" });
    expect(boardPartitionReads(node)).toBe(1);
    expect(detail.detail.children).toHaveLength(6);
  });
});
