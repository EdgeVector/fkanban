// Read-amplification budget for the board/column list path.
//
// Why this file exists: `list-perf-board-counts.test.ts` asserted a lot about
// WHICH fields go over the wire and WHETHER a full scan happened, but never how
// MANY node reads a list costs — and its list cases run on `cfg`, which has no
// `board_cards` hash, so they exercise the legacy fallback rather than the path
// production actually takes. A 1+N regression on the BoardCards path was
// therefore invisible: `list --column todo` rendering 10 cards issued 11 Card
// point-reads (26.6s against the live node) while every assertion stayed green.
//
// These tests pin the access-model contract instead (`concepts-lastdb-agent-
// access-model`): a board/column list is O(1) keyed queries, independent of card
// count. They all use `cfgWithIndexes` — the shape a real install has.

import { describe, expect, test } from "bun:test";

import { listCmd } from "../src/commands/list.ts";
import type { NodeClient, QueryFilter, QueryResponse } from "../src/client.ts";
import { boardToFields, cardToFields, emptyStructuredFields, type Board, type Card } from "../src/record.ts";
import { boardCardFieldsFromCard, boardCardSk } from "../src/board-cards.ts";
import type { Config } from "../src/config.ts";

const cfgWithIndexes: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash", board_cards: "boardcardshash" },
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

type QueryLog = { schemaHash: string; filter?: QueryFilter };

/**
 * Fake node that serves Card, Board and BoardCards, and logs every query so a
 * test can count reads per schema. Writes are counted too — the list path must
 * not mutate.
 */
function fakeNode(cards: Card[], boards: Board[] = [board()]): NodeClient & {
  queries: QueryLog[];
  writes: number;
} {
  const queries: QueryLog[] = [];
  const state = { writes: 0 };
  const stub = () => {
    throw new Error("not implemented in fake node");
  };
  const boardRows = boards.map((b) => ({ fields: boardToFields(b), key: { hash: b.slug, range: null } }));
  const cardRows = cards.map((c) => ({ fields: cardToFields(c), key: { hash: c.slug, range: null } }));
  const boardCardRows = cards.map((c) => ({
    fields: boardCardFieldsFromCard(c),
    key: { hash: c.board, range: boardCardSk(c.column, c.position, c.slug) },
  }));

  const node = {
    baseUrl: "http://fake",
    userHash: "test-user",
    queries,
    get writes() {
      return state.writes;
    },
    autoIdentity: stub as never,
    bootstrap: stub as never,
    loadSchemas: stub as never,
    listSchemas: stub as never,
    rawCall: stub as never,
    nodeTransport: stub as never,
    createRecord: (async () => {
      state.writes += 1;
    }) as never,
    updateRecord: (async () => {
      state.writes += 1;
    }) as never,
    deleteRecord: (async () => {
      state.writes += 1;
    }) as never,
    async queryAll(q: { schemaHash: string; fields: string[]; filter?: QueryFilter }): Promise<QueryResponse> {
      queries.push({ schemaHash: q.schemaHash, filter: q.filter });
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
  } as unknown as NodeClient & { queries: QueryLog[]; writes: number };
  return node;
}

const cardQueries = (node: { queries: QueryLog[] }) => node.queries.filter((q) => q.schemaHash === "cardhash");
const boardCardQueries = (node: { queries: QueryLog[] }) =>
  node.queries.filter((q) => q.schemaHash === "boardcardshash");

function todoCards(n: number): Card[] {
  return Array.from({ length: n }, (_, i) =>
    card({ slug: `todo-${i}`, title: `Todo ${i}`, column: "todo", position: String(i + 1) }),
  );
}

describe("list read amplification — cost must not scale with card count", () => {
  test("--column costs one BoardCards query and zero Card point-reads", async () => {
    const node = fakeNode(todoCards(10));
    const out = await listCmd({ cfg: cfgWithIndexes, node, column: "todo", json: true });

    expect((JSON.parse(out) as Card[]).map((c) => c.slug)).toContain("todo-0");
    expect(boardCardQueries(node)).toHaveLength(1);
    // The regression this file exists for: one Card point-read per rendered row.
    expect(cardQueries(node)).toHaveLength(0);
  });

  test("board-wide list costs zero Card point-reads", async () => {
    const node = fakeNode([
      ...todoCards(8),
      card({ slug: "doing-a", column: "doing", position: "1" }),
      card({ slug: "done-a", column: "done", position: "1" }),
    ]);
    const out = await listCmd({ cfg: cfgWithIndexes, node, json: true });

    expect((JSON.parse(out) as Card[]).length).toBeGreaterThan(0);
    expect(cardQueries(node)).toHaveLength(0);
  });

  test("read cost is flat: 10 cards and 200 cards issue the same number of reads", async () => {
    const small = fakeNode(todoCards(10));
    await listCmd({ cfg: cfgWithIndexes, node: small, column: "todo", json: true });

    const large = fakeNode(todoCards(200));
    await listCmd({ cfg: cfgWithIndexes, node: large, column: "todo", json: true });

    expect(large.queries.length).toBe(small.queries.length);
  });

  test("the list path never writes", async () => {
    const node = fakeNode(todoCards(10));
    await listCmd({ cfg: cfgWithIndexes, node, column: "todo", json: true });
    expect(node.writes).toBe(0);
  });

  // `--full-body` is the explicit opt-in to the expensive surface: it suppresses
  // the implicit page cap (`implicitJsonDefault` is false whenever fullBody is
  // set), so it pays one body point-read per card it RETURNS. That is
  // proportional, not amplified — the cost is the data the caller asked for.
  // `--limit` is how a caller bounds it.
  test("--full-body pays one body read per returned card and no more", async () => {
    const node = fakeNode(todoCards(50));
    const out = JSON.parse(
      await listCmd({ cfg: cfgWithIndexes, node, column: "todo", json: true, fullBody: true }),
    ) as Card[];

    const bodyReads = cardQueries(node).filter((q) => q.filter?.HashKey !== undefined);
    expect(bodyReads).toHaveLength(out.length);
  });

  test("--limit bounds body hydration to the capped page", async () => {
    const node = fakeNode(todoCards(50));
    const out = JSON.parse(
      await listCmd({ cfg: cfgWithIndexes, node, column: "todo", json: true, fullBody: true, limit: 5 }),
    ) as Card[];

    expect(out).toHaveLength(5);
    const bodyReads = cardQueries(node).filter((q) => q.filter?.HashKey !== undefined);
    expect(bodyReads).toHaveLength(5);
  });

  test("duplicate sks for one slug collapse to the fresher row", async () => {
    const stale = card({ slug: "dup", column: "doing", position: "1", updated_at: "2026-01-01T00:00:00.000Z" });
    const fresh = card({ slug: "dup", column: "done", position: "2", updated_at: "2026-02-01T00:00:00.000Z" });
    const node = fakeNode([stale, fresh]);

    const out = JSON.parse(await listCmd({ cfg: cfgWithIndexes, node, json: true })) as Card[];
    const dup = out.filter((c) => c.slug === "dup");
    expect(dup).toHaveLength(1);
    expect(dup[0]!.column).toBe("done");
    expect(cardQueries(node)).toHaveLength(0);
  });
});
