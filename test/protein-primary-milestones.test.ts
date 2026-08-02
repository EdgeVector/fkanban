/**
 * Protein-primary milestone writes: hot-path milestone mutations write the fat
 * Milestone payload only. BoardMilestones is a folded keyed tip plus delete-only
 * cleanup for obsolete keys.
 */
import { describe, expect, test } from "bun:test";

import {
  boardMilestoneFieldsFromMilestone,
  boardMilestoneSk,
  listAllBoardMilestones,
} from "../src/board-milestones.ts";
import type { Config } from "../src/config.ts";
import { listMilestones, upsertMilestoneRecord, type Board, type Milestone } from "../src/record.ts";
import { boardMilestonesSchema, DEFAULT_COLUMNS, milestoneSchema, MILESTONE_SHARED_FIELD_DESCRIPTIONS } from "../src/schemas.ts";
import { fakeNode, type FakeNode } from "./fake-node.ts";

const MILESTONE = "milestone-hash";
const BOARD_MILESTONES = "board-milestones-hash";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://127.0.0.1:9",
  userHash: "user",
  schemaServiceUrl: "http://127.0.0.1:9",
  schemaHashes: {
    board: "board-hash",
    card: "card-hash",
    milestone: MILESTONE,
    board_milestones: BOARD_MILESTONES,
  },
};

const boards: Board[] = [{
  slug: "default",
  title: "Default",
  body: "",
  columns: [...DEFAULT_COLUMNS],
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
}];

function milestone(partial: Partial<Milestone> = {}): Milestone {
  return {
    slug: "ms-protein",
    title: "Protein milestone",
    body: "acceptance",
    board: "default",
    state: "planned",
    position: "1",
    north_star: "ns-protein",
    driver: "last-stack-milestone-driver",
    deps: [],
    proof_card: "",
    proof_status: "pending",
    block_reason: "",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    completed_at: "",
    ...partial,
  };
}

function foldedNode(): FakeNode {
  const node = fakeNode({ dropIncompleteRows: false });
  const fold = (m: Milestone) => {
    node.seed({
      schemaHash: BOARD_MILESTONES,
      keyHash: m.board || "default",
      rangeKey: boardMilestoneSk(m.state, m.position, m.slug),
      fields: { ...boardMilestoneFieldsFromMilestone(m), completed_at: m.completed_at },
    });
  };
  const create = node.createRecord.bind(node);
  const update = node.updateRecord.bind(node);
  node.createRecord = (async (args) => {
    await create(args);
    if (args.schemaHash === MILESTONE) fold(args.fields as Milestone);
  }) as FakeNode["createRecord"];
  node.updateRecord = (async (args) => {
    await update(args);
    if (args.schemaHash === MILESTONE) {
      const row = node.rowAt(MILESTONE, args.keyHash);
      if (row) fold(row.fields as Milestone);
    }
  }) as FakeNode["updateRecord"];
  return node;
}

describe("protein-primary milestone writes", () => {
  test("shared milestone field descriptions match BoardMilestones except index-only fields", () => {
    const milestoneDescriptions = milestoneSchema.schema.field_descriptions;
    const boardMilestoneDescriptions = boardMilestonesSchema.schema.field_descriptions;
    for (const field of Object.keys(MILESTONE_SHARED_FIELD_DESCRIPTIONS)) {
      expect(boardMilestoneDescriptions[field]).toBe(milestoneDescriptions[field]);
    }
    expect(boardMilestoneDescriptions.sk).toContain("state#position");
    expect(boardMilestoneDescriptions.layout).not.toBe(milestoneDescriptions.layout);
  });

  test("create writes Milestone payload only and folded BoardMilestones answers list", async () => {
    const node = foldedNode();

    await upsertMilestoneRecord(node, cfg, milestone(), false, null);

    const boardMilestonePayloadWrites = node.writes.filter(
      (w) => w.schemaHash === BOARD_MILESTONES && (w.op === "create" || w.op === "update"),
    );
    expect(boardMilestonePayloadWrites).toEqual([]);
    expect(node.writes.filter((w) => w.schemaHash === MILESTONE && w.op === "create")).toHaveLength(1);

    const fromBoard = await listMilestones(node, cfg, { boards });
    expect(fromBoard.map((m) => m.slug)).toEqual(["ms-protein"]);
    expect(fromBoard[0]!.title).toBe("Protein milestone");
  });

  test("state change retires obsolete BoardMilestones key after folded destination exists", async () => {
    const node = foldedNode();
    const prev = milestone({ state: "planned", position: "1" });
    const next = milestone({
      state: "active",
      position: "1",
      updated_at: "2026-01-03T00:00:00.000Z",
    });
    await upsertMilestoneRecord(node, cfg, prev, false, null);
    node.writes.length = 0;

    await upsertMilestoneRecord(node, cfg, next, true, prev);

    const boardMilestonePayloadWrites = node.writes.filter(
      (w) => w.schemaHash === BOARD_MILESTONES && (w.op === "create" || w.op === "update"),
    );
    expect(boardMilestonePayloadWrites).toEqual([]);
    expect(
      node.writes.some(
        (w) =>
          w.schemaHash === BOARD_MILESTONES &&
          w.op === "delete" &&
          w.rangeKey === boardMilestoneSk(prev.state, prev.position, prev.slug),
      ),
    ).toBe(true);

    const rows = await listAllBoardMilestones(node, cfg, boards);
    expect(rows).toHaveLength(1);
    expect(rows![0]!.state).toBe("active");
  });
});
