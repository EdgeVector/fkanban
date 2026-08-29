// Concurrent title updates must finish as one complete writer value.
//
// dogfood-kanban kstress-1787946224-42581 reported `torn-write` when the final
// title was still the create title. Two contracts pin the fix:
//
// 1. N parallel title writers leave a title that one of them sent.
// 2. A title-only update does not re-list the BoardCards partition for search
//    visibility — that wait is for a new/moved address, and paying it per
//    concurrent title writer is what overloaded the node in the dogfood run.

import { describe, expect, test } from "bun:test";

import type { Config } from "../src/config.ts";
import { fakeNode } from "./fake-node.ts";
import {
  cardToFields,
  emptyStructuredFields,
  findCard,
  nowIso,
  updateCardRecord,
  type Card,
} from "../src/record.ts";
import { boardCardFieldsFromCard, boardCardSk } from "../src/board-cards.ts";

const CARD_HASH = "cardhash";
const BOARD_CARDS_HASH = "boardcardshash";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: CARD_HASH, board_cards: BOARD_CARDS_HASH },
};

function seedCard(node: ReturnType<typeof fakeNode>, over: Partial<Card> = {}): Card {
  const now = nowIso();
  const card: Card = {
    slug: "c2",
    title: "stress run card 2",
    body: "brief",
    board: "scratch",
    column: "todo",
    position: "100",
    assignee: "",
    tags: [],
    deps: [],
    created_at: now,
    created_by: "test",
    updated_at: now,
    ...emptyStructuredFields(),
    ...over,
  };
  node.seed({ schemaHash: CARD_HASH, keyHash: card.slug, fields: cardToFields(card) });
  node.seed({
    schemaHash: BOARD_CARDS_HASH,
    keyHash: card.board,
    rangeKey: boardCardSk(card.column, card.position, card.slug),
    fields: boardCardFieldsFromCard(card),
  });
  return card;
}

function newNode() {
  return fakeNode({ hashFields: { [CARD_HASH]: "slug", [BOARD_CARDS_HASH]: "board" } });
}

describe("concurrent title updates", () => {
  test("the final title is one value a writer sent", async () => {
    const node = newNode();
    seedCard(node);
    const opts = { cfg, node };
    const titles = Array.from({ length: 10 }, (_, i) => `v${i + 1}-run`);

    await Promise.all(
      titles.map(async (title) => {
        const snapshot = (await findCard(node, cfg, "c2"))!;
        await updateCardRecord(
          opts,
          { ...snapshot, title, updated_at: nowIso() },
          undefined,
          snapshot,
        );
      }),
    );

    const after = (await findCard(node, cfg, "c2"))!;
    expect(titles).toContain(after.title);
  });

  test("a title-only update does not re-list the BoardCards partition", async () => {
    const node = newNode();
    seedCard(node);
    const opts = { cfg, node };
    const snapshot = (await findCard(node, cfg, "c2"))!;
    node.reads.length = 0;

    await updateCardRecord(
      opts,
      { ...snapshot, title: "v1-run", updated_at: nowIso() },
      undefined,
      snapshot,
    );

    const boardCardsPartitionReads = node.reads.filter(
      (r) => r.schemaHash === BOARD_CARDS_HASH,
    );
    expect(boardCardsPartitionReads).toHaveLength(0);
  });

  test("a column move still waits until search can see the new address", async () => {
    const node = newNode();
    seedCard(node);
    const opts = { cfg, node };
    const snapshot = (await findCard(node, cfg, "c2"))!;
    node.reads.length = 0;

    await updateCardRecord(
      opts,
      { ...snapshot, column: "doing", updated_at: nowIso() },
      undefined,
      snapshot,
    );

    const boardCardsPartitionReads = node.reads.filter(
      (r) => r.schemaHash === BOARD_CARDS_HASH,
    );
    expect(boardCardsPartitionReads.length).toBeGreaterThan(0);
  });
});
