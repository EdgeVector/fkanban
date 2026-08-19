/**
 * `board rm`'s "don't orphan cards" guard, against the two ways a card can be
 * invisible to the board-wide list it used to trust.
 *
 * The guard counted `listCards()` rows whose `board` matched. That read
 * resolves through the BoardCards projection, and a projected read of that
 * index is a FILTER: a row missing an atom on a projected field is dropped
 * silently — no error, no null (see `test/fake-node.ts`). So a card could be on
 * the board and absent from the count, and `board rm` would report the board
 * empty and delete it. `--force` was blind in the same direction: it deleted
 * the cards it could see and stranded the rest.
 *
 * Both cases below are live shapes, not hypotheticals. Sparse membership rows
 * were measured on the primary's `default` partition on 2026-08-01 (19 of 357
 * rows carried atoms no projected read returned, one of them a live
 * `needs_human` card); cards with no BoardCards row at all are what the
 * 2026-07-18 dual-write cutover left behind before its backfill.
 */
import { describe, expect, test } from "bun:test";

import { boardRmCmd } from "../src/commands/board.ts";
import { FkanbanError, type QueryFilter } from "../src/client.ts";
import { fakeNode, type FakeNode } from "./fake-node.ts";
import {
  boardToFields,
  cardToFields,
  emptyStructuredFields,
  type Board,
  type Card,
} from "../src/record.ts";
import { boardCardFieldsFromCard, boardCardSk } from "../src/board-cards.ts";
import type { Config } from "../src/config.ts";

const CARD_HASH = "cardhash";
const BOARD_HASH = "boardhash";
const BOARD_CARDS_HASH = "boardcardshash";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: CARD_HASH, board: BOARD_HASH, board_cards: BOARD_CARDS_HASH },
};

