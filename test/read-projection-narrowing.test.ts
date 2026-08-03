// Ask LastDB for the fields the ANSWER needs — not the fields a Card has.
//
// `list-read-amplification.test.ts` pins how MANY reads a list costs. This file
// pins how WIDE they are, because on LastDB a projection is not free: the node
// resolves a projected field per row, so a wide projection over a large
// partition is a real per-row cost. Both paths below read a board's TERMINAL
// column — an append-only archive — to answer a question that never renders a
// single one of those rows.
//
// Measured on the live board before the fix (567 `done` rows):
//   - `list --column todo` spent 1299ms of its ~2.0s on a 24-field read of
//     `done#`, against 416ms for the seven fields the dep verdict reads.
//   - `pickup status` point-read 133 card bodies, 110 of them in a terminal
//     column — 269 KiB, 4389ms of a 7s command — to refine a routing verdict
//     for cards that can never be picked up.
//
// Both costs scaled with everything the board had ever finished, so neither had
// a ceiling.

import { describe, expect, test } from "bun:test";

import { DEP_SEED_POINT_READ_MAX, listCmd } from "../src/commands/list.ts";
import { hydrateForPickupClassification } from "../src/pickup.ts";
import type { NodeClient, QueryFilter, QueryResponse } from "../src/client.ts";
import {
  boardToFields,
  cardToFields,
  emptyStructuredFields,
  BODY_OMITTED,
  CARD_LIST_FIELDS,
  type Board,
  type Card,
} from "../src/record.ts";
import {
  BOARD_CARDS_DEP_SEED_FIELDS,
  boardCardsProjectionForCardFields,
  boardCardsWireProjection,
  boardCardFieldsFromCard,
  boardCardSk,
} from "../src/board-cards.ts";
import { BOARD_CARDS_FIELDS } from "../src/schemas.ts";
import { TOMBSTONE_TAG } from "../src/record.ts";
import type { Config } from "../src/config.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash", board_cards: "boardcardshash" },
};

