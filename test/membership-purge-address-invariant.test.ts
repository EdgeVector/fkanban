/**
 * One rule, held across all three membership indexes at once.
 *
 * `purgeOther*Rows` is the only code that removes a duplicate row from a
 * membership partition, so a row a purge cannot ADDRESS is stale membership
 * nothing can ever remove — every later purge is blind in the same way. Two
 * properties make a purge able to address every row, and both are easy to lose
 * one index at a time:
 *
 *   1. it reads at the ADDRESS projection (`["slug"]`). `board`/`milestone` and
 *      `sk` are payload COPIES of the key, and LastDB drops any row missing an
 *      atom for a projected field — so projecting a copy of the key denies
 *      exactly the partial-write rows a purge exists to clean up.
 *   2. it deletes by `QueryRow.key.range`, not by an sk rebuilt from the copied
 *      column/position fields. Those copies drifting from the key IS the
 *      corruption being repaired, so a rebuild misses precisely the damaged row.
 *
 * This file exists because the rule has now been broken and re-fixed one call
 * site at a time four separate times, and each time the remaining sites looked
 * fine to a search for a MISSING guard: the lagging site had a deliberate,
 * commented narrowing that had silently become a generation out of date.
 * `purgeOtherBoardCardRows` read the five-field spine for two days after that
 * spine was measured to drop 19 of 357 rows on the live `default` partition.
 *
 * A per-index test cannot catch that; only asserting the three together can.
 * If a fourth membership index is added, add it to INDEXES here.
 */
import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config.ts";
import { fakeNode, type FakeNode } from "./fake-node.ts";
import { boardCardSk, purgeOtherBoardCardRows } from "../src/board-cards.ts";
import { purgeOtherMilestoneCardRows } from "../src/milestone-cards.ts";
import { boardMilestoneSk, purgeOtherBoardMilestoneRows } from "../src/board-milestones.ts";

const BOARD_CARDS_HASH = "board-cards-hash";
const MILESTONE_CARDS_HASH = "milestone-cards-hash";
const BOARD_MILESTONES_HASH = "board-milestones-hash";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://127.0.0.1:9",
  userHash: "user",
  schemaServiceUrl: "http://127.0.0.1:9",
  schemaHashes: {
    board: "board-hash",
    card: "card-hash",
    board_cards: BOARD_CARDS_HASH,
    milestone_cards: MILESTONE_CARDS_HASH,
    board_milestones: BOARD_MILESTONES_HASH,
  },
};

type PurgeIndex = {
  label: string;
  schemaHash: string;
  /** The partition key the purge is called with. */
  partition: string;
  /** Range key for a row of `slug` that the purge should delete. */
  sk: (slug: string) => string;
  /**
   * A SECOND address for the same slug — stale membership at a different
   * column/state. It must parse back to the same slug: the sk is
   * `<col>#<pos>#<slug>`, so appending a suffix would make a different slug and
   * the purge would rightly leave it alone.
   */
  staleSk: (slug: string) => string;
  purge: (
    node: FakeNode,
    partition: string,
    slug: string,
    keepSk: string | null,
  ) => Promise<number>;
};

const INDEXES: PurgeIndex[] = [
  {
    label: "BoardCards",
    schemaHash: BOARD_CARDS_HASH,
    partition: "default",
    sk: (slug) => boardCardSk("todo", "10", slug),
    staleSk: (slug) => boardCardSk("doing", "99", slug),
    purge: (node, partition, slug, keepSk) =>
      purgeOtherBoardCardRows(node, cfg, partition, slug, keepSk),
  },
  {
    label: "MilestoneCards",
    schemaHash: MILESTONE_CARDS_HASH,
    partition: "ms-1",
    sk: (slug) => boardCardSk("todo", "10", slug),
    staleSk: (slug) => boardCardSk("doing", "99", slug),
    purge: (node, partition, slug, keepSk) =>
      purgeOtherMilestoneCardRows(node, cfg, partition, slug, keepSk),
  },
  {
    label: "BoardMilestones",
    schemaHash: BOARD_MILESTONES_HASH,
    partition: "default",
    sk: (slug) => boardMilestoneSk("active", "10", slug),
    staleSk: (slug) => boardMilestoneSk("done", "99", slug),
    purge: (node, partition, slug, keepSk) =>
      purgeOtherBoardMilestoneRows(node, cfg, partition, slug, keepSk),
  },
];

/**
 * A row carrying ONLY `slug` — no `board`/`milestone`, no `sk`, no `layout`.
 *
 * This is partial-write residue as it actually appears on the live primary:
 * keyed into the partition, addressable by range key, carrying no copy of its
 * own address. Seeded directly, because every writer in the app derives the key
 * FROM the copies this row is missing.
 */
function seedKeyOnlyRow(node: FakeNode, ix: PurgeIndex, slug: string): void {
  node.seed({
    schemaHash: ix.schemaHash,
    keyHash: ix.partition,
    rangeKey: ix.sk(slug),
    fields: { slug },
  });
}

describe("every membership purge can address every row in its partition", () => {
  for (const ix of INDEXES) {
    describe(ix.label, () => {
      test("reads one partition query, projecting only the address field", async () => {
        const node = fakeNode({ baseUrl: cfg.nodeUrl, userHash: cfg.userHash });
        seedKeyOnlyRow(node, ix, "some-slug");

        await ix.purge(node, ix.partition, "some-slug", null);

        const reads = node.reads.filter((r) => r.schemaHash === ix.schemaHash);
        expect(reads).toHaveLength(1);
        // Projecting a copy of the key (`board`/`milestone`/`sk`) is what makes
        // the read deny the damaged rows. `["slug"]` is the narrowest available.
        expect(reads[0]!.fields).toEqual(["slug"]);
      });

      test("deletes a row that carries no copy of its own key", async () => {
        const node = fakeNode({ baseUrl: cfg.nodeUrl, userHash: cfg.userHash });
        seedKeyOnlyRow(node, ix, "ghost-slug");
        expect(node.rowsOf(ix.schemaHash)).toHaveLength(1);

        const purged = await ix.purge(node, ix.partition, "ghost-slug", null);

        expect(purged).toBe(1);
        expect(node.rowsOf(ix.schemaHash)).toHaveLength(0);
      });

      test("keeps `keepSk` and leaves other slugs untouched", async () => {
        const node = fakeNode({ baseUrl: cfg.nodeUrl, userHash: cfg.userHash });
        const keepSk = ix.sk("keep-me");
        node.seed({
          schemaHash: ix.schemaHash,
          keyHash: ix.partition,
          rangeKey: keepSk,
          fields: { slug: "keep-me" },
        });
        // A second, stale row for the SAME slug at a different address.
        node.seed({
          schemaHash: ix.schemaHash,
          keyHash: ix.partition,
          rangeKey: ix.staleSk("keep-me"),
          fields: { slug: "keep-me" },
        });
        seedKeyOnlyRow(node, ix, "unrelated");

        const purged = await ix.purge(node, ix.partition, "keep-me", keepSk);

        expect(purged).toBe(1);
        const left = node.rowsOf(ix.schemaHash).map((r) => r.rangeKey).sort();
        expect(left).toEqual([keepSk, ix.sk("unrelated")].sort());
      });
    });
  }
});
