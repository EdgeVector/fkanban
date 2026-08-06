// `listBoardMilestonesPartition` returns null from a bare `catch {}`, so a
// `service_timeout` / "too many concurrent reads" — documented in CLAUDE.md as
// ordinary backpressure on this node — is indistinguishable from an empty
// index. Every branch downstream degraded safely and none of them said so.
//
// Why this read and not the enumeration sweep, which already warns: measured on
// the primary 2026-08-06 (`scripts/probe-milestone-heal-partition-read-blind.ts`),
// of 66 live milestones the sweep reaches 3 and the index read supplies the
// other 63. The warning was on the read worth 5% of the reach.

import { describe, expect, test } from "bun:test";

import type { Config } from "../src/config.ts";
import type { NodeClient } from "../src/client.ts";
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

async function seedBoardAndMilestone(node: FakeNode, slug: string): Promise<void> {
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
  await milestoneAddCmd({
    cfg,
    node,
    slug,
    title: `Milestone ${slug}`,
    state: "active",
    northStar: "north-star-heal",
    driver: "last-stack-milestone-driver",
  });
  const milestone = await findMilestone(node, cfg, slug);
  if (!milestone) throw new Error("seed milestone missing");
  node.seed({
    schemaHash: cfg.schemaHashes.board_milestones!,
    keyHash: milestone.board || "default",
    rangeKey: boardMilestoneSk(milestone.state, milestone.position, milestone.slug),
    fields: { ...boardMilestoneFieldsFromMilestone(milestone), completed_at: milestone.completed_at },
  });
}

/**
 * Wrap a node so BoardMilestones partition queries throw the way the primary
 * does under load. Only that schema, and only the keyed partition read — the
 * point-reads this command uses for truth still work, which is the real shape:
 * the node sheds a broad query and answers a narrow one.
 */
function failsBoardMilestonesPartitionRead(node: FakeNode): NodeClient {
  return new Proxy(node, {
    get(target, prop, receiver) {
      if (prop !== "queryAll") return Reflect.get(target, prop, receiver);
      return async (req: Parameters<NodeClient["queryAll"]>[0]) => {
        const filter = req.filter as { HashKey?: unknown } | undefined;
        if (req.schemaHash === cfg.schemaHashes.board_milestones && filter?.HashKey !== undefined) {
          throw new Error("service_timeout: node did not respond within 30000ms");
        }
        return await target.queryAll(req);
      };
    },
  }) as unknown as NodeClient;
}

