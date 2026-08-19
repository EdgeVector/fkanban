// A diagnostic that can only ever print one answer is not a diagnostic.
//
// `listCardsByFilter` returned `{ cards, indexed: boolean }` with `indexed`
// HARD-CODED to `false` on both of its return paths. Its only consumer was
// `search`'s `FKANBAN_DEBUG_QUERY_PLAN` line, which printed it as
// `displayIndexed` — so the field existed solely to be printed, and it printed
// a constant.
//
// The cost of that is not cosmetic. `FKANBAN_DEBUG_QUERY_PLAN` is what someone
// sets when they already believe a search is too slow. On the live primary the
// display read IS served by BoardCards, and the plan line said
// `"displayIndexed": false` anyway — pointing the reader at a missing index
// that was never missing, on the one path they had turned the instrument on to
// understand.
//
// The replacement reports the branch that actually answered. This file pins
// that it is a REPORT and not a constant, which needs more than one expected
// value: every assertion below expects a DIFFERENT `servedBy`, so no
// hard-coded return — the old `false`, or any single new string — can satisfy
// the file. That is the property the old field failed, and asserting only the
// healthy path would have let it pass.
//
// The four branches are deliberately not collapsed to healthy/unhealthy.
// `refused` and `full-scan` are both "no index answered", and they want
// opposite responses: `refused` is a caller that declined the scan on purpose
// (`allowKeyListFallback: false`) and got an empty list, while `full-scan` is
// an admin scan of Card that also rewrites the indexes. A boolean cannot tell
// an operator which one they are looking at, which is how the field this
// replaces became useless in the first place.

import { describe, expect, test } from "bun:test";

import type { NodeClient, QueryFilter, QueryResponse } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { boardCardFieldsFromCard, boardCardSk } from "../src/board-cards.ts";
import { CARD_LIST_INDEX_KEY } from "../src/card-list-index.ts";
import {
  boardToFields,
  cardToFields,
  emptyStructuredFields,
  listCardsByFilter,
  type Board,
  type Card,
} from "../src/record.ts";

/** A modern node: `board_cards` bound, so the CardListIndex rollup is superseded. */
const MODERN: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash", board_cards: "boardcardshash" },
};

/**
 * A legacy node: `board_cards` UNBOUND, `card_list_index` bound. This is the
 * only configuration in which the rollup is still served — with `board_cards`
 * bound, `cardListIndexIsSuperseded` refuses it whatever it holds.
 */
const LEGACY: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash", card_list_index: "cardlistindexhash" },
};

