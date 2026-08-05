/**
 * The wide MilestoneCards read must not return the Milestone RECORD as a card.
 *
 * `Milestone` is `Hash(slug)` and `MilestoneCards` is `HashRange(milestone,
 * sk)`, so a milestone's own record sits at the same hash as its cards
 * partition. On this config `milestone_cards` resolves to a schema the node
 * registered under the ENTITY's `descriptive_name: "Milestone"`, so Mini's
 * multi-key expand puts entity and index on one product and the partition query
 * returns the record too, with its absent range coerced to `""`.
 *
 * The address reads have always dropped it (`milestoneCardRowFromQueryRow`'s
 * empty-sk guard). The wide read did not — it was immune only because its
 * projection led with `milestone`, a field the Milestone record has no atom
 * for. When `MILESTONE_CARDS_PAYLOAD_FIELDS` was re-led with `slug` and
 * stripped of `milestone` (the correct fix for the hash-gate row drop), that
 * immunity went with it, and the record started arriving as a card.
 *
 * Measured on the live primary 2026-08-05, partition
 * `lastdb-0231-read-regression-fixes`: wide 7 cards, spine 6 rows, the extra
 * being `slug=lastdb-0231-read-regression-fixes column="" position=
 * "1785025144594"` — the milestone's own slug, no column, and its portfolio
 * ordering where a card position belongs.
 *
 * These tests seed that exact shape: a keyless row carrying the Milestone
 * record's atoms, in the same partition as a real card. The load-bearing
 * assertion is the LAST one — the wide read and the spine read must agree on
 * how many rows the partition holds. That is the property the fix restores, and
 * the one a future projection change would break again.
 */
import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config.ts";
import { fakeNode, type FakeNode } from "./fake-node.ts";
import {
  listMilestoneCardsPartition,
  listMilestoneCardsPartitionSpine,
  milestoneCardSk,
} from "../src/milestone-cards.ts";
import { MILESTONE_CARDS_LAYOUT } from "../src/schemas.ts";

const MC_HASH = "milestone-cards-hash";
const MS = "ms-a";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://127.0.0.1:9",
  userHash: "user",
  schemaServiceUrl: "http://127.0.0.1:9",
  schemaHashes: { milestone_cards: MC_HASH },
};

/** The node as measured elsewhere: hash field gates if projected, else the lead. */
function measuredNode(): FakeNode {
  return fakeNode({
    baseUrl: cfg.nodeUrl,
    userHash: cfg.userHash,
    projectionRule: "hash_else_lead",
    hashFields: { [MC_HASH]: "milestone" },
  });
}

const CARD_SK = milestoneCardSk("todo", "10", "card-a");

/** An ordinary, complete membership row. */
function seedCard(node: FakeNode): void {
  node.seed({
    schemaHash: MC_HASH,
    keyHash: MS,
    rangeKey: CARD_SK,
    fields: {
      milestone: MS, sk: CARD_SK, slug: "card-a", title: "Card A",
      board: "default", column: "todo", position: "10",
      assignee: "", tags: [], deps: [], surfaces: [],
      created_at: "2026-01-01T00:00:00.000Z", created_by: "test",
      updated_at: "2026-01-01T00:00:00.000Z",
      db: "", repo: "", base: "", kind: "pr",
      block_status: "", block_reason: "", north_star: "",
      pr_url: "", branch: "", layout: MILESTONE_CARDS_LAYOUT,
    },
  });
}

/**
 * The Milestone RECORD, as the expand surfaces it inside the cards partition:
 * no range key, no `layout` marker, no `sk`, and — the part that made it look
 * like a card — a `slug` atom holding the MILESTONE's slug, plus a `position`
 * holding the milestone's portfolio ordering.
 */
function seedKeylessMilestoneRecord(node: FakeNode): void {
  node.seed({
    schemaHash: MC_HASH,
    keyHash: MS,
    rangeKey: null,
    fields: {
      slug: MS,
      title: "The milestone's own title",
      board: "default",
      position: "1785025144594",
      north_star: "ns-a",
      deps: [],
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
  });
}

describe("the keyless Milestone record is not a card", () => {
  test("the wide read returns only the real card", async () => {
    const node = measuredNode();
    seedCard(node);
    seedKeylessMilestoneRecord(node);

    const cards = await listMilestoneCardsPartition(node, cfg, MS);
    expect(cards?.map((c) => c.slug)).toEqual(["card-a"]);
  });

  test("no returned card carries the milestone's own slug", async () => {
    const node = measuredNode();
    seedCard(node);
    seedKeylessMilestoneRecord(node);

    const cards = (await listMilestoneCardsPartition(node, cfg, MS)) ?? [];
    expect(cards.filter((c) => c.slug === MS)).toEqual([]);
  });

  test("a partition holding ONLY the record reads as empty, not as one card", async () => {
    const node = measuredNode();
    seedKeylessMilestoneRecord(node);

    expect(await listMilestoneCardsPartition(node, cfg, MS)).toEqual([]);
  });

  // The one that matters: `doctor` and `parity check` report `rows:
  // wide.length` and compare it against an address-derived baseline. If the two
  // disagree by the phantom, every milestone partition over-reports forever and
  // nothing can repair the difference.
  test("wide and spine agree on how many rows the partition holds", async () => {
    const node = measuredNode();
    seedCard(node);
    seedKeylessMilestoneRecord(node);

    const wide = await listMilestoneCardsPartition(node, cfg, MS);
    const spine = await listMilestoneCardsPartitionSpine(node, cfg, MS);
    expect(wide?.length).toBe(spine?.length ?? -1);
  });
});

describe("dropping the record does not cost a real row", () => {
  // The guard keys on the ADDRESS, not on the absent `layout` marker — rows
  // with no layout atom are a measured live shape (9 of 56 in one partition)
  // and must still be returned when they have a real range key.
  test("a properly-addressed row with no layout marker is still returned", async () => {
    const node = measuredNode();
    node.seed({
      schemaHash: MC_HASH,
      keyHash: MS,
      rangeKey: CARD_SK,
      fields: { slug: "card-a", title: "Card A", column: "todo", position: "10" },
    });

    const cards = await listMilestoneCardsPartition(node, cfg, MS);
    expect(cards?.map((c) => c.slug)).toEqual(["card-a"]);
  });

  // The address recovery the wide read has always done, now sourced through the
  // shared helper: a row whose payload copies did not persist is still a row,
  // and its identity comes off its range key.
  test("a row that lost its payload scalars keeps its identity from the range key", async () => {
    const node = measuredNode();
    node.seed({
      schemaHash: MC_HASH,
      keyHash: MS,
      rangeKey: CARD_SK,
      fields: { slug: "card-a", layout: MILESTONE_CARDS_LAYOUT },
    });

    const cards = (await listMilestoneCardsPartition(node, cfg, MS)) ?? [];
    expect(cards.length).toBe(1);
    expect(cards[0]?.column).toBe("todo");
    expect(cards[0]?.position).toBe("10");
  });
});