describe("milestone-indexes-heal: a failed index partition read is not silence", () => {
  test("reports the boards it could not read", async () => {
    const node = fakeNode();
    await seedBoardAndMilestone(node, "ms-read-fail");

    const result = await milestoneIndexesHealResult({
      cfg,
      node: failsBoardMilestonesPartitionRead(node),
      apply: false,
    });

    expect(result.index_read_failed_boards).toEqual(["default"]);
  });

  test("names the consequence in the rendered text, not only in JSON", async () => {
    const node = fakeNode();
    await seedBoardAndMilestone(node, "ms-read-fail");

    const result = await milestoneIndexesHealResult({
      cfg,
      node: failsBoardMilestonesPartitionRead(node),
      apply: false,
    });

    expect(result.text).toContain("INDEX READ INCOMPLETE");
    expect(result.text).toContain("default");
    // The consequence, not just the fact. An operator who reads only this block
    // has to learn that repair did not happen and that the upsert count below
    // is not a drift measurement.
    expect(result.text).toContain("Nothing on those boards was repaired");
    expect(result.text).toMatch(/UNVERIFIED rewrites/);
  });

  test("the warning sits on its own line, above the counts it qualifies", async () => {
    const node = fakeNode();
    await seedBoardAndMilestone(node, "ms-read-fail");

    const result = await milestoneIndexesHealResult({
      cfg,
      node: failsBoardMilestonesPartitionRead(node),
      apply: false,
    });

    const lines = result.text.split("\n");
    const warnAt = lines.findIndex((l) => l.includes("INDEX READ INCOMPLETE"));
    const countsAt = lines.findIndex((l) => l.includes("board_milestones bound="));
    expect(warnAt).toBeGreaterThanOrEqual(0);
    expect(countsAt).toBeGreaterThanOrEqual(0);
    // A caveat appended to a line opening `bound=true scanned=N` reads as part
    // of the good news — the mistake `board_cards_heal_scheduled` made with the
    // word `clean`.
    expect(warnAt).toBeLessThan(countsAt);
    expect(lines[countsAt]).not.toContain("INDEX READ INCOMPLETE");
  });

  // Deliberately asserts on the TEXT only, and deliberately does not mention
  // the new field: a gate that fires on every run gets muted within a week, so
  // the test guarding against that has to keep passing when the feature is
  // absent. Asserting `index_read_failed_boards` here too would make it fail
  // under revert and stop being a twin. The field's empty case is the next test.
  test("a healthy run says nothing — the gate must stay quiet to stay read", async () => {
    const node = fakeNode();
    await seedBoardAndMilestone(node, "ms-read-fail");

    const result = await milestoneIndexesHealResult({ cfg, node, apply: false });

    expect(result.text).not.toContain("INDEX READ INCOMPLETE");
  });

  test("a healthy run reports an empty failed-board list, not a missing one", async () => {
    const node = fakeNode();
    await seedBoardAndMilestone(node, "ms-read-fail");

    const result = await milestoneIndexesHealResult({ cfg, node, apply: false });

    expect(result.index_read_failed_boards).toEqual([]);
  });

  test("still repairs what it CAN see — the fix reports, it does not refuse", async () => {
    const node = fakeNode();
    await seedBoardAndMilestone(node, "ms-read-fail");

    const result = await milestoneIndexesHealResult({
      cfg,
      node: failsBoardMilestonesPartitionRead(node),
      apply: false,
    });

    // heal under-repairing is safe; heal not running is not. The swept
    // milestone is still classified rather than abandoned.
    expect(result.milestones_scanned).toBeGreaterThan(0);
    expect(result.board_milestone_upserts).toBeGreaterThan(0);
  });

  test("an unreadable board contributes no removals — the safe direction is kept", async () => {
    const node = fakeNode();
    await seedBoardAndMilestone(node, "ms-read-fail");

    const result = await milestoneIndexesHealResult({
      cfg,
      node: failsBoardMilestonesPartitionRead(node),
      apply: false,
    });

    expect(result.board_milestone_removals).toBe(0);
  });

  test("the refusal text redirects to the read when a read failed", async () => {
    const node = fakeNode();
    await seedBoardAndMilestone(node, "ms-read-fail");

    // A SECOND board that reads fine and holds one genuinely orphaned row.
    // Removals can only come from a board that answered, so reaching the
    // refusal at all requires both halves: one board shed, one board readable
    // with something to delete. That is also the real hazard — the shed read
    // shrinks `rows_examined`, and the other board's ordinary cleanup then
    // trips a ceiling it would not otherwise have hit.
    const now = nowIso();
    await node.createRecord({
      schemaHash: cfg.schemaHashes.board!,
      keyHash: "other",
      fields: boardToFields({
        slug: "other",
        title: "Other",
        body: "",
        columns: [...DEFAULT_COLUMNS],
        created_at: now,
        updated_at: now,
      }),
    });
    node.seed({
      schemaHash: cfg.schemaHashes.board_milestones!,
      keyHash: "other",
      rangeKey: boardMilestoneSk("active", "m", "ms-long-deleted"),
      fields: {
        board: "other",
        slug: "ms-long-deleted",
        state: "active",
        position: "m",
        sk: boardMilestoneSk("active", "m", "ms-long-deleted"),
        title: "Deleted milestone",
        layout: "",
      },
    });

    // Pin the ceiling at 0 so the one legitimate removal refuses the apply.
    // Without the redirect the operator is told the classifier is implausible
    // and to raise --max-removals — advice that points away from a shed read,
    // which is what actually shrank `rows_examined`.
    const failing = new Proxy(node, {
      get(target, prop, receiver) {
        if (prop !== "queryAll") return Reflect.get(target, prop, receiver);
        return async (req: Parameters<NodeClient["queryAll"]>[0]) => {
          const filter = req.filter as { HashKey?: unknown } | undefined;
          if (req.schemaHash === cfg.schemaHashes.board_milestones && filter?.HashKey === "default") {
            throw new Error("service_timeout: node did not respond within 30000ms");
          }
          return await target.queryAll(req);
        };
      },
    }) as unknown as NodeClient;

    const result = await milestoneIndexesHealResult({
      cfg,
      node: failing,
      apply: true,
      maxRemovals: 0,
      maxRepairs: 0,
    });

    expect(result.index_read_failed_boards).toEqual(["default"]);
    expect(result.removals_classified).toBeGreaterThan(0);
    expect(result.blocked).toBe(true);
    expect(result.text).toContain("READ THIS FIRST");
    expect(result.text).toContain("Retry under lighter load");
  });
});
