/**
 * The repair half of the phantom-listing defect.
 *
 * A card whose Card record says `done` can still hold a BoardCards row under
 * `doing#…`. Nothing in the Card record names that row, so the retirement
 * `updateCardRecord` performs — which builds the source address from the Card
 * point read it was handed — cannot reach it. `kanban move <slug> done
 * --force` therefore exited 0, printed `done -> done`, and left the phantom row
 * first in `kanban list --column doing`
 * (`papercut-kanban-move-to-truth-column-does-not-clear-the-stale-listing-row-20260905`;
 * 9 of 13 rows in that lane on 2026-09-05T02:05Z).
 *
 * Only the partition knows every row a slug holds, so
 * `purgeStaleBoardCardRows` asks it — and refuses to delete anything unless the
 * same read can also see the row it is keeping.
 */
import { describe, expect, test } from "bun:test";

import {
  boardCardFieldsFromCard,
  boardCardSk,
  purgeStaleBoardCardRows,
} from "../src/board-cards.ts";
import type { Config } from "../src/config.ts";
import { emptyStructuredFields, type Card } from "../src/record.ts";
import { fakeNode, type FakeNode } from "./fake-node.ts";

const BC = "board-cards-hash";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://127.0.0.1:9",
  userHash: "user",
  schemaServiceUrl: "http://127.0.0.1:9",
  schemaHashes: {
    board: "board-hash",
    card: "card-hash",
    card_list_index: "card-list-index-hash",
    board_cards: BC,
  },
};

function card(partial: Partial<Card> = {}): Card {
  return {
    slug: "drifted",
    title: "Drifted",
    body: "",
    board: "default",
    column: "done",
    position: "9",
    assignee: "tom",
    tags: [],
    deps: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    ...emptyStructuredFields(),
    surfaces: [],
    done_at: "",
    kind: "pr",
    ...partial,
  } as Card;
}

function seedRow(node: FakeNode, c: Card): void {
  node.seed({
    schemaHash: BC,
    keyHash: c.board || "default",
    rangeKey: boardCardSk(c.column, c.position, c.slug),
    fields: boardCardFieldsFromCard(c),
  });
}

describe("purgeStaleBoardCardRows", () => {
  test("retires a phantom row in another column and keeps the card's own", async () => {
    const node = fakeNode();
    const truth = card({ column: "done", position: "9" });
    const phantom = card({ column: "doing", position: "3" });
    seedRow(node, truth);
    seedRow(node, phantom);
    expect(node.rowsOf(BC)).toHaveLength(2);

    const removed = await purgeStaleBoardCardRows(node, cfg, truth);

    expect(removed).toBe(1);
    const rows = node.rowsOf(BC);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rangeKey).toBe(boardCardSk("done", "9", "drifted"));
  });

  test("never touches another card's rows", async () => {
    const node = fakeNode();
    const truth = card({ column: "done", position: "9" });
    const phantom = card({ column: "doing", position: "3" });
    const neighbour = card({ slug: "other", column: "doing", position: "4" });
    seedRow(node, truth);
    seedRow(node, phantom);
    seedRow(node, neighbour);

    await purgeStaleBoardCardRows(node, cfg, truth);

    const survivors = node.rowsOf(BC).map((r) => r.rangeKey).sort();
    expect(survivors).toEqual([
      boardCardSk("doing", "4", "other"),
      boardCardSk("done", "9", "drifted"),
    ].sort());
  });

  test("deletes nothing when the row it would keep is not visible yet", async () => {
    // A BoardCards write is durable but unreadable for up to ~2.4s after its
    // own ack. Without this gate the purge would delete every row the card has
    // while its destination was still invisible, which is the "card on no
    // board" state the whole write path is built to avoid.
    const node = fakeNode();
    const phantom = card({ column: "doing", position: "3" });
    seedRow(node, phantom);

    const removed = await purgeStaleBoardCardRows(node, cfg, card({ column: "done", position: "9" }));

    expect(removed).toBe(0);
    expect(node.rowsOf(BC)).toHaveLength(1);
  });

  test("is a no-op when the card holds exactly one row", async () => {
    const node = fakeNode();
    const truth = card({ column: "done", position: "9" });
    seedRow(node, truth);

    expect(await purgeStaleBoardCardRows(node, cfg, truth)).toBe(0);
    expect(node.rowsOf(BC)).toHaveLength(1);
  });
});
