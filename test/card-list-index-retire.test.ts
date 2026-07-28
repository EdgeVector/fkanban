// The CardListIndex `all_cards` rollup is retired where BoardCards exists.
//
// Why this file exists: `all_cards` was one Hash row holding EVERY card,
// rewritten in full on every card mutation. Measured on the primary 2026-07-28
// it was 271,954 B growing ~1.9 KB/h — ~5.5 days from the raised 512 KiB atom
// ceiling, where the first crossing half-commits (Card lands, index patch
// rejected). BoardCards (HashRange, hash=board) already carries the same
// body-free summary one row per card, so the fix is to stop writing the rollup
// rather than migrate it.
//
// These tests pin the three things that must stay true:
//   1. a card mutation writes ZERO rollup rows when BoardCards is bound,
//   2. a CLEARED rollup is never mistaken for "the board has no cards",
//   3. clearing refuses while any live card lacks a BoardCards row.

import { describe, expect, test } from "bun:test";

import type { NodeClient, QueryFilter, QueryResponse } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import {
  createCardRecord,
  listCards,
  boardToFields,
  cardToFields,
  emptyStructuredFields,
  type Board,
  type Card,
} from "../src/record.ts";
import { boardCardFieldsFromCard, boardCardSk } from "../src/board-cards.ts";
import { cardListIndexRetireResult } from "../src/commands/card_list_index_retire.ts";

const CARD = "cardhash";
const BOARD = "boardhash";
const BOARD_CARDS = "boardcardshash";
const CLI = "cardlistindexhash";

/** The shape a real install has: both indexes bound. */
const cfgCutover: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: CARD, board: BOARD, board_cards: BOARD_CARDS, card_list_index: CLI },
};

/** A node that predates BoardCards — the rollup is still the only card index. */
const cfgLegacy: Config = {
  ...cfgCutover,
  schemaHashes: { card: CARD, board: BOARD, card_list_index: CLI },
};

