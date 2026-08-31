import { describe, expect, test } from "bun:test";

import { FkanbanError } from "../src/client.ts";
import { addCmd } from "../src/commands/add.ts";
import { claimCard, moveCmd } from "../src/commands/move.ts";
import { type Config } from "../src/config.ts";
import {
  featureFlowCurrentKey,
  featureFlowEventKey,
  featureFlowReport,
  recordFeatureFlowMutation,
} from "../src/flow-ledger.ts";
import { boardToFields, milestoneToFields, nowIso, type Card } from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";
import { fakeNode } from "./fake-node.ts";

const FLOW_HASH = "feature-flow-hash";
const MILESTONE = "delivery-v1";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: {
    card: "card-hash",
    board: "board-hash",
    milestone: "milestone-hash",
    feature_flow_events: FLOW_HASH,
  },
};

const pickupBody =
  "Repo: EdgeVector/fkanban\nBase: main\n\n## GOAL\nShip one.\n\n## END STATE\nThe proof passes.";

async function seedDefaultBoard(node: ReturnType<typeof fakeNode>): Promise<void> {
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
  await node.createRecord({
    schemaHash: cfg.schemaHashes.milestone!,
    keyHash: MILESTONE,
    fields: milestoneToFields({
      slug: MILESTONE,
      title: "Delivery v1",
      body: "Outcome: The flow proof passes.",
      board: "default",
      state: "active",
      position: "1",
      north_star: "north-star-delivery",
      driver: "last-stack-milestone-driver",
      deps: [],
      proof_card: "",
      proof_status: "pending",
      block_reason: "",
      created_at: now,
      updated_at: now,
      completed_at: "",
    }),
  });
}

function card(overrides: Partial<Card> = {}): Card {
  return {
    slug: "ship-one",
    title: "Ship one",
    body: "## GOAL\nShip one.\n\n## END STATE\nThe proof passes.",
    board: "default",
    column: "todo",
    position: "1",
    assignee: "",
    tags: ["p0"],
    deps: [],
    surfaces: [],
    created_at: "2026-08-31T10:00:00.000Z",
    created_by: "test",
    updated_at: "2026-08-31T10:00:00.000Z",
    done_at: "",
    repo: "EdgeVector/fkanban",
    db: "",
    base: "main",
    kind: "pr",
    block_status: "none",
    block_reason: "",
    north_star: "north-star-delivery",
    milestone: MILESTONE,
    pr_url: "",
    branch: "",
    ...overrides,
  };
}

