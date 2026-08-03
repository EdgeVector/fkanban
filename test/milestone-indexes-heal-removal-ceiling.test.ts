// `groom milestone-indexes-heal` must REFUSE an apply that wants to delete an
// implausible share of the index, rather than ration the deletions and exit 0.
//
// The command applies by default (`apply: !values["dry-run"]`) and, until this
// ceiling, its only brake was `--max-repairs` — a per-run WRITE BUDGET, which
// caps how many deletions a bad classification lands but never refuses one.
// Measured on the primary 2026-08-03 (`scripts/probe-milestone-heal-truth-drop.ts`):
// 17 slugs scanned against 38 BoardMilestones rows produced 33 proposed
// removals, and a HashKey point-read confirmed all 33 were LIVE. At the default
// budget of 25 a bare `groom milestone-indexes-heal` would have deleted 25 live
// rows from the index behind `milestone list`, `milestone portfolio` and
// pickup's milestone-linkage gate — and printed a successful repair.
//
// The classifier bug that produced that set is fixed (`ab5d2287`), which
// removed the instance. This ceiling is the structural guard: nothing in the
// command could notice that 33 of 38 rows is not a plausible repair.
//
// Two properties matter and are tested separately, because the obvious guard
// gets the second one wrong. The brake is on REMOVALS, not on total drift: on a
// first heal `BoardMilestones` is empty and every live milestone classifies as
// an upsert, so a flat `--max-drift` low enough to catch 33-of-38 would refuse
// the legitimate bootstrap.

import { describe, expect, test } from "bun:test";

import type { Config } from "../src/config.ts";
import { milestoneAddCmd } from "../src/commands/milestone.ts";
import {
  milestoneIndexesHealResult,
  milestoneIndexesHealRemovalCeiling,
  DEFAULT_MILESTONE_INDEXES_HEAL_REMOVAL_FLOOR,
} from "../src/commands/milestone_indexes_heal.ts";
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