const DEFAULT_BOARD: Board = {
  slug: "default",
  title: "Default board",
  body: "",
  columns: ["backlog", "todo", "doing", "done"],
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

function card(partial: Partial<Card>): Card {
  return {
    slug: "c",
    title: "C",
    body: "Repo: EdgeVector/fkanban\nBase: main\n\n## GOAL\nfixture\n\n## END STATE\ndone\n",
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

type QueryLog = { schemaHash: string; fields: string[]; filter?: QueryFilter };

function fakeNode(cards: Card[], boards: Board[] = [DEFAULT_BOARD]): NodeClient & { queries: QueryLog[] } {
  const queries: QueryLog[] = [];
  const stub = () => {
    throw new Error("not implemented in fake node");
  };
  const boardRows = boards.map((b) => ({ fields: boardToFields(b), key: { hash: b.slug, range: null } }));
  const cardRows = cards.map((c) => ({ fields: cardToFields(c), key: { hash: c.slug, range: null } }));
  const boardCardRows = cards.map((c) => ({
    fields: boardCardFieldsFromCard(c),
    key: { hash: c.board, range: boardCardSk(c.column, c.position, c.slug) },
  }));

  return {
    baseUrl: "http://fake",
    userHash: "test-user",
    queries,
    autoIdentity: stub as never,
    bootstrap: stub as never,
    loadSchemas: stub as never,
    listSchemas: stub as never,
    rawCall: stub as never,
    nodeTransport: stub as never,
    createRecord: (async () => {}) as never,
    updateRecord: (async () => {}) as never,
    deleteRecord: (async () => {}) as never,
    async queryAll(q: { schemaHash: string; fields: string[]; filter?: QueryFilter }): Promise<QueryResponse> {
      queries.push({ schemaHash: q.schemaHash, fields: q.fields, filter: q.filter });
      if (q.schemaHash === "boardcardshash") {
        const prefix = (q.filter as unknown as { HashRangePrefix?: { hash?: string; prefix?: string } } | undefined)
          ?.HashRangePrefix;
        if (prefix?.hash && prefix.prefix !== undefined) {
          return {
            ok: true,
            results: boardCardRows.filter(
              (r) => r.fields.board === prefix.hash && String(r.fields.sk).startsWith(prefix.prefix!),
            ),
          };
        }
        if (q.filter?.HashKey) {
          return { ok: true, results: boardCardRows.filter((r) => r.fields.board === q.filter!.HashKey) };
        }
        return { ok: true, results: boardCardRows };
      }
      if (q.schemaHash === "cardhash") {
        if (q.filter?.HashKey) {
          return { ok: true, results: cardRows.filter((r) => r.key.hash === q.filter!.HashKey) };
        }
        return { ok: true, results: cardRows };
      }
      if (q.schemaHash === "boardhash") {
        if (q.filter?.HashKey) {
          return { ok: true, results: boardRows.filter((r) => r.key.hash === q.filter!.HashKey) };
        }
        return { ok: true, results: boardRows };
      }
      return { ok: true, results: [] };
    },
  } as unknown as NodeClient & { queries: QueryLog[] };
}

const prefixReads = (node: { queries: QueryLog[] }, column: string) =>
  node.queries.filter(
    (q) =>
      q.schemaHash === "boardcardshash" &&
      (q.filter as unknown as { HashRangePrefix?: { prefix?: string } } | undefined)?.HashRangePrefix?.prefix ===
        `${column}#`,
  );

describe("list --column: the finished-dependency seed reads the archive narrowly", () => {
  // One todo card depending on a finished card, so the seed read fires.
  const cards = [
    card({ slug: "todo-a", column: "todo", position: "1", deps: ["done-a"] }),
    card({ slug: "done-a", column: "done", position: "1" }),
  ];

  // Above DEP_SEED_POINT_READ_MAX off-set deps the archive scan is still the
  // cheaper seed, so it is still the one that runs — and it must still be
  // narrow. Build k = MAX + 1 finished deps to land on that branch on purpose:
  // pinning the projection matters precisely where the read is unbounded.
  const wideFanoutCards = [
    card({
      slug: "todo-a",
      column: "todo",
      position: "1",
      deps: Array.from({ length: DEP_SEED_POINT_READ_MAX + 1 }, (_, i) => `done-${i}`),
    }),
    ...Array.from({ length: DEP_SEED_POINT_READ_MAX + 1 }, (_, i) =>
      card({ slug: `done-${i}`, column: "done", position: String(i + 1) }),
    ),
  ];

  test("the terminal-column read asks for the dep-seed projection, not every field", async () => {
    const node = fakeNode(wideFanoutCards);
    await listCmd({ cfg, node, column: "todo", json: true });

    const seed = prefixReads(node, "done");
    expect(seed).toHaveLength(1);
    // The WIRE shape, which is narrower than the want-list: `sk`/`slug`/`column`
    // come off `QueryRow.key.range` instead of being fetched per row.
    expect(seed[0]!.fields).toEqual(boardCardsWireProjection([...BOARD_CARDS_DEP_SEED_FIELDS]));
    expect(seed[0]!.fields).not.toContain("sk");
    // `position` is NOT key-derived — `parseBoardCardSk` un-pads it through
    // `Number`, which turns a lexical position into "NaN".
    expect(seed[0]!.fields).toContain("position");
    // The regression: 17 fields fetched off an append-only archive and dropped.
    expect(seed[0]!.fields.length).toBeLessThan(BOARD_CARDS_FIELDS.length);
  });

  test("below the threshold the archive is not read AT ALL — k point-reads instead", async () => {
    // The narrow projection made the archive read cheaper; it could not make it
    // bounded, because its cost is the size of everything the board has ever
    // finished. At k=1 that whole read is unnecessary — the one dep slug is
    // known before the read is issued, so ask for it directly.
    const node = fakeNode(cards);
    await listCmd({ cfg, node, column: "todo", json: true });

    expect(prefixReads(node, "done")).toHaveLength(0);
    // Still the column being listed, exactly once — the cheap read is kept.
    expect(prefixReads(node, "todo")).toHaveLength(1);
  });

  test("the switch is k, not the archive's size: same k stays off the archive as `done` grows", async () => {
    // Guards the axis the choice actually turns on. A seed keyed to anything
    // about the archive would start scanning again as the board ages, which is
    // the failure this whole branch exists to prevent.
    const node = fakeNode([
      ...cards,
      ...Array.from({ length: 200 }, (_, i) =>
        card({ slug: `archive-${i}`, column: "done", position: String(i + 2) }),
      ),
    ]);
    await listCmd({ cfg, node, column: "todo", json: true });

    expect(prefixReads(node, "done")).toHaveLength(0);
  });

  test("the column being LISTED keeps the product list projection — those rows render", async () => {
    const node = fakeNode(cards);
    await listCmd({ cfg, node, column: "todo", json: true });

    const listed = prefixReads(node, "todo");
    expect(listed).toHaveLength(1);
    // Product list (CARD_LIST_FIELDS → BoardCards), not the full write shape:
    // layout/db are write-only / rare; body is never on BoardCards.
    expect(listed[0]!.fields).toEqual(
      boardCardsWireProjection(boardCardsProjectionForCardFields(CARD_LIST_FIELDS)),
    );
    expect(listed[0]!.fields).not.toContain("layout");
    expect(listed[0]!.fields.length).toBeLessThan(BOARD_CARDS_FIELDS.length);
  });

  test("narrowing does not change the verdict: a finished dep still clears the block", async () => {
    const node = fakeNode(cards);
    const out = JSON.parse(await listCmd({ cfg, node, column: "todo", json: true })) as Array<
      Card & { blocked: boolean; missingDeps: string[] }
    >;

    const todo = out.find((c) => c.slug === "todo-a")!;
    expect(todo.blocked).toBe(false);
    expect(todo.missingDeps).toEqual([]);
  });

  test("an UNfinished dep still blocks — the seed is not a blanket unblock", async () => {
    const node = fakeNode([
      card({ slug: "todo-a", column: "todo", position: "1", deps: ["backlog-a"] }),
      card({ slug: "backlog-a", column: "backlog", position: "1" }),
      card({ slug: "done-a", column: "done", position: "1" }),
    ]);
    const out = JSON.parse(await listCmd({ cfg, node, column: "todo", json: true })) as Array<
      Card & { blocked: boolean; blockedBy: string[] }
    >;

    const todo = out.find((c) => c.slug === "todo-a")!;
    expect(todo.blocked).toBe(true);
    expect(todo.blockedBy).toEqual(["backlog-a"]);
  });

  test("a soft-deleted dep is still reported missing — `tags` stays in the projection", async () => {
    const node = fakeNode([
      card({ slug: "todo-a", column: "todo", position: "1", deps: ["done-a"] }),
      card({ slug: "done-a", column: "done", position: "1", tags: [TOMBSTONE_TAG] }),
    ]);
    const out = JSON.parse(await listCmd({ cfg, node, column: "todo", json: true })) as Array<
      Card & { blocked: boolean; missingDeps: string[] }
    >;

    const todo = out.find((c) => c.slug === "todo-a")!;
    expect(todo.missingDeps).toEqual(["done-a"]);
    expect(todo.blocked).toBe(true);
  });
});

describe("pickup classification hydrates only cards it will classify", () => {
  // `pickupClassificationNeedsBody` fires on a body-omitted Kind:pr card whose
  // repo/base are not in structured fields — the shape below, in both a live
  // column and the terminal one.
  const needy = (slug: string, column: string): Card => {
    const c = card({ slug, column, position: "1", body: "", repo: "", base: "", kind: "pr" });
    c[BODY_OMITTED] = true;
    return c;
  };

  test("a terminal-column card is never point-read for its body", async () => {
    const cards = [needy("todo-a", "todo"), needy("done-a", "done"), needy("done-b", "done")];
    const node = fakeNode(cards);

    await hydrateForPickupClassification(node, cfg, cards, [DEFAULT_BOARD]);

    const hydrated = node.queries
      .filter((q) => q.schemaHash === "cardhash" && q.filter?.HashKey)
      .map((q) => q.filter!.HashKey);
    expect(hydrated).toEqual(["todo-a"]);
  });

  test("cost does not scale with the archive", async () => {
    const archive = (n: number) =>
      Array.from({ length: n }, (_, i) => needy(`done-${i}`, "done"));

    const small = [needy("todo-a", "todo"), ...archive(3)];
    const smallNode = fakeNode(small);
    await hydrateForPickupClassification(smallNode, cfg, small, [DEFAULT_BOARD]);

    const large = [needy("todo-a", "todo"), ...archive(300)];
    const largeNode = fakeNode(large);
    await hydrateForPickupClassification(largeNode, cfg, large, [DEFAULT_BOARD]);

    expect(largeNode.queries.length).toBe(smallNode.queries.length);
  });

  test("an active card that needs its body still gets it", async () => {
    const cards = [needy("todo-a", "todo"), needy("backlog-a", "backlog"), needy("done-a", "done")];
    const node = fakeNode(cards);

    const out = await hydrateForPickupClassification(node, cfg, cards, [DEFAULT_BOARD]);

    const hydrated = node.queries
      .filter((q) => q.schemaHash === "cardhash" && q.filter?.HashKey)
      .map((q) => q.filter!.HashKey)
      .sort();
    expect(hydrated).toEqual(["backlog-a", "todo-a"]);
    expect(out).toHaveLength(3);
  });

  test("a board with a custom terminal column is respected, not a hardcoded `done`", async () => {
    const custom: Board = { ...DEFAULT_BOARD, slug: "ship-board", columns: ["spec", "build", "ship"] };
    const cards = [
      { ...needy("spec-a", "spec"), board: "ship-board" },
      { ...needy("ship-a", "ship"), board: "ship-board" },
    ];
    const node = fakeNode(cards, [custom]);

    await hydrateForPickupClassification(node, cfg, cards, [custom]);

    const hydrated = node.queries
      .filter((q) => q.schemaHash === "cardhash" && q.filter?.HashKey)
      .map((q) => q.filter!.HashKey);
    expect(hydrated).toEqual(["spec-a"]);
  });
});
