/**
 * `milestone reconcile` must classify repairs from the row set that EXISTS, not
 * from the row set the wide read is willing to show it.
 *
 * The MilestoneCards display read projects `milestone` — the partition key —
 * and that field is a payload COPY of the key, not the key. A row whose copy
 * did not persist is dropped from the display read with no error, while staying
 * addressable and staying visible to `purgeOtherMilestoneCardRows`, which has
 * always enumerated by spine for exactly this reason.
 *
 * So the two halves of reconcile disagreed about which rows exist: the half
 * that DECIDES read the wide projection, the half that DELETES read addresses.
 * Both failure modes below were measured on the live primary 2026-08-03 in
 * partition `lastdb-0231-read-regression-fixes` — 7 rows by address, 4 under
 * the wide read:
 *
 *   - `lastdb-resume-atom-partition-dual-write-rekey` — the Card was deleted, so
 *     its row is an orphan that must be retired. Invisible to the wide read, so
 *     `rows[0]` was undefined and NO removal was ever queued.
 *   - `lastgit-blob-inventory-primary-cutover` — two stale duplicates at old
 *     positions. Invisible to the wide read, so `rows.length > 1` evaluated to
 *     false, the sibling purge never armed, and each run wrote a third row.
 *
 * Neither is self-healing: every subsequent run re-derived the same blind
 * classification and re-issued the same non-repair.
 *
 * ## 2026-08-04: the blindness itself was closed, and these tests changed shape
 *
 * The wide read no longer projects the partition key at all
 * (`MILESTONE_CARDS_PAYLOAD_FIELDS`), so it is gated on `slug` — the same field
 * the spine read is gated on — and the two can no longer disagree about which
 * rows exist. The fixtures below therefore no longer produce a row that one
 * read sees and the other does not; `seedInvisibleRow` seeds what is now a
 * fully visible row, and the preconditions say so.
 *
 * They are kept, not deleted, and the reason is worth stating: what these tests
 * assert is the OUTCOME — an orphan is retired, a sibling purge arms — and that
 * outcome must survive whether or not the wide read can see the row. Deleting
 * them once the blindness closed would remove the only coverage that reconcile
 * retires an orphan whose payload copy of the key is gone, which is still a
 * real row shape on the primary. The first test in the last block pins the
 * shared gate directly, so if a future edit re-adds the hash field to the
 * projection, that fails first and names the cause.
 *
 * ## Why this file uses the generic fake and seeds rows directly
 *
 * `test/milestone-indexes.test.ts` has its own fake with a protein-fold
 * emulator, and it is the natural home for a reconcile test — but its
 * `queryAll` ignores the projection entirely, so in it every read sees every
 * row and the failure under test cannot be expressed at all. `test/fake-node.ts`
 * models the drop rule, so the scenario is built there: rows are seeded
 * directly, and the only difference between a visible row and an invisible one
 * is whether it carries a `milestone` atom.
 */
import { describe, expect, test } from "bun:test";

import type { Config } from "../src/config.ts";
import { fakeNode, type FakeNode } from "./fake-node.ts";
import { milestoneAddCmd, milestoneReconcileResult } from "../src/commands/milestone.ts";
import { addCmd } from "../src/commands/add.ts";
import { boardToFields, findCard, nowIso } from "../src/record.ts";
import {
  listMilestoneCardsPartition,
  listMilestoneCardsPartitionSpine,
  milestoneCardFieldsFromCard,
} from "../src/milestone-cards.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";

const MILESTONE_CARDS = "mscards-hash";

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
    milestone_cards: MILESTONE_CARDS,
  },
};

async function seed(node: FakeNode, milestone: string, slugs: string[]): Promise<void> {
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
    slug: milestone,
    title: `Outcome ${milestone}`,
    state: "active",
    northStar: `ns-${milestone}`,
    driver: "driver",
  });
  for (const slug of slugs) {
    await addCmd({
      cfg,
      node,
      slug,
      title: `PR ${slug}`,
      milestone,
      northStar: `ns-${milestone}`,
      repo: "EdgeVector/fkanban",
      base: "main",
      kind: "pr",
      column: "todo",
      body: `Repo: EdgeVector/fkanban\nBase: main\n\n## GOAL\nWork ${slug}.\n\n## END STATE\nDone.\n`,
    });
  }
}

/** The MilestoneCards row a converged card has: every field, including the key copy. */
async function seedVisibleRow(node: FakeNode, milestone: string, slug: string): Promise<string> {
  const card = await findCard(node, cfg, slug);
  const fields = { ...milestoneCardFieldsFromCard(card!)! };
  const sk = String(fields.sk);
  node.seed({ schemaHash: MILESTONE_CARDS, keyHash: milestone, rangeKey: sk, fields });
  return sk;
}

/**
 * A row missing the partition-key copy — every other field present.
 *
 * Named for what it used to be. Until 2026-08-04 the wide read projected the
 * hash field and so could not see this row at all; it is now visible to both
 * reads, and the name is kept because the row SHAPE is the thing under test.
 */
