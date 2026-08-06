/**
 * A shed point read is not evidence that a card was deleted.
 *
 * `reconcileMilestoneCardChildren` fans out one point read per slug to fetch
 * the card's truth, and every one of them was wrapped in `.catch(() => null)`.
 * `findCardWithFields` only returns `null` for genuine ABSENCE — it rethrows a
 * node error (`record.ts`, filtered branch: anything that is not
 * `isOnlyOptionalFieldMiss` propagates). So that catch collapsed "the node
 * refused this read" into "this card does not exist", and the sole consumer of
 * the distinction is a DELETE branch:
 *
 *     if (!truth || …) { if (rows[0]) removals.push(cardForRemoval(…)); return; }
 *
 * `removeMilestoneCard` then deletes the row AND purges every other
 * MilestoneCards row for that slug in the partition.
 *
 * ## Why this is the dangerous direction
 *
 * Removals are issued FIRST against the shared repair budget, and reconcile has
 * no removal ceiling — so a shed burst can retire up to the budget in live
 * index rows in one run and exit 0. `milestone_indexes_heal` already learned
 * this: it does the same lookup with NO catch, under a docstring headed
 * "Removal evidence: absence from the scan is not deletion", plus a removal
 * ceiling. Reconcile had neither.
 *
 * The repo's settled rule is REPORT, NEVER REFUSE, so a failed truth read now
 * classifies as NOTHING — no removal and no upsert, because a card whose truth
 * could not be read cannot be compared against anything — and is counted in
 * `MilestoneRepairPlan.truth_read_failed`.
 */
import { describe, expect, test } from "bun:test";

import type { Config } from "../src/config.ts";
import type { NodeClient } from "../src/client.ts";
import { fakeNode, type FakeNode } from "./fake-node.ts";
import { milestoneAddCmd, milestoneReconcileResult } from "../src/commands/milestone.ts";
import { addCmd } from "../src/commands/add.ts";
import { boardToFields, findCard, nowIso } from "../src/record.ts";
import { milestoneCardFieldsFromCard } from "../src/milestone-cards.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";

const CARD = "cardhash";
const MILESTONE_CARDS = "mscards-hash";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: {
    card: CARD,
    board: "boardhash",
    milestone: "milestonehash",
    board_cards: "boardcards-hash",
    board_milestones: "boardms-hash",
    milestone_cards: MILESTONE_CARDS,
  },
};

async function seed(node: FakeNode, milestone: string, slugs: string[]): Promise<void> {
  const now = nowIso();
  node.seed({
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
    driver: "last-stack-milestone-driver",
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

/** Materialize the MilestoneCards row for a seeded card, so a removal is reachable. */
async function seedIndexRow(node: FakeNode, milestone: string, slug: string): Promise<void> {
  const card = await findCard(node, cfg, slug);
  const fields = { ...milestoneCardFieldsFromCard(card!)! };
  node.seed({ schemaHash: MILESTONE_CARDS, keyHash: milestone, rangeKey: String(fields.sk), fields });
}

/** Shed the Card POINT read for exactly one slug; everything else answers. */
function shedsCardRead(node: FakeNode, slug: string): NodeClient {
  return new Proxy(node, {
    get(target, prop, receiver) {
      if (prop !== "queryAll") return Reflect.get(target, prop, receiver);
      return async (req: Parameters<NodeClient["queryAll"]>[0]) => {
        const filter = req.filter as { HashKey?: unknown } | undefined;
        if (req.schemaHash === CARD && filter?.HashKey === slug) {
          throw new Error("service_timeout: node did not respond within 30000ms");
        }
        return await target.queryAll(req);
      };
    },
  }) as unknown as NodeClient;
}

describe("milestone reconcile: a shed truth read is not a deleted card", () => {
  test("a shed point read does NOT queue a removal", async () => {
    const node = fakeNode();
    await seed(node, "ms-tr", ["tr-a", "tr-b"]);
    await seedIndexRow(node, "ms-tr", "tr-a");
    await seedIndexRow(node, "ms-tr", "tr-b");

    const r = await milestoneReconcileResult({
      cfg,
      node: shedsCardRead(node, "tr-a"),
      slug: "ms-tr",
      apply: false,
    });

    expect(r.repairs.removals).toBe(0);
    expect(r.repairs.truth_read_failed).toBe(1);
  });

  test("the operator is told the truth read was refused", async () => {
    const node = fakeNode();
    await seed(node, "ms-trtext", ["tt-a", "tt-b"]);
    await seedIndexRow(node, "ms-trtext", "tt-a");
    await seedIndexRow(node, "ms-trtext", "tt-b");

    const r = await milestoneReconcileResult({
      cfg,
      node: shedsCardRead(node, "tt-a"),
      slug: "ms-trtext",
      apply: false,
    });

    expect(r.text).toContain("TRUTH READ REFUSED");
  });

  // THE control that matters. Without it, "removals === 0" above would also
  // pass against a build that simply stopped retiring orphans at all — which
  // would be a worse bug than the one being fixed, and invisible here.
  test("control — a card that genuinely does not exist is still retired", async () => {
    const node = fakeNode();
    await seed(node, "ms-orphan", ["orph-live"]);
    await seedIndexRow(node, "ms-orphan", "orph-live");

    // An index row whose Card was really deleted: copy a live row's shape, then
    // point it at a slug no Card record exists for.
    const live = await findCard(node, cfg, "orph-live");
    const fields = { ...milestoneCardFieldsFromCard(live!)! };
    const deadSk = String(fields.sk).replace("orph-live", "orph-dead");
    node.seed({
      schemaHash: MILESTONE_CARDS,
      keyHash: "ms-orphan",
      rangeKey: deadSk,
      fields: { ...fields, slug: "orph-dead", sk: deadSk },
    });

    const r = await milestoneReconcileResult({ cfg, node, slug: "ms-orphan", apply: false });

    expect(r.repairs.truth_read_failed).toBe(0);
    expect(r.repairs.removals).toBe(1);
    expect(r.text).not.toContain("TRUTH READ REFUSED");
  });

  // A shed truth read must not classify as an UPSERT either: an unread card
  // cannot be compared, so writing the index from it would be writing from
  // nothing. This distinguishes "skipped" from "silently rerouted".
  test("a shed point read does NOT queue an upsert either", async () => {
    const node = fakeNode();
    await seed(node, "ms-nu", ["nu-a"]);

    const r = await milestoneReconcileResult({
      cfg,
      node: shedsCardRead(node, "nu-a"),
      slug: "ms-nu",
      apply: false,
    });

    expect(r.repairs.truth_read_failed).toBe(1);
    expect(r.repairs.upserts).toBe(0);
    expect(r.repairs.removals).toBe(0);
  });
});
