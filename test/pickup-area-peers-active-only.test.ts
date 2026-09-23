/**
 * `listPickupAreaPeers` runs on every write of a `todo` Kind:pr card that names
 * a repo and an area. Its consumer keeps only `todo` and `doing` rows, so a
 * whole-partition read paid for the append-only `done` archive every time —
 * 238 of 268 rows on the live board 2026-09-23, when a whole-partition
 * BoardCards read averaged 3.8s of `hydrate_atoms`.
 *
 * These tests pin the contract, not the implementation:
 *   1. no BoardCards read this path issues is a whole-partition `HashKey`
 *      read on a board whose column list is known;
 *   2. the verdict is unchanged — a live peer is still found, and a matching
 *      card in `done` is still not a peer.
 */
import { describe, expect, test } from "bun:test";

import { boardCardFieldsFromCard, boardCardSk } from "../src/board-cards.ts";
import { BOARD_LIST_INDEX_KEY } from "../src/card-list-index.ts";
import type { Config } from "../src/config.ts";
import { emptyStructuredFields, listPickupAreaPeers, toBoardSummary, type Card } from "../src/record.ts";
import { fakeNode, type FakeNode } from "./fake-node.ts";

const BC = "board-cards-hash";
const INDEX = "card-list-index-hash";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://127.0.0.1:9",
  userHash: "user",
  schemaServiceUrl: "http://127.0.0.1:9",
  schemaHashes: {
    board: "board-hash",
    card: "card-hash",
    card_list_index: INDEX,
    board_cards: BC,
  },
};

function card(partial: Partial<Card> = {}): Card {
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
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    ...emptyStructuredFields(),
    surfaces: [],
    done_at: "",
    kind: "pr",
    repo: "EdgeVector/fkanban",
    ...partial,
  } as Card;
}

function seedBoard(node: FakeNode): void {
  const summary = toBoardSummary({
    slug: "default",
    title: "Default",
    body: "",
    columns: ["backlog", "todo", "doing", "done"],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  });
  node.seed({
    schemaHash: INDEX,
    keyHash: BOARD_LIST_INDEX_KEY,
    fields: { key: BOARD_LIST_INDEX_KEY, payload_json: JSON.stringify([summary]) },
  });
}

function seed(node: FakeNode, c: Card): void {
  node.seed({
    schemaHash: BC,
    keyHash: c.board || "default",
    rangeKey: boardCardSk(c.column, c.position, c.slug),
    fields: boardCardFieldsFromCard(c),
  });
}

const AREA = ["area:fkanban-list"];

function seedBoardWithArchive(node: FakeNode): void {
  seedBoard(node);
  seed(node, card({ slug: "peer-doing", column: "doing", position: "1", tags: AREA }));
  seed(node, card({ slug: "peer-todo", column: "todo", position: "2", tags: AREA }));
  seed(node, card({ slug: "parked", column: "backlog", position: "1", tags: AREA }));
  for (let i = 0; i < 5; i++) {
    seed(node, card({ slug: `finished-${i}`, column: "done", position: String(i + 1), tags: AREA }));
  }
}

const target = card({ slug: "target", column: "todo", position: "9", tags: AREA });

describe("pickup area peers read only the active columns", () => {
  test("no whole-partition BoardCards read, and no done row reaches the client", async () => {
    const node = fakeNode();
    seedBoardWithArchive(node);

    await listPickupAreaPeers(node, cfg, target);

    const reads = node.reads.filter((r) => r.schemaHash === BC);
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) {
      expect(r.filter as unknown as Record<string, unknown>).not.toHaveProperty("HashKey");
    }
  });

  test("the verdict is unchanged: live peers found, done and backlog ignored", async () => {
    const node = fakeNode();
    seedBoardWithArchive(node);

    const peers = await listPickupAreaPeers(node, cfg, target);

    expect(peers.map((c) => c.slug).sort()).toEqual(["peer-doing", "peer-todo"]);
  });
});