function board(slug: string): Board {
  return {
    slug,
    title: slug,
    body: "",
    columns: ["backlog", "todo", "doing", "done"],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function card(partial: Partial<Card>): Card {
  return {
    slug: "c",
    title: "C",
    body: "",
    board: "default",
    column: "todo",
    position: "1",
    assignee: "",
    tags: [],
    deps: [],
    ...emptyStructuredFields(),
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

function seedBoard(node: FakeNode, slug: string): void {
  node.seed({ schemaHash: BOARD_HASH, keyHash: slug, fields: boardToFields(board(slug)) });
}

function seedCard(node: FakeNode, c: Card): void {
  node.seed({ schemaHash: CARD_HASH, keyHash: c.slug, fields: cardToFields(c) });
}

/** A whole BoardCards row — every field carries an atom, so every read sees it. */
function seedWholeMembership(node: FakeNode, c: Card): void {
  node.seed({
    schemaHash: BOARD_CARDS_HASH,
    keyHash: c.board,
    rangeKey: boardCardSk(c.column, c.position, c.slug),
    fields: boardCardFieldsFromCard(c),
  });
}

/**
 * A row keyed into the partition carrying only the two atoms named — what a
 * partial write leaves behind, and what every projected read drops.
 */
function seedSparseMembership(
  node: FakeNode,
  boardSlug: string,
  sk: string,
  fields: Record<string, unknown>,
): void {
  node.seed({ schemaHash: BOARD_CARDS_HASH, keyHash: boardSlug, rangeKey: sk, fields });
}

/**
 * A populated `default` board, so the board-wide `listCards()` short-circuits on
 * BoardCards instead of falling through to its Card-scan-and-seed path — which
 * would repair the very membership hole under test.
 */
function seedPopulatedDefault(node: FakeNode): void {
  seedBoard(node, "default");
  const other = card({ slug: "other-card", board: "default" });
  seedCard(node, other);
  seedWholeMembership(node, other);
}

describe("board rm occupancy", () => {
  test("a card whose membership row is sparse still blocks removal", async () => {
    const node = fakeNode();
    seedPopulatedDefault(node);
    seedBoard(node, "scratch");
    const ghost = card({ slug: "ghost-card", board: "scratch", column: "todo", position: "7" });
    seedCard(node, ghost);
    // Keyed into `scratch`, carrying two atoms. `listCards` cannot see it.
    seedSparseMembership(node, "scratch", boardCardSk("todo", "7", "ghost-card"), {
      slug: "ghost-card",
      title: "Ghost",
    });

    const err = await boardRmCmd({ cfg, node, slug: "scratch" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FkanbanError);
    expect((err as FkanbanError).code).toBe("board_not_empty");
    expect(node.writes).toHaveLength(0);
  });

  test("a card with no membership row anywhere still blocks removal", async () => {
    const node = fakeNode();
    seedPopulatedDefault(node);
    seedBoard(node, "scratch");
    // Card truth says `scratch`; no BoardCards row exists on any partition.
    seedCard(node, card({ slug: "stranded", board: "scratch" }));

    const err = await boardRmCmd({ cfg, node, slug: "scratch" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FkanbanError);
    expect((err as FkanbanError).code).toBe("board_not_empty");
    expect((err as FkanbanError).message).toContain("1 live card");
    expect(node.writes).toHaveLength(0);
  });

  test("--force deletes the card behind a sparse row instead of stranding it", async () => {
    const node = fakeNode();
    seedPopulatedDefault(node);
    seedBoard(node, "scratch");
    const ghost = card({ slug: "ghost-card", board: "scratch", column: "todo", position: "7" });
    seedCard(node, ghost);
    seedSparseMembership(node, "scratch", boardCardSk("todo", "7", "ghost-card"), {
      slug: "ghost-card",
      title: "Ghost",
    });

    const res = await boardRmCmd({ cfg, node, slug: "scratch", force: true });

    expect(res.deletedCards).toEqual(["ghost-card"]);
    expect(node.rowAt(CARD_HASH, "ghost-card")).toBeUndefined();
    expect(node.rowAt(BOARD_HASH, "scratch")).toBeUndefined();
  });

  test("--force retires membership residue that has no Card record", async () => {
    const node = fakeNode();
    seedPopulatedDefault(node);
    seedBoard(node, "scratch");
    const sk = boardCardSk("todo", "7777", "debug-protein");
    // One `title` atom, no Card record — the orphan shape `board-cards heal`
    // reaps. Its Board is about to be deleted, so the row has to go with it.
    seedSparseMembership(node, "scratch", sk, { title: "debug protein" });

    const res = await boardRmCmd({ cfg, node, slug: "scratch", force: true });

    expect(res.deletedCards).toEqual([]);
    expect(node.rowAt(BOARD_CARDS_HASH, "scratch", sk)).toBeUndefined();
    expect(node.rowAt(BOARD_HASH, "scratch")).toBeUndefined();
  });

  test("a refused completeness lead refuses the removal", async () => {
    const node = fakeNode();
    seedPopulatedDefault(node);
    seedBoard(node, "scratch");
    const inner = node.queryAll.bind(node);
    node.queryAll = async (q: {
      schemaHash: string;
      fields: string[];
      filter?: QueryFilter;
    }) => {
      // One single-field lead the node will not serve — the shape measured on
      // `agent-dogfood-scratch`, where leading with `column` returns
      // `laststore: corrupt: empty rec` while every other lead reads clean.
      if (q.schemaHash === BOARD_CARDS_HASH && q.fields.length === 1 && q.fields[0] === "column") {
        throw new Error("HTTP 400 … laststore: corrupt: empty rec");
      }
      return inner(q);
    };

    const err = await boardRmCmd({ cfg, node, slug: "scratch", force: true }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(FkanbanError);
    expect((err as FkanbanError).code).toBe("board_membership_unreadable");
    expect((err as FkanbanError).message).toContain("column");
    expect(node.rowAt(BOARD_HASH, "scratch")).toBeDefined();
  });

  test("an unreadable Card key list refuses rather than trusting the index", async () => {
    const node = fakeNode();
    seedPopulatedDefault(node);
    seedBoard(node, "scratch");
    const listInner = node.listRecordKeys!.bind(node);
    node.listRecordKeys = async (schemaHash, opts) => {
      // Key-list discovery is how this command learns about cards with no
      // membership row. Without it there is no sound answer.
      if (schemaHash === CARD_HASH) throw new Error("key list shed under load");
      return listInner(schemaHash, opts);
    };

    const err = await boardRmCmd({ cfg, node, slug: "scratch" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FkanbanError);
    expect((err as FkanbanError).code).toBe("board_card_truth_unavailable");
    expect(node.rowAt(BOARD_HASH, "scratch")).toBeDefined();
  });

  test("a genuinely empty board is still removable", async () => {
    const node = fakeNode();
    seedPopulatedDefault(node);
    seedBoard(node, "scratch");

    const res = await boardRmCmd({ cfg, node, slug: "scratch" });

    expect(res.deletedCards).toEqual([]);
    expect(node.rowAt(BOARD_HASH, "scratch")).toBeUndefined();
    // The card on `default` is untouched.
    expect(node.rowAt(CARD_HASH, "other-card")).toBeDefined();
  });
});