function board(partial: Partial<Board> = {}): Board {
  return {
    slug: "default",
    title: "Default board",
    body: "",
    columns: ["backlog", "todo", "doing", "done"],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

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

type Write = { schemaHash: string; keyHash?: string };

type FakeOpts = {
  /** Entries stored under the `all_cards` key. `null` = no row at all. */
  rollup?: Array<Record<string, unknown>> | null;
  /** Cards that have a BoardCards row (defaults to every card). */
  boardCardSlugs?: string[];
  /** Make every BoardCards query throw, simulating a transient node error. */
  boardCardsFail?: boolean;
};

function fakeNode(cards: Card[], opts: FakeOpts = {}) {
  const queries: Array<{ schemaHash: string; filter?: QueryFilter }> = [];
  const writes: Write[] = [];
  const stub = () => {
    throw new Error("not implemented in fake node");
  };

  const boards = [board()];
  const boardRows = boards.map((b) => ({ fields: boardToFields(b), key: { hash: b.slug, range: null } }));
  const cardRows = cards.map((c) => ({ fields: cardToFields(c), key: { hash: c.slug, range: null } }));
  const covered = new Set(opts.boardCardSlugs ?? cards.map((c) => c.slug));
  const boardCardRows = cards
    .filter((c) => covered.has(c.slug))
    .map((c) => ({
      fields: boardCardFieldsFromCard(c),
      key: { hash: c.board, range: boardCardSk(c.column, c.position, c.slug) },
    }));

  // `rollup: undefined` means "row exists, holds every card" (pre-retirement).
  const rollupEntries =
    opts.rollup === undefined ? cards.map((c) => ({ ...c, body: "" })) : opts.rollup;

  const node = {
    baseUrl: "http://fake",
    userHash: "test-user",
    queries,
    writes,
    autoIdentity: stub as never,
    bootstrap: stub as never,
    loadSchemas: stub as never,
    listSchemas: stub as never,
    rawCall: stub as never,
    nodeTransport: stub as never,
    createRecord: (async (w: Write) => {
      writes.push(w);
    }) as never,
    updateRecord: (async (w: Write) => {
      writes.push(w);
    }) as never,
    deleteRecord: (async (w: Write) => {
      writes.push(w);
    }) as never,
    async queryAll(q: { schemaHash: string; fields: string[]; filter?: QueryFilter }): Promise<QueryResponse> {
      queries.push({ schemaHash: q.schemaHash, filter: q.filter });
      if (q.schemaHash === BOARD_CARDS) {
        if (opts.boardCardsFail) throw new Error("board_cards query failed (simulated)");
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
      if (q.schemaHash === CLI) {
        const key = q.filter?.HashKey;
        if (key === "all_boards") {
          return {
            ok: true,
            results: [
              {
                fields: { key: "all_boards", payload_json: JSON.stringify(boards), updated_at: "" },
                key: { hash: "all_boards", range: null },
              },
            ],
          };
        }
        if (rollupEntries === null) return { ok: true, results: [] };
        return {
          ok: true,
          results: [
            {
              fields: {
                key: "all_cards",
                payload_json: JSON.stringify(rollupEntries),
                updated_at: "",
              },
              key: { hash: "all_cards", range: null },
            },
          ],
        };
      }
      if (q.schemaHash === CARD) {
        if (q.filter?.HashKey) {
          return { ok: true, results: cardRows.filter((r) => r.key.hash === q.filter!.HashKey) };
        }
        return { ok: true, results: cardRows };
      }
      if (q.schemaHash === BOARD) {
        if (q.filter?.HashKey) {
          return { ok: true, results: boardRows.filter((r) => r.key.hash === q.filter!.HashKey) };
        }
        return { ok: true, results: boardRows };
      }
      return { ok: true, results: [] };
    },
  } as unknown as NodeClient & { queries: typeof queries; writes: Write[] };
  return node;
}

const rollupWrites = (node: { writes: Write[] }) =>
  node.writes.filter((w) => w.schemaHash === CLI && w.keyHash === "all_cards");

describe("CardListIndex all_cards is retired where BoardCards exists", () => {
  test("a card mutation writes no all_cards row — this is the unbounded write", async () => {
    const node = fakeNode([card({ slug: "existing" })]);
    await createCardRecord({ cfg: cfgCutover, node }, card({ slug: "fresh", position: "2" }));

    expect(rollupWrites(node)).toHaveLength(0);
    // ...and the row it DOES write is the bounded one, per card.
    expect(node.writes.some((w) => w.schemaHash === BOARD_CARDS)).toBe(true);
  });

  test("a legacy node without BoardCards still maintains the rollup", async () => {
    const node = fakeNode([card({ slug: "existing" })]);
    await createCardRecord({ cfg: cfgLegacy, node }, card({ slug: "fresh", position: "2" }));

    expect(rollupWrites(node).length).toBeGreaterThan(0);
  });

  test("a cleared rollup is not mistaken for an empty board when BoardCards fails", async () => {
    // The regression this guards: `groom card-list-index-retire` stores `[]`,
    // which reads back as an empty array rather than a missing row. On the
    // fall-through taken when the BoardCards query THREW, returning that as the
    // answer reports "no cards" — and an agent reads an empty board as no work.
    const cards = [card({ slug: "todo-a" }), card({ slug: "todo-b", position: "2" })];
    const node = fakeNode(cards, { rollup: [], boardCardsFail: true });

    const listed = await listCards(node, cfgCutover);
    expect(listed.map((c) => c.slug).sort()).toEqual(["todo-a", "todo-b"]);
  });

  test("an empty board still reports empty when BoardCards answers", async () => {
    const node = fakeNode([], { rollup: [] });
    expect(await listCards(node, cfgCutover)).toHaveLength(0);
  });
});

describe("groom card-list-index-retire gate", () => {
  test("refuses to clear while a live card has no BoardCards row", async () => {
    const cards = [card({ slug: "covered" }), card({ slug: "drifted", position: "2" })];
    const node = fakeNode(cards, { boardCardSlugs: ["covered"] });

    const { report } = await cardListIndexRetireResult({ cfg: cfgCutover, node, apply: true });

    expect(report.uncovered_live).toEqual(["drifted"]);
    expect(report.cleared).toBe(false);
    expect(report.blocked_reason).toContain("board-cards-heal");
    expect(rollupWrites(node)).toHaveLength(0);
  });

  test("clears once BoardCards covers every live card", async () => {
    const cards = [card({ slug: "covered" }), card({ slug: "also", position: "2" })];
    const node = fakeNode(cards);

    const { report } = await cardListIndexRetireResult({ cfg: cfgCutover, node, apply: true });

    expect(report.uncovered_live).toHaveLength(0);
    expect(report.covered).toBe(2);
    expect(report.cleared).toBe(true);
    expect(rollupWrites(node)).toHaveLength(1);
  });

  test("a rollup entry whose Card is gone is a tombstone, not drift", async () => {
    // The rollup only ever grew: it never dropped deleted cards. 15 of 323
    // entries on the primary had no Card record at all.
    const cards = [card({ slug: "live" })];
    const node = fakeNode(cards, {
      rollup: [{ slug: "live", board: "default", column: "todo" }, { slug: "deleted-long-ago" }],
    });

    const { report } = await cardListIndexRetireResult({ cfg: cfgCutover, node, apply: false });

    expect(report.tombstones).toEqual(["deleted-long-ago"]);
    expect(report.uncovered_live).toHaveLength(0);
    expect(report.dryRun).toBe(true);
    expect(report.cleared).toBe(false);
  });

  test("refuses on a node where BoardCards is not bound — the rollup is still the index", async () => {
    const node = fakeNode([card({ slug: "a" })]);
    const { report } = await cardListIndexRetireResult({ cfg: cfgLegacy, node, apply: true });

    expect(report.cleared).toBe(false);
    expect(report.blocked_reason).toContain("no board_cards schema bound");
  });
});
