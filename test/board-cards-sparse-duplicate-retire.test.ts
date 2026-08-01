/**
 * A sparse DUPLICATE row must be retirable, and only when a whole sibling
 * provably carries the membership.
 *
 * `board-cards heal` dedupes its row set by slug, so a slug holding one whole
 * row and one sparse row keeps the whole one and skips the sparse sibling. That
 * skip was documented as temporary — the sibling stayed "reachable on a later
 * pass once the visible one converges" — but convergence is precisely when heal
 * stops acting on a slug: a whole row reports no drift, so the slug is never
 * revisited and the sparse row is skipped forever.
 *
 * Measured on the live `default` partition 2026-08-01, immediately after a heal
 * run reported `drifted=0 healed=0 missing_card=0`: `["slug"]` returned 340
 * rows and the five-field spine 339. The gap was a second membership row for
 * `lastgit-blob-inventory-primary-cutover`, whose whole row was healthy.
 *
 * The cost of leaving it is not the row — it is that `doctor`'s BoardCards
 * parity check acquires a permanent non-zero floor, and a check that can never
 * read clean is one nobody reads. That is exactly how the 19-row gap of
 * 2026-08-01 sat behind a check reporting `spine agrees` for two days.
 *
 * What must NOT regress is the refusal. Retiring a duplicate is safe only
 * because a whole sibling survives the delete; with zero whole rows (all
 * sparse) or two whole rows (ambiguous), deleting could drop the live
 * membership, and this path must decline and leave it to heal's orphan/drift
 * paths or a human.
 */
import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config.ts";
import { fakeNode } from "./fake-node.ts";
import {
  boardCardSk,
  classifyBoardCardDuplicateRows,
  deleteBoardCardRowsBySk,
} from "../src/board-cards.ts";
import { BOARD_CARDS_FIELDS } from "../src/schemas.ts";

const BOARD_CARDS_HASH = "board-cards-hash";
const BOARD = "default";
const SLUG = "lastgit-blob-inventory-primary-cutover";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://127.0.0.1:9",
  userHash: "user",
  schemaServiceUrl: "http://127.0.0.1:9",
  schemaHashes: { board: "board-hash", card: "card-hash", board_cards: BOARD_CARDS_HASH },
};

/** A row carrying an atom for every BoardCards field — visible to a wide read. */
function wholeRow(sk: string, column: string, position: string) {
  const fields: Record<string, unknown> = {};
  for (const f of BOARD_CARDS_FIELDS) fields[f] = "";
  return {
    schemaHash: BOARD_CARDS_HASH,
    keyHash: BOARD,
    rangeKey: sk,
    fields: { ...fields, board: BOARD, sk, slug: SLUG, column, position },
  };
}

/**
 * A row keyed into the partition carrying only `slug` — what a partial write
 * leaves behind. Invisible to any read projecting a copy of the key.
 */
function sparseRow(sk: string) {
  return { schemaHash: BOARD_CARDS_HASH, keyHash: BOARD, rangeKey: sk, fields: { slug: SLUG } };
}

const WHOLE_SK = boardCardSk("backlog", "1785548841187", SLUG);
const SPARSE_SK = boardCardSk("backlog", "1785258424267", SLUG);

describe("sparse duplicate retirement", () => {
  test("one whole + one sparse row: the sparse sibling is retired, the whole one kept", async () => {
    const node = fakeNode();
    node.seed(wholeRow(WHOLE_SK, "backlog", "1785548841187"));
    node.seed(sparseRow(SPARSE_SK));

    const dup = await classifyBoardCardDuplicateRows(node, cfg, BOARD, SLUG, [
      WHOLE_SK,
      SPARSE_SK,
    ]);
    expect(dup).not.toBeNull();
    expect(dup!.keepSk).toBe(WHOLE_SK);
    expect(dup!.sparseSks).toEqual([SPARSE_SK]);

    // Deleted by address — the whole row is kept.
    const deleted = await deleteBoardCardRowsBySk(node, cfg, BOARD, dup!.sparseSks);
    expect(deleted).toBe(1);

    const left = node.rowsOf(BOARD_CARDS_HASH);
    expect(left).toHaveLength(1);
    expect(left[0]!.rangeKey).toBe(WHOLE_SK);
  });

  test("REFUSES when every row is sparse — there is no membership to survive the delete", async () => {
    const node = fakeNode();
    const other = boardCardSk("todo", "1785258424999", SLUG);
    node.seed(sparseRow(SPARSE_SK));
    node.seed(sparseRow(other));

    expect(
      await classifyBoardCardDuplicateRows(node, cfg, BOARD, SLUG, [SPARSE_SK, other]),
    ).toBeNull();
    // Nothing was deleted as a side effect of asking.
    expect(node.rowsOf(BOARD_CARDS_HASH)).toHaveLength(2);
  });

  test("REFUSES when two rows are whole — which membership is current is ambiguous", async () => {
    const node = fakeNode();
    const other = boardCardSk("todo", "1785548899999", SLUG);
    node.seed(wholeRow(WHOLE_SK, "backlog", "1785548841187"));
    node.seed(wholeRow(other, "todo", "1785548899999"));

    expect(
      await classifyBoardCardDuplicateRows(node, cfg, BOARD, SLUG, [WHOLE_SK, other]),
    ).toBeNull();
    expect(node.rowsOf(BOARD_CARDS_HASH)).toHaveLength(2);
  });

  test("a single whole row is not a duplicate question", async () => {
    const node = fakeNode();
    node.seed(wholeRow(WHOLE_SK, "backlog", "1785548841187"));
    expect(await classifyBoardCardDuplicateRows(node, cfg, BOARD, SLUG, [WHOLE_SK])).toBeNull();
  });

  test("the sparse row is invisible to the five-field spine — the read that skipped it", async () => {
    // Pins WHY this went unseen: the projection heal's dedupe ran against
    // cannot return the row at all, so no slug-level bookkeeping could have
    // noticed the duplicate.
    const node = fakeNode();
    node.seed(wholeRow(WHOLE_SK, "backlog", "1785548841187"));
    node.seed(sparseRow(SPARSE_SK));

    const wide = await node.queryAll({
      schemaHash: BOARD_CARDS_HASH,
      fields: ["board", "sk", "slug", "column", "position"],
      filter: { HashKey: BOARD } as never,
    });
    expect(wide.results).toHaveLength(1);

    const address = await node.queryAll({
      schemaHash: BOARD_CARDS_HASH,
      fields: ["slug"],
      filter: { HashKey: BOARD } as never,
    });
    expect(address.results).toHaveLength(2);
  });
});
