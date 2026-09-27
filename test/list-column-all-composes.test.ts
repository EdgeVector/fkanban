/**
 * `list --column X --all` must return exactly column X, uncapped — never the
 * whole board. Reconfirmed 2026-09-27 (kanban-factory-manager) against
 * papercut-kanban-list-column-todo-empty-while-all-shows-todo-cards-20260924:
 * `list --column doing --json` read 1 card, `list --column doing --all
 * --json` read 2 (the extra one reporting its OWN column as `backlog`), and
 * the filer read this as `--all` silently discarding `--column`.
 *
 * A source read plus this fixture disagree with that theory: `--all` only
 * ever widens `resolveLimits`' cap (`jsonLimit`/`textLimit`), and every cap
 * path that runs when `--column` is set already scopes to that one column
 * before `--all` is consulted — `capPerColumn`'s off-column carry-through is
 * gated on `!column`, and a `--column` JSON read's implicit cap is gated on
 * `broadJson = column === undefined`, so it is already 0 (uncapped) with or
 * without `--all`. This fixture seeds one `doing` card and one `backlog`
 * card and asserts both CLI calls agree with each other and with
 * `--column doing` alone. It does not explain the live recurrence (most
 * likely the card moved between the two sequential live reads, or a
 * dual-membership leftover row — see list-column-membership-exclusive.test.ts
 * — was already present before `--all` was ever added to the command), but it
 * locks in that this composition is not itself the mechanism, and it is
 * pinned as a regression guard.
 */
import { describe, expect, test } from "bun:test";

import { boardCardFieldsFromCard, boardCardSk } from "../src/board-cards.ts";
import { listCmd } from "../src/commands/list.ts";
import { boardToFields, cardToFields, emptyStructuredFields, type Board, type Card } from "../src/record.ts";
import type { Config } from "../src/config.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";
import { fakeNode } from "./fake-node.ts";
import { cardsFromJson } from "./json_page.ts";

const CARD = "card-hash";
const BOARD = "board-hash";
const BC = "board-cards-hash";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://127.0.0.1:9",
  userHash: "user",
  schemaServiceUrl: "http://127.0.0.1:9",
  schemaHashes: { board: BOARD, card: CARD, board_cards: BC },
};

function board(): Board {
  return {
    slug: "default",
    title: "Default",
    body: "",
    columns: [...DEFAULT_COLUMNS],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function card(partial: Partial<Card> = {}): Card {
  return {
    slug: "doing-card",
    title: "Doing",
    body: "",
    board: "default",
    column: "doing",
    position: "2",
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
  };
}

function seedAll(node: ReturnType<typeof fakeNode>, cards: Card[]) {
  node.seed({ schemaHash: BOARD, keyHash: "default", fields: boardToFields(board()) });
  for (const c of cards) {
    node.seed({ schemaHash: CARD, keyHash: c.slug, fields: cardToFields(c) });
    node.seed({
      schemaHash: BC,
      keyHash: c.board,
      rangeKey: boardCardSk(c.column, c.position, c.slug),
      fields: boardCardFieldsFromCard(c),
    });
  }
}

describe("list --column + --all composes rather than widening to the whole board", () => {
  test("--all does not reintroduce a card from another column", async () => {
    const node = fakeNode();
    const doing = card({ slug: "doing-card", column: "doing", position: "2" });
    const backlog = card({ slug: "backlog-card", column: "backlog", position: "1" });
    seedAll(node, [doing, backlog]);

    const withoutAll = cardsFromJson(await listCmd({ cfg, node, column: "doing", json: true }));
    const withAll = cardsFromJson(await listCmd({ cfg, node, column: "doing", all: true, json: true }));

    expect(withoutAll.map((c) => c.slug)).toEqual(["doing-card"]);
    expect(withAll.map((c) => c.slug)).toEqual(["doing-card"]);
  });

  test("--all still lifts the cap within the requested column", async () => {
    const node = fakeNode();
    const doingCards = Array.from({ length: 15 }, (_, i) =>
      card({ slug: `doing-${i}`, column: "doing", position: String(i + 1) }),
    );
    const backlog = card({ slug: "backlog-card", column: "backlog", position: "1" });
    seedAll(node, [...doingCards, backlog]);

    const withoutAll = cardsFromJson(await listCmd({ cfg, node, column: "doing", json: true }));
    const withAll = cardsFromJson(await listCmd({ cfg, node, column: "doing", all: true, json: true }));

    expect(withoutAll.every((c) => c.column === "doing")).toBe(true);
    expect(withAll.every((c) => c.column === "doing")).toBe(true);
    expect(withAll.length).toBe(15);
    expect(withAll.map((c) => c.slug)).not.toContain("backlog-card");
  });
});
