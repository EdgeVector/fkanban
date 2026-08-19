// `groom milestone-indexes-heal` must never DELETE a BoardMilestones row on the
// authority of the fat-`Milestone` full scan.
//
// The heal rebuilds from `Milestone` with `` and then treats
// "slug absent from that scan" as authority to remove the slug's index row. But
// that scan is documented-unreliable on the live primary: it returns husks of
// DELETED milestones and MISSES live ones
// (`scripts/probe-milestone-membership-parity.ts` preamble, 2026-08-01;
// `papercut-kanban-milestone-full-scan-returns-husks-and-misses-live-rows`).
//
// Measured on the primary 2026-08-03 (`scripts/probe-milestone-heal-truth-drop.ts`):
// the scan enumerated 17 slugs against 38 BoardMilestones rows, so heal proposed
// 33 removals — and a HashKey point-read (`findMilestone`) confirmed **all 33**
// were LIVE milestones, 0 genuinely gone. `groom milestone-indexes-heal` with no
// flags applies (`apply: !values["dry-run"]`) at a default budget of 25, so one
// run would have deleted 25 live rows from the index that `milestone list`,
// `milestone portfolio` and pickup's milestone-linkage gate all read.
//
// The difference is NOT projection width — `findMilestone` uses the same
// `fieldsFor("milestone")` set. It is full-scan enumeration vs. HashKey
// addressing. So absence from the scan is not evidence of deletion; a point-read
// returning null is. That is the same refusal `deleteCardRecord` already makes
// ("one narrow point-read is the cheapest honest answer available").

import { describe, expect, test } from "bun:test";

import type { Config } from "../src/config.ts";
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

/**
 * A node whose `Milestone` FULL SCAN omits `hidden`, while a HashKey read of the
 * same schema at the same projection still returns it.
 *
 * This models the measured primary behaviour rather than the fake's default
 * projection rule: the gap that produced the live 33-row removal set is
 * enumeration vs. addressing, so a test that reproduced it by dropping a field
 * would be testing a different bug.
 */
function nodeWithScanBlindSpot(hidden: string): FakeNode {
  const node = fakeNode({ dropIncompleteRows: false });
  const inner = node.queryAll.bind(node);
  node.queryAll = (async (req: Parameters<FakeNode["queryAll"]>[0]) => {
    const res = await inner(req);
    const isMilestoneFullScan =
      req.schemaHash === cfg.schemaHashes.milestone &&
      (req.filter as { HashKey?: string } | undefined)?.HashKey === undefined;
    if (!isMilestoneFullScan) return res;
    const results = res.results.filter(
      (row) => String((row.fields as Record<string, unknown>)?.slug ?? "") !== hidden,
    );
    return { ...res, results, returned_count: results.length, total_count: results.length };
  }) as FakeNode["queryAll"];
  return node;
}

async function seedMilestoneWithIndexRow(node: FakeNode, slug: string): Promise<void> {
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
  if (!milestone) throw new Error(`seed milestone ${slug} missing`);
  node.seed({
    schemaHash: cfg.schemaHashes.board_milestones!,
    keyHash: milestone.board || "default",
    rangeKey: boardMilestoneSk(milestone.state, milestone.position, milestone.slug),
    fields: { ...boardMilestoneFieldsFromMilestone(milestone), completed_at: milestone.completed_at },
  });
}

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

describe("milestone-indexes-heal: scan absence is not deletion evidence", () => {
  test("a live milestone the full scan misses keeps its BoardMilestones row", async () => {
    const node = nodeWithScanBlindSpot("ms-scan-invisible");
    await seedBoard(node);
    await seedMilestoneWithIndexRow(node, "ms-visible");
    await seedMilestoneWithIndexRow(node, "ms-scan-invisible");

    // Precondition: the blind spot is real — the scan cannot see it, a point
    // read can. Without this the test could pass for the wrong reason.
    const scan = await node.queryAll({
      schemaHash: cfg.schemaHashes.milestone!,
      fields: ["slug"]
    });
    const scanned = scan.results.map((r) => String((r.fields as Record<string, unknown>).slug ?? ""));
    expect(scanned).toContain("ms-visible");
    expect(scanned).not.toContain("ms-scan-invisible");
    expect(await findMilestone(node, cfg, "ms-scan-invisible")).not.toBeNull();

    const healed = await milestoneIndexesHealResult({ cfg, node, apply: false });

    expect(healed.board_milestone_removals).toBe(0);
  });

  test("a milestone that is genuinely gone is still removed", async () => {
    const node = fakeNode({ dropIncompleteRows: false });
    await seedBoard(node);
    await seedMilestoneWithIndexRow(node, "ms-visible");

    // An index row whose Milestone record never existed — the case removal is
    // FOR. Narrowing the removal rule must not disarm it.
    node.seed({
      schemaHash: cfg.schemaHashes.board_milestones!,
      keyHash: "default",
      rangeKey: boardMilestoneSk("active", "0000000001", "ms-truly-gone"),
      fields: {
        board: "default",
        sk: boardMilestoneSk("active", "0000000001", "ms-truly-gone"),
        slug: "ms-truly-gone",
        title: "Gone",
        state: "active",
        position: "0000000001",
      },
    });

    expect(await findMilestone(node, cfg, "ms-truly-gone")).toBeNull();

    const healed = await milestoneIndexesHealResult({ cfg, node, apply: false });

    expect(healed.board_milestone_removals).toBe(1);
  });
});