describe("keyed feature-flow ledger", () => {
  test("uses stable event keys and does not duplicate a retried create", async () => {
    const node = fakeNode({ hashFields: { [FLOW_HASH]: "milestone" } });
    const created = card();

    const first = await recordFeatureFlowMutation({
      cfg,
      node,
      previous: null,
      next: created,
      now: "2026-08-31T10:00:01.000Z",
    });
    const retry = await recordFeatureFlowMutation({
      cfg,
      node,
      previous: created,
      next: created,
      now: "2026-08-31T10:00:02.000Z",
    });

    expect(first.recorded).toEqual(["create"]);
    expect(retry.recorded).toEqual([]);
    expect(node.rowsOf(FLOW_HASH).map((row) => row.rangeKey).sort()).toEqual([
      featureFlowCurrentKey(created.slug),
      featureFlowEventKey(created.slug, 0, "create"),
    ].sort());
  });

  test("records claim, review, done, reopen, and a new generation", async () => {
    const node = fakeNode({ hashFields: { [FLOW_HASH]: "milestone" } });
    const created = card();
    const claimed = card({
      column: "doing",
      assignee: "worker-1",
      updated_at: "2026-08-31T10:10:00.000Z",
    });
    const review = card({
      ...claimed,
      pr_url: "lastgit://fkanban/cr/example",
      updated_at: "2026-08-31T10:20:00.000Z",
    });
    const done = card({
      ...review,
      column: "done",
      done_at: "2026-08-31T10:30:00.000Z",
      updated_at: "2026-08-31T10:30:00.000Z",
    });
    const reopened = card({
      ...done,
      column: "todo",
      assignee: "",
      done_at: "",
      updated_at: "2026-08-31T10:40:00.000Z",
    });
    const reclaimed = card({
      ...reopened,
      column: "doing",
      assignee: "worker-2",
      updated_at: "2026-08-31T10:50:00.000Z",
    });
    const redone = card({
      ...reclaimed,
      column: "done",
      done_at: "2026-08-31T11:00:00.000Z",
      updated_at: "2026-08-31T11:00:00.000Z",
    });

    await recordFeatureFlowMutation({ cfg, node, previous: null, next: created });
    await recordFeatureFlowMutation({ cfg, node, previous: created, next: claimed });
    await recordFeatureFlowMutation({ cfg, node, previous: claimed, next: review });
    await recordFeatureFlowMutation({ cfg, node, previous: review, next: done });
    await recordFeatureFlowMutation({ cfg, node, previous: done, next: reopened });
    await recordFeatureFlowMutation({ cfg, node, previous: reopened, next: reclaimed });
    await recordFeatureFlowMutation({ cfg, node, previous: reclaimed, next: redone });

    const keys = node.rowsOf(FLOW_HASH).map((row) => row.rangeKey);
    expect(keys).toContain(featureFlowEventKey(created.slug, 0, "create"));
    expect(keys).toContain(featureFlowEventKey(created.slug, 0, "claim"));
    expect(keys).toContain(featureFlowEventKey(created.slug, 0, "review"));
    expect(keys).toContain(featureFlowEventKey(created.slug, 0, "done"));
    expect(keys).toContain(featureFlowEventKey(created.slug, 1, "reopen"));
    expect(keys).toContain(featureFlowEventKey(created.slug, 1, "claim"));
    expect(keys).toContain(featureFlowEventKey(created.slug, 1, "done"));

    const current = node.rowAt(FLOW_HASH, MILESTONE, featureFlowCurrentKey(created.slug));
    expect(current?.fields.generation).toBe("1");
    expect(current?.fields.stage).toBe("done");
  });

  test("reports one milestone partition and excludes done cards from oldest wait", async () => {
    const node = fakeNode({ hashFields: { [FLOW_HASH]: "milestone" } });
    const waiting = card();
    const finished = card({
      slug: "ship-two",
      column: "done",
      done_at: "2026-08-31T10:20:00.000Z",
      updated_at: "2026-08-31T10:20:00.000Z",
    });
    await recordFeatureFlowMutation({ cfg, node, previous: null, next: waiting });
    await recordFeatureFlowMutation({ cfg, node, previous: null, next: finished });
    node.reads.length = 0;

    const report = await featureFlowReport({
      cfg,
      node,
      milestone: MILESTONE,
      now: "2026-08-31T11:00:00.000Z",
    });

    expect(node.reads).toHaveLength(1);
    expect(node.reads[0]?.schemaHash).toBe(FLOW_HASH);
    expect(node.reads[0]?.filter).toEqual({ HashKey: MILESTONE });
    expect(report.cards).toHaveLength(2);
    expect(report.oldest_wait?.card_slug).toBe(waiting.slug);
    expect(report.oldest_wait?.stage).toBe("create");
    expect(report.oldest_wait?.elapsed_seconds).toBe(3600);
  });

  test("records live add, atomic claim, review metadata, and done transitions", async () => {
    const node = fakeNode({ hashFields: { [FLOW_HASH]: "milestone" } });
    await seedDefaultBoard(node);

    await addCmd({
      cfg,
      node,
      slug: "wired-card",
      title: "Wired card",
      column: "todo",
      body: pickupBody,
      northStar: "north-star-delivery",
      milestone: MILESTONE,
    });
    await claimCard({ cfg, node, slug: "wired-card", worker: "worker-1" });
    await addCmd({
      cfg,
      node,
      slug: "wired-card",
      prUrl: "lastgit://fkanban/cr/wired",
    });
    await moveCmd({ cfg, node, slug: "wired-card", column: "done" });

    const keys = node.rowsOf(FLOW_HASH).map((row) => row.rangeKey);
    expect(keys).toContain(featureFlowEventKey("wired-card", 0, "create"));
    expect(keys).toContain(featureFlowEventKey("wired-card", 0, "claim"));
    expect(keys).toContain(featureFlowEventKey("wired-card", 0, "review"));
    expect(keys).toContain(featureFlowEventKey("wired-card", 0, "done"));
    expect(node.rowAt(FLOW_HASH, MILESTONE, featureFlowCurrentKey("wired-card"))?.fields.stage).toBe("done");
  });

  test("does not write when the rollout schema is not bound", async () => {
    const node = fakeNode();
    const unbound = { ...cfg, schemaHashes: {} };
    const result = await recordFeatureFlowMutation({
      cfg: unbound,
      node,
      previous: null,
      next: card(),
    });

    expect(result.configured).toBe(false);
    expect(node.writes).toEqual([]);
    expect(featureFlowReport({ cfg: unbound, node, milestone: MILESTONE })).rejects.toMatchObject({
      code: "feature_flow_schema_unbound",
    });
  });

  test("reports a partial ledger write after the authoritative card write", async () => {
    const node = fakeNode({
      hashFields: { [FLOW_HASH]: "milestone" },
      overrides: {
        updateRecord: async () => {
          throw new Error("node refused ledger write");
        },
      },
    });

    try {
      await recordFeatureFlowMutation({ cfg, node, previous: null, next: card() });
      throw new Error("expected feature_flow_partial_write");
    } catch (error) {
      expect(error).toBeInstanceOf(FkanbanError);
      expect((error as FkanbanError).code).toBe("feature_flow_partial_write");
    }
  });

  test("an idempotent retry heals a review event whose current-row write failed", async () => {
    const node = fakeNode({ hashFields: { [FLOW_HASH]: "milestone" } });
    const created = card();
    const claimed = card({
      column: "doing",
      assignee: "worker-1",
      updated_at: "2026-08-31T10:10:00.000Z",
    });
    const review = card({
      ...claimed,
      pr_url: "lastgit://fkanban/cr/review-retry",
      updated_at: "2026-08-31T10:20:00.000Z",
    });
    await recordFeatureFlowMutation({ cfg, node, previous: null, next: created });
    await recordFeatureFlowMutation({ cfg, node, previous: created, next: claimed });

    const updateRecord = node.updateRecord.bind(node);
    let failCurrentOnce = true;
    node.updateRecord = async (args) => {
      if (failCurrentOnce && args.rangeKey === featureFlowCurrentKey(review.slug)) {
        failCurrentOnce = false;
        throw new Error("current row refused");
      }
      return updateRecord(args);
    };
    expect(recordFeatureFlowMutation({ cfg, node, previous: claimed, next: review })).rejects.toMatchObject({
      code: "feature_flow_partial_write",
    });

    const retry = card({ ...review, updated_at: "2026-08-31T10:25:00.000Z" });
    const result = await recordFeatureFlowMutation({ cfg, node, previous: review, next: retry });
    const current = node.rowAt(FLOW_HASH, MILESTONE, featureFlowCurrentKey(review.slug));

    expect(result.recorded).toEqual([]);
    expect(current?.fields.stage).toBe("review");
    expect(current?.fields.event_at).toBe("2026-08-31T10:20:00.000Z");
  });
});
