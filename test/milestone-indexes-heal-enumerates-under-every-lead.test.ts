// `groom milestone-indexes-heal` must enumerate repair candidates under EVERY
// lead, not under the widest projection.
//
// The heal used one full scan at `fields: fieldsFor("milestone")`, on the
// reasoning that the widest projection must see the most rows. In LastDB's atom
// model the opposite holds: every projected field GATES on its atom, and the
// gate is the hash field whenever it is projected (`test/fake-node.ts` header;
// `kanban doctor` states the same rule for BoardCards). `slug` IS the fat
// Milestone hash field, so the widest projection was gated on the sparsest
// possible field and enumerated no more than `["slug"]` alone.
//
// Measured on the primary 2026-08-05 (`scripts/probe-milestone-scan-lead-recall.ts`),
// 15 leads, 0 refused:
//
//   fieldsFor("milestone")  15 fields  ->   74 slugs   <- what heal enumerated
//   ["slug"]                 1 field   ->   74 slugs   <- identical: slug is the gate
//   ["title"]                1 field   ->  134 slugs
//   union of all 15 leads               -> 1478 slugs
//
// Five of the union-only slugs point-read back to LIVE milestones that were in
// neither the scan nor BoardMilestones — so they were in heal's candidate set
// (scan ∪ index) not at all, no repair path could reach them, and heal still
// printed `upserts=0` and exited 0. `milestone show` opened every one. That is
// the mechanism behind four recurrences of the `milestone list` / `portfolio`
// undercount (2026-08-02/03/04, and again on 08-05 after the create-time index
// fix had merged).
//
// The fix is recall, not truth: the sweep only supplies CANDIDATES, and every
// candidate is still point-read before it is believed.

import { describe, expect, test } from "bun:test";

import type { Config } from "../src/config.ts";
import { milestoneIndexesHealResult } from "../src/commands/milestone_indexes_heal.ts";
import { listBoardMilestonesPartition } from "../src/board-milestones.ts";
import { boardToFields, milestoneToFields, nowIso, sweepMilestoneSlugs } from "../src/record.ts";
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
 * A node whose fat-`Milestone` FULL SCAN drops `hidden` when the projection is
 * led by `slug`, while every other lead — and any HashKey read — still returns
 * it.
 *
 * This models the measured primary rather than deleting the row's `slug` atom.
 * The distinction matters and a first draft of this test got it wrong: on the
 * live primary all five invisible milestones point-read back LIVE through
 * `findMilestone`, which projects `fieldsFor("milestone")` — so the gate that
 * hid them binds ENUMERATION, not ADDRESSING. A test that dropped the atom
 * would also break the point-read, and would then be asserting on a milestone
 * heal is right to classify as a husk. Same caution as
 * `milestone-indexes-heal-scan-absence-is-not-deletion.test.ts`.
 */
function nodeWithSlugLeadBlindSpot(hidden: string): FakeNode {
  const node = fakeNode({ dropIncompleteRows: false });
  const inner = node.queryAll.bind(node);
  node.queryAll = (async (req: Parameters<FakeNode["queryAll"]>[0]) => {
    const res = await inner(req);
    const isMilestoneFullScan =
      req.schemaHash === cfg.schemaHashes.milestone &&
      (req.filter as { HashKey?: string } | undefined)?.HashKey === undefined;
    const ledBySlug = ((req.fields ?? []) as string[]).includes("slug");
    if (!isMilestoneFullScan || !ledBySlug) return res;
    const results = res.results.filter((row) => (row.key?.hash ?? "") !== hidden);
    return { ...res, results, returned_count: results.length, total_count: results.length };
  }) as FakeNode["queryAll"];
  return node;
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

/** A live, complete, point-readable milestone with no BoardMilestones row. */
function seedMilestone(node: FakeNode, slug: string): void {
  const now = nowIso();
  const fields = milestoneToFields({
    slug,
    title: `Milestone ${slug}`,
    body: "",
    board: "default",
    state: "active",
    position: "1700000000000",
    north_star: "north-star-heal",
    driver: "last-stack-milestone-driver",
    deps: [],
    proof_card: "",
    proof_status: "pending",
    block_reason: "",
    created_at: now,
    updated_at: now,
    completed_at: "",
  });
  node.seed({ schemaHash: cfg.schemaHashes.milestone!, keyHash: slug, fields });
}

describe("milestone-indexes-heal enumerates under every lead", () => {
  test("key-list sweep reaches every seeded milestone without field-gated scans", async () => {
    const node = fakeNode({ dropIncompleteRows: false });
    seedMilestone(node, "ms-slug-gated");
    seedMilestone(node, "ms-plain");

    // Precondition: a slug-led unfiltered query still has the historical blind
    // spot under hash_else_lead — but heal no longer uses that path.
    const nodeBlind = nodeWithSlugLeadBlindSpot("ms-slug-gated");
    seedMilestone(nodeBlind, "ms-slug-gated");
    seedMilestone(nodeBlind, "ms-plain");
    const slugLed = await nodeBlind.queryAll({
      schemaHash: cfg.schemaHashes.milestone!,
      fields: ["slug"],
    });
    expect(slugLed.results.map((r) => r.key?.hash)).toEqual(["ms-plain"]);

    const sweep = await sweepMilestoneSlugs(node, cfg);
    expect(sweep.slugs.sort()).toEqual(["ms-plain", "ms-slug-gated"]);
    expect(sweep.wideScanSlugs).toBe(2);
    expect(sweep.failedLeads).toHaveLength(0);
  });

  test("heal repairs the BoardMilestones row for a milestone only the sweep can enumerate", async () => {
    const node = nodeWithSlugLeadBlindSpot("ms-slug-gated");
    await seedBoard(node);
    seedMilestone(node, "ms-slug-gated");

    // Red baseline: the milestone has no index row, so `milestone list` and
    // `milestone portfolio` cannot see it.
    expect(await listBoardMilestonesPartition(node, cfg, "default")).toEqual([]);

    const healed = await milestoneIndexesHealResult({ cfg, node, apply: true });

    // Key-list enumeration reaches the live milestone even when a slug-led
    // queryAll would have dropped it.
    expect(healed.milestones_enumerated).toBe(1);
    expect(healed.milestones_enumerated_single_lead).toBe(1);
    expect(healed.board_milestone_upserts).toBe(1);
    expect(healed.board_milestone_removals).toBe(0);

    const rows = await listBoardMilestonesPartition(node, cfg, "default");
    expect(rows?.map((m) => m.slug)).toContain("ms-slug-gated");
  });

  test("a refused key list makes the enumeration a declared lower bound, not a clean run", async () => {
    const node = fakeNode({ dropIncompleteRows: false });
    await seedBoard(node);
    seedMilestone(node, "ms-slug-gated");

    const listInner = node.listRecordKeys!.bind(node);
    node.listRecordKeys = (async (schemaHash, opts) => {
      if (schemaHash === cfg.schemaHashes.milestone) throw new Error("service_timeout");
      return listInner(schemaHash, opts);
    }) as FakeNode["listRecordKeys"];

    const healed = await milestoneIndexesHealResult({ cfg, node, apply: false });

    expect(healed.enumeration_failed_leads.map((l) => l.field)).toContain("listRecordKeys");
    expect(healed.text).toContain("LOWER BOUND");
  });
});