function board(): Board {
  return {
    slug: "default",
    title: "Default board",
    body: "",
    columns: ["backlog", "todo", "doing", "done"],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function card(partial: Partial<Card> = {}): Card {
  return {
    slug: "a-card",
    title: "A card",
    body: "## GOAL\nShip it.\n",
    board: "default",
    column: "todo",
    position: "1",
    assignee: "",
    tags: [],
    deps: [],
    ...emptyStructuredFields(),
    kind: "pr",
    repo: "EdgeVector/fkanban",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

type Row = { fields: Record<string, unknown>; hash: string; range: string | null };

/**
 * `boardCards` and `cardListIndex` are independent so each branch can be
 * reached on purpose: the serving path is a property of which tables answer,
 * and a fake that always populates both could only ever exercise the first.
 */
function fakeNode(
  cards: Card[],
  opts: { boardCards: boolean; cardListIndex: boolean },
) {
  const tables = new Map<string, Row[]>();
  const rowsOf = (schemaHash: string): Row[] => {
    let t = tables.get(schemaHash);
    if (!t) {
      t = [];
      tables.set(schemaHash, t);
    }
    return t;
  };

  rowsOf("boardhash").push({ fields: boardToFields(board()), hash: "default", range: null });
  for (const c of cards) {
    rowsOf("cardhash").push({ fields: cardToFields(c), hash: c.slug, range: null });
    if (opts.boardCards) {
      rowsOf("boardcardshash").push({
        fields: boardCardFieldsFromCard(c),
        hash: c.board,
        range: boardCardSk(c.column, c.position, c.slug),
      });
    }
  }
  // Bound-but-empty when the caller asked for no rows: "the schema exists and
  // holds nothing" is a different state from "the schema is unbound", and the
  // fall-through distinguishes them.
  rowsOf("boardcardshash");

  if (opts.cardListIndex) {
    rowsOf("cardlistindexhash").push({
      fields: {
        key: CARD_LIST_INDEX_KEY,
        payload_json: JSON.stringify(cards.map((c) => ({ ...c, body: "" }))),
        updated_at: "2026-01-01T00:00:00.000Z",
      },
      hash: CARD_LIST_INDEX_KEY,
      range: null,
    });
  }

  const project = (fields: Record<string, unknown>, requested?: string[]) => {
    if (!requested || requested.length === 0) return { ...fields };
    const out: Record<string, unknown> = {};
    for (const f of requested) if (f in fields) out[f] = fields[f];
    return out;
  };

  const stub = () => {
    throw new Error("not implemented in fake node");
  };

  const node = {
    baseUrl: "http://fake",
    userHash: "test-user",
    autoIdentity: stub as never,
    bootstrap: stub as never,
    loadSchemas: stub as never,
    listSchemas: stub as never,
    rawCall: stub as never,
    nodeTransport: stub as never,
    async createRecord() {},
    async updateRecord() {},
    async deleteRecord() {},
    async listRecordKeys(schemaHash: string, opts: { limit?: number; cursor?: string | null } = {}) {
      if (!tables.has(schemaHash)) throw new Error(`unbound schema ${schemaHash}`);
      const all = rowsOf(schemaHash)
        .filter((r) => r.range === null)
        .sort((a, b) => a.hash.localeCompare(b.hash));
      const limit = Math.max(1, Math.trunc(opts.limit ?? 1000));
      const start = opts.cursor
        ? all.findIndex((r) => r.hash > opts.cursor!) 
        : 0;
      const offset = start < 0 ? all.length : start;
      const page = all.slice(offset, offset + limit);
      const hasMore = offset + page.length < all.length;
      return {
        schema: schemaHash,
        keys: page.map((r) => ({ hash: r.hash, range: null })),
        has_more: hasMore,
        next_cursor: hasMore && page.length > 0 ? page[page.length - 1]!.hash : null,
        truncated: hasMore,
      };
    },
    async queryAll(q: { schemaHash: string; fields?: string[]; filter?: QueryFilter }): Promise<QueryResponse> {
      // An UNBOUND schema is not an empty table — the node rejects the query,
      // which is what drives `boardCardsThrew` and the legacy fall-through.
      if (!tables.has(q.schemaHash)) throw new Error(`unbound schema ${q.schemaHash}`);
      const all = rowsOf(q.schemaHash);
      const prefix = (q.filter as unknown as { HashRangePrefix?: { hash?: string; prefix?: string } } | undefined)
        ?.HashRangePrefix;
      let rows = all;
      if (prefix?.hash !== undefined && prefix.prefix !== undefined) {
        rows = all.filter((r) => r.hash === prefix.hash && (r.range ?? "").startsWith(prefix.prefix!));
      } else if (q.filter?.HashKey) {
        rows = all.filter((r) => r.hash === q.filter!.HashKey);
      }
      const results = rows.map((r) => ({
        fields: project(r.fields, q.fields),
        key: { hash: r.hash, range: r.range },
      }));
      return { ok: true, results, returned_count: results.length, total_count: results.length };
    },
  };
  return node as unknown as NodeClient;
}

const FIELDS = ["slug", "board", "column", "position", "title"];

describe("a card list reports which read answered it", () => {
  test("BoardCards partitions serve the list, and say so", async () => {
    const node = fakeNode([card()], { boardCards: true, cardListIndex: false });

    const read = await listCardsByFilter(node, MODERN, {}, FIELDS);

    expect(read.servedBy).toBe("board-cards");
    // The path is only meaningful if the read actually worked — a report of
    // "board-cards" over an empty answer would be worse than the constant.
    expect(read.cards.map((c) => c.slug)).toEqual(["a-card"]);
  });

  test("an admin full scan is reported as a full scan, not as an index", async () => {
    // BoardCards bound but empty and no rollup: the post-`init`/pre-backfill
    // state the fall-through exists for. This is the expensive branch, and the
    // one an operator most needs the plan line to name.
    const node = fakeNode([card()], { boardCards: false, cardListIndex: false });

    const read = await listCardsByFilter(node, MODERN, {}, FIELDS);

    expect(read.servedBy).toBe("full-scan");
    expect(read.cards.map((c) => c.slug)).toEqual(["a-card"]);
  });

  test("a caller that declines the scan is `refused`, distinct from `full-scan`", async () => {
    // Same node, same absent indexes — only the caller's policy differs. If
    // these two collapsed to one value the plan line could not tell an operator
    // whether the empty list was a decision or a failure. `search` is exactly
    // this caller: it passes `allowKeyListFallback: false`.
    const node = fakeNode([card()], { boardCards: false, cardListIndex: false });

    const read = await listCardsByFilter(node, MODERN, {}, FIELDS, {
      allowKeyListFallback: false,
    });

    expect(read.servedBy).toBe("refused");
    expect(read.cards).toEqual([]);
  });

  test("a legacy node's rollup is reported as the rollup", async () => {
    const node = fakeNode([card()], { boardCards: false, cardListIndex: true });

    const read = await listCardsByFilter(node, LEGACY, {}, FIELDS);

    expect(read.servedBy).toBe("card-list-index");
    expect(read.cards.map((c) => c.slug)).toEqual(["a-card"]);
  });

  test("a client-side field filter reports the READ's path, not the predicate", async () => {
    // `listCardsByFilter` with a non-empty filter takes `listCardsClientFiltered`
    // — a different function, and the second place the old constant was
    // returned from. Filtering happens client-side after the read, so the cost
    // being reported is still the read's.
    const node = fakeNode([card(), card({ slug: "other", column: "done", position: "2" })], {
      boardCards: true,
      cardListIndex: false,
    });

    const read = await listCardsByFilter(node, MODERN, { column: "todo" }, FIELDS);

    expect(read.servedBy).toBe("board-cards");
    expect(read.cards.map((c) => c.slug)).toEqual(["a-card"]);
  });
});