/** A live milestone whose index row agrees with it — neither upsert nor removal. */
async function seedHealthyMilestone(node: FakeNode, slug: string): Promise<void> {
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

/** An index row whose Milestone record does not exist — a genuine removal candidate. */
function seedOrphanIndexRow(node: FakeNode, slug: string, position: string): void {
  node.seed({
    schemaHash: cfg.schemaHashes.board_milestones!,
    keyHash: "default",
    rangeKey: boardMilestoneSk("active", position, slug),
    fields: {
      board: "default",
      sk: boardMilestoneSk("active", position, slug),
      slug,
      title: `Orphan ${slug}`,
      state: "active",
      position,
    },
  });
}

const pad = (n: number): string => String(n).padStart(10, "0");

function deletesTo(node: FakeNode, schemaHash: string): number {
  return node.writes.filter((w) => w.op === "delete" && w.schemaHash === schemaHash).length;
}

describe("milestone-indexes-heal: the removal ceiling refuses implausible deletion", () => {
  test("an apply that wants most of the index gone writes NOTHING", async () => {
    const node = fakeNode({ dropIncompleteRows: false });
    await seedBoard(node);
    await seedHealthyMilestone(node, "ms-live-a");
    await seedHealthyMilestone(node, "ms-live-b");
    for (let i = 0; i < 10; i++) seedOrphanIndexRow(node, `ms-orphan-${i}`, pad(100 + i));

    // 12 index rows examined -> ceiling max(5, floor(0.25*12)=3) = 5, and the
    // run classifies 10 removals. Pinned explicitly so a change to the ratio or
    // floor fails HERE, where the arithmetic is stated, rather than silently
    // turning the assertions below into a different test.
    expect(milestoneIndexesHealRemovalCeiling(12)).toBe(5);

    // Seeding the board and the fat Milestone records are themselves writes, so
    // "the heal wrote nothing" is a DELTA from here, not an absolute zero.
    const before = node.writes.length;
    const healed = await milestoneIndexesHealResult({ cfg, node, apply: true });

    expect(healed.removals_classified).toBe(10);
    expect(healed.rows_examined).toBe(12);
    expect(healed.removal_ceiling).toBe(5);
    expect(healed.blocked).toBe(true);

    // The report flags are not the property under test — the absence of writes
    // is. A guard that sets `blocked` and deletes anyway would pass every
    // assertion above.
    expect(healed.applied).toBe(false);
    expect(healed.issued).toBe(0);
    expect(deletesTo(node, cfg.schemaHashes.board_milestones!)).toBe(0);
    expect(node.writes.length).toBe(before);
    expect(healed.text).toContain("REFUSED");
  });

  test("refusing is wholesale: the run's upserts do not slip through with its removals", async () => {
    const node = fakeNode({ dropIncompleteRows: false });
    await seedBoard(node);
    // One live milestone with NO index row — a legitimate pending upsert — in a
    // run whose removals blow the ceiling. An implementation that dropped only
    // the removals would still issue this write.
    await milestoneAddCmd({
      cfg,
      node,
      slug: "ms-needs-upsert",
      title: "Needs upsert",
      state: "active",
      northStar: "north-star-heal",
      driver: "last-stack-milestone-driver",
    });
    for (let i = 0; i < 10; i++) seedOrphanIndexRow(node, `ms-orphan-${i}`, pad(100 + i));

    const before = node.writes.length;
    const healed = await milestoneIndexesHealResult({ cfg, node, apply: true });

    expect(healed.blocked).toBe(true);
    expect(healed.board_milestone_upserts).toBeGreaterThan(0);
    expect(healed.issued).toBe(0);
    expect(node.writes.length).toBe(before);
  });

  test("a bootstrap heal of an empty index is all upserts and is NOT refused", async () => {
    const node = fakeNode({ dropIncompleteRows: false });
    await seedBoard(node);
    // Well past the removal ceiling in TOTAL writes: a flat drift ceiling would
    // refuse this, and refusing it would break first-run index construction.
    for (let i = 0; i < 20; i++) {
      await milestoneAddCmd({
        cfg,
        node,
        slug: `ms-fresh-${i}`,
        title: `Fresh ${i}`,
        state: "active",
        northStar: "north-star-heal",
        driver: "last-stack-milestone-driver",
      });
    }

    const healed = await milestoneIndexesHealResult({ cfg, node, apply: true });

    expect(healed.removals_classified).toBe(0);
    expect(healed.blocked).toBe(false);
    expect(healed.applied).toBe(true);
    expect(healed.board_milestone_upserts).toBe(20);
    expect(healed.issued).toBeGreaterThan(0);
  });

  test("an ordinary small cleanup stays under the floor and still applies", async () => {
    const node = fakeNode({ dropIncompleteRows: false });
    await seedBoard(node);
    for (let i = 0; i < 8; i++) await seedHealthyMilestone(node, `ms-live-${i}`);
    seedOrphanIndexRow(node, "ms-orphan-only", pad(900));

    // 9 rows -> floor(0.25*9)=2, so the absolute floor is what governs here.
    // Without it a single honest removal on a small index would trip a
    // percentage, which is the failure mode a bare ratio has at small N.
    expect(milestoneIndexesHealRemovalCeiling(9)).toBe(DEFAULT_MILESTONE_INDEXES_HEAL_REMOVAL_FLOOR);

    const healed = await milestoneIndexesHealResult({ cfg, node, apply: true });

    expect(healed.removals_classified).toBe(1);
    expect(healed.blocked).toBe(false);
    expect(healed.applied).toBe(true);
    expect(deletesTo(node, cfg.schemaHashes.board_milestones!)).toBe(1);
  });

  test("the ceiling only gates APPLY — dry-run still reports the full classification", async () => {
    const node = fakeNode({ dropIncompleteRows: false });
    await seedBoard(node);
    await seedHealthyMilestone(node, "ms-live-a");
    for (let i = 0; i < 10; i++) seedOrphanIndexRow(node, `ms-orphan-${i}`, pad(100 + i));

    const before = node.writes.length;
    const healed = await milestoneIndexesHealResult({ cfg, node, apply: false });

    // A dry run writes nothing anyway, so calling it "blocked" would hide the
    // very classification an operator runs dry-run to read.
    expect(healed.blocked).toBe(false);
    expect(healed.removals_classified).toBe(10);
    expect(healed.text).not.toContain("REFUSED");
    expect(node.writes.length).toBe(before);
  });

  test("--max-removals unlimited opts out, and an explicit number pins the ceiling", async () => {
    const unlimited = fakeNode({ dropIncompleteRows: false });
    await seedBoard(unlimited);
    await seedHealthyMilestone(unlimited, "ms-live-a");
    for (let i = 0; i < 10; i++) seedOrphanIndexRow(unlimited, `ms-orphan-${i}`, pad(100 + i));

    const opted = await milestoneIndexesHealResult({
      cfg,
      node: unlimited,
      apply: true,
      maxRemovals: null,
    });
    expect(opted.blocked).toBe(false);
    expect(opted.removal_ceiling).toBeNull();
    expect(deletesTo(unlimited, cfg.schemaHashes.board_milestones!)).toBe(10);

    // An explicit ceiling must bite BELOW the derived default (5 here), or
    // "pinned" would be indistinguishable from the default doing the work.
    const pinned = fakeNode({ dropIncompleteRows: false });
    await seedBoard(pinned);
    await seedHealthyMilestone(pinned, "ms-live-a");
    seedOrphanIndexRow(pinned, "ms-orphan-0", pad(100));
    seedOrphanIndexRow(pinned, "ms-orphan-1", pad(101));

    const before = pinned.writes.length;
    const tight = await milestoneIndexesHealResult({
      cfg,
      node: pinned,
      apply: true,
      maxRemovals: 1,
    });
    expect(tight.removals_classified).toBe(2);
    expect(tight.blocked).toBe(true);
    expect(pinned.writes.length).toBe(before);
  });
});