// Refusing to delete on scan-absence stopped the damage, but left those rows
// unreachable by REPAIR too: the upsert loop only ever walked the scan's own
// results, so a STALE row for a milestone the scan misses stayed stale forever
// while the command reported success. Measured on the primary 2026-08-03
// (`scripts/probe-milestone-heal-hydrate-drop.ts`): the scan enumerated 21
// slugs, 10 point-read back live and 11 were husks, against 38 live milestones
// — ~26% recall, so ~74% of the index was outside the repair set.
//
// The removal loop was ALREADY point-reading each of those rows to prove it
// must not delete them, then discarding the truth. Widening the upsert set from
// that same read costs no additional node reads.
describe("milestone-indexes-heal: a scan-invisible milestone is still repairable", () => {
  test("a STALE row for a milestone the scan misses is upserted, not left stale", async () => {
    const node = nodeWithScanBlindSpot("ms-scan-invisible");
    await seedBoard(node);
    await seedMilestoneWithIndexRow(node, "ms-visible");
    await seedMilestoneWithIndexRow(node, "ms-scan-invisible");

    // Make the index row DISAGREE with the fat record it mirrors. This is the
    // drift a repair command exists to correct.
    const truth = await findMilestone(node, cfg, "ms-scan-invisible");
    if (!truth) throw new Error("seed missing");
    node.seed({
      schemaHash: cfg.schemaHashes.board_milestones!,
      keyHash: truth.board || "default",
      rangeKey: boardMilestoneSk(truth.state, truth.position, truth.slug),
      fields: {
        ...boardMilestoneFieldsFromMilestone(truth),
        completed_at: truth.completed_at,
        title: "STALE TITLE — drifted from the fat record",
      },
    });

    // Precondition: invisible to the scan, addressable by point-read. Without
    // this the test could pass for the wrong reason.
    const scan = await node.queryAll({
      schemaHash: cfg.schemaHashes.milestone!,
      fields: ["slug"]
    });
    const scanned = scan.results.map((r) => String((r.fields as Record<string, unknown>).slug ?? ""));
    expect(scanned).not.toContain("ms-scan-invisible");

    const healed = await milestoneIndexesHealResult({ cfg, node, apply: false });

    // Repaired, not deleted — and the row it could not see is the one repaired.
    expect(healed.board_milestone_upserts).toBe(1);
    expect(healed.board_milestone_removals).toBe(0);
  });

  test("an in-sync row the scan misses is left alone — no churn", async () => {
    const node = nodeWithScanBlindSpot("ms-scan-invisible");
    await seedBoard(node);
    await seedMilestoneWithIndexRow(node, "ms-visible");
    await seedMilestoneWithIndexRow(node, "ms-scan-invisible");

    const healed = await milestoneIndexesHealResult({ cfg, node, apply: false });

    // Recovering candidates from the index must not turn every unseen row into
    // a write. Only genuine drift is repaired.
    expect(healed.board_milestone_upserts).toBe(0);
    expect(healed.board_milestone_removals).toBe(0);
  });

  test("husks dropped during hydration are counted, not silent", async () => {
    const node = fakeNode({ dropIncompleteRows: false });
    await seedBoard(node);
    await seedMilestoneWithIndexRow(node, "ms-visible");

    const healed = await milestoneIndexesHealResult({ cfg, node, apply: false });

    // `scanned` is the count that point-read back to a live milestone; the
    // enumeration it came from is reported separately so an operator can tell
    // "the scan found 1" from "the scan found 20 and 19 were husks".
    expect(healed.milestones_scanned).toBe(1);
    expect(healed.milestones_enumerated).toBe(1);
    expect(healed.milestone_husks_dropped).toBe(0);
  });
});