function seedInvisibleRow(
  node: FakeNode,
  milestone: string,
  fields: Record<string, unknown>,
  sk: string,
): void {
  const { milestone: _keyCopy, ...rest } = fields;
  node.seed({ schemaHash: MILESTONE_CARDS, keyHash: milestone, rangeKey: sk, fields: { ...rest, sk } });
}

const addresses = async (node: FakeNode, milestone: string): Promise<string[]> =>
  ((await listMilestoneCardsPartitionSpine(node, cfg, milestone)) ?? []).map((r) => r.sk).sort();

const visibleSlugs = async (node: FakeNode, milestone: string): Promise<string[]> =>
  ((await listMilestoneCardsPartition(node, cfg, milestone)) ?? []).map((c) => c.slug).sort();

describe("reconcile classifies from addresses, not from the wide projection", () => {
  test("the wide read and the address read agree on the row set", async () => {
    // The invariant that replaced the blindness, pinned on the row shape that
    // used to break it. If someone re-adds the hash field to the wide
    // projection, the node gates that read on `milestone` again and THIS fails
    // first — before the outcome tests below, and naming the cause.
    const node = fakeNode();
    await seed(node, "ms-agree", ["keep"]);
    const keepSk = await seedVisibleRow(node, "ms-agree", "keep");
    const keep = await findCard(node, cfg, "keep");
    const template = { ...milestoneCardFieldsFromCard(keep!)! };
    const noKeySk = "done#00000042#vanished";
    seedInvisibleRow(node, "ms-agree", { ...template, slug: "vanished" }, noKeySk);

    const wide = ((await listMilestoneCardsPartition(node, cfg, "ms-agree")) ?? []).length;

    expect(wide).toBe((await addresses(node, "ms-agree")).length);
    expect(await addresses(node, "ms-agree")).toEqual([noKeySk, keepSk].sort());
  });

  test("retires an orphan row the wide read denies", async () => {
    const node = fakeNode();
    await seed(node, "ms-orphan", ["keep"]);
    const keepSk = await seedVisibleRow(node, "ms-orphan", "keep");
    const keep = await findCard(node, cfg, "keep");
    const template = { ...milestoneCardFieldsFromCard(keep!)! };

    // A row for a card that does not exist. Nothing may retire it but reconcile.
    const orphanSk = "done#00000042#vanished";
    seedInvisibleRow(
      node,
      "ms-orphan",
      { ...template, slug: "vanished", title: "PR vanished", column: "done" },
      orphanSk,
    );

    // Both reads now reach it — that is the fix, asserted where the old
    // blindness used to be asserted, so a regression reads as a diff here.
    expect(await visibleSlugs(node, "ms-orphan")).toEqual(["keep", "vanished"]);
    expect(await addresses(node, "ms-orphan")).toEqual([orphanSk, keepSk].sort());

    const rec = await milestoneReconcileResult({ cfg, node, slug: "ms-orphan" });
    expect(rec.repairs.removals).toBe(1);

    // The orphan is gone by ADDRESS — the read that could always see it.
    expect(await addresses(node, "ms-orphan")).toEqual([keepSk]);
  });

  test("arms the sibling purge when the duplicates are invisible", async () => {
    const node = fakeNode();
    await seed(node, "ms-dupes", ["dup"]);
    const trueSk = await seedVisibleRow(node, "ms-dupes", "dup");
    const dup = await findCard(node, cfg, "dup");
    const template = { ...milestoneCardFieldsFromCard(dup!)! };

    // Two stale rows at positions the card has since left. This is the shape
    // that made `rows.length > 1` read as false.
    seedInvisibleRow(node, "ms-dupes", { ...template, column: "backlog" }, "backlog#00000001#dup");
    seedInvisibleRow(node, "ms-dupes", { ...template, column: "done" }, "done#00000002#dup");

    // Three rows for one card, all three now visible to both reads. The
    // duplicate COUNT is what arms the sibling purge, and it is the count the
    // wide read used to get wrong.
    expect(await visibleSlugs(node, "ms-dupes")).toEqual(["dup", "dup", "dup"]);
    expect((await addresses(node, "ms-dupes")).length).toBe(3);

    await milestoneReconcileResult({ cfg, node, slug: "ms-dupes" });

    // One row for the card, at the address truth says it belongs at.
    expect(await addresses(node, "ms-dupes")).toEqual([trueSk]);
  });

  test("a converged partition still writes nothing", async () => {
    // The classifier widened; it must not have widened into "always stale".
    const node = fakeNode();
    await seed(node, "ms-clean", ["a", "b"]);
    await seedVisibleRow(node, "ms-clean", "a");
    await seedVisibleRow(node, "ms-clean", "b");

    const before = node.writes.length;
    const rec = await milestoneReconcileResult({ cfg, node, slug: "ms-clean" });
    expect(rec.repairs).toMatchObject({ upserts: 0, removals: 0, issued: 0 });
    expect(node.writes.slice(before)).toEqual([]);
  });
});
