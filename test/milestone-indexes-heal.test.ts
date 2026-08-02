import { describe, expect, test } from "bun:test";

import type { Config } from "../src/config.ts";
import { addCmd } from "../src/commands/add.ts";
import { milestoneAddCmd } from "../src/commands/milestone.ts";
import { milestoneIndexesHealResult } from "../src/commands/milestone_indexes_heal.ts";
import { boardMilestoneFieldsFromMilestone, boardMilestoneSk } from "../src/board-milestones.ts";
import { boardToFields, findMilestone, nowIso } from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";
import { fakeNode, type FakeNode } from "./fake-node.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: {
    card: "cardhash",
    board: "boardhash",
    milestone: "milestonehash",
    board_cards: "boardcards-hash",
    board_milestones: "boardms-hash",
    milestone_cards: "mscards-hash",
  },
};

async function seedBoard(node: FakeNode): Promise<void> {
  const now = nowIso();
  await node.createRecord({
    schemaHash: cfg.schemaHashes.board!,
    keyHash: "default",
    fields: boardToFields({
      slug: "default",
      title: "Default",
      body: "",
      columns: [...DEFAULT_COLUMNS],
      created_at: now,
      updated_at: now,
    }),
  });
}

async function seedMilestoneWithChildren(node: FakeNode, childCount: number): Promise<void> {
  await seedBoard(node);
  await milestoneAddCmd({
    cfg,
    node,
    slug: "ms-heal",
    title: "Heal milestone",
    state: "active",
    northStar: "north-star-heal",
    driver: "last-stack-milestone-driver",
  });
  const milestone = await findMilestone(node, cfg, "ms-heal");
  if (!milestone) throw new Error("seed milestone missing");
  node.seed({
    schemaHash: cfg.schemaHashes.board_milestones!,
    keyHash: milestone.board || "default",
    rangeKey: boardMilestoneSk(milestone.state, milestone.position, milestone.slug),
    fields: { ...boardMilestoneFieldsFromMilestone(milestone), completed_at: milestone.completed_at },
  });
  for (let i = 1; i <= childCount; i += 1) {
    await addCmd({
      cfg,
      node,
      slug: `heal-pr-${i}`,
      title: `Heal PR ${i}`,
      milestone: "ms-heal",
      northStar: "north-star-heal",
      repo: "EdgeVector/fkanban",
      base: "main",
      kind: "pr",
      column: "todo",
      body: `Repo: EdgeVector/fkanban
Base: main

## GOAL
Repair milestone child ${i}.

## END STATE
Merged.
`,
    });
  }
}

describe("groom milestone-indexes-heal", () => {
  test("dry-run classifies missing MilestoneCards without writing", async () => {
    const node = fakeNode({ dropIncompleteRows: false });
    await seedMilestoneWithChildren(node, 2);
    node.writes.length = 0;

    const result = await milestoneIndexesHealResult({ cfg, node, apply: false });

    expect(result).toMatchObject({
      applied: false,
      milestone_card_upserts: 2,
      milestone_card_removals: 0,
      board_milestone_upserts: 0,
      issued: 0,
      deferred: 2,
    });
    expect(node.rowsOf(cfg.schemaHashes.milestone_cards!).length).toBe(0);
    expect(node.writes).toEqual([]);
    expect(result.direct_milestone_card_payload_upsert).toBe(false);
    expect(result.text).toContain("mode=protein-fold-request");
  });

  test("maxRepairs bounds one explicit full-payload apply pass and later runs continue", async () => {
    const node = fakeNode({ dropIncompleteRows: false });
    await seedMilestoneWithChildren(node, 2);
    node.writes.length = 0;

    const first = await milestoneIndexesHealResult({
      cfg,
      node,
      maxRepairs: 1,
      directMilestoneCardPayloadUpsert: true,
    });
    expect(first).toMatchObject({
      applied: true,
      milestone_card_upserts: 2,
      issued: 1,
      deferred: 1,
      direct_milestone_card_payload_upsert: true,
    });
    expect(node.rowsOf(cfg.schemaHashes.milestone_cards!).length).toBe(1);

    const second = await milestoneIndexesHealResult({
      cfg,
      node,
      maxRepairs: 1,
      directMilestoneCardPayloadUpsert: true,
    });
    expect(second).toMatchObject({
      applied: true,
      milestone_card_upserts: 1,
      issued: 1,
      deferred: 0,
    });
    expect(node.rowsOf(cfg.schemaHashes.milestone_cards!).length).toBe(2);
  });

  test("classifies and restores a missing BoardMilestones row", async () => {
    const node = fakeNode({ dropIncompleteRows: false });
    await seedMilestoneWithChildren(node, 0);
    const existing = node.rowsOf(cfg.schemaHashes.board_milestones!)[0]!;
    await node.deleteRecord({
      schemaHash: cfg.schemaHashes.board_milestones!,
      keyHash: existing.keyHash,
      rangeKey: existing.rangeKey,
    });
    node.writes.length = 0;

    const dry = await milestoneIndexesHealResult({ cfg, node, apply: false });
    expect(dry).toMatchObject({
      board_milestone_upserts: 1,
      milestone_card_upserts: 0,
      issued: 0,
      deferred: 1,
    });
    expect(node.rowsOf(cfg.schemaHashes.board_milestones!).length).toBe(0);

    const repaired = await milestoneIndexesHealResult({ cfg, node, maxRepairs: 1 });
    expect(repaired).toMatchObject({
      board_milestone_upserts: 1,
      issued: 1,
      deferred: 0,
    });
    expect(node.rowsOf(cfg.schemaHashes.board_milestones!).length).toBe(1);
  });
});
