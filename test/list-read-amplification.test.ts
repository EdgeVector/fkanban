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
import { TOMBSTONE_TAG, boardToFields, cardToFields, emptyStructuredFields, type Board, type Card } from "../src/record.ts";
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

type QueryLog = { schemaHash: string; filter?: QueryFilter; fields: string[] };

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
      queries.push({ schemaHash: q.schemaHash, filter: q.filter, fields: q.fields });
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

  // The text board prints a navigation footer ("ℹ 1 other board has cards:
  // scratch (2)"). It used to be fed by a cross-board read that fanned out over
  // EVERY board partition — including the one already on screen, at the wide
  // 24-field projection — and `otherBoardsFooter` then discarded those rows on
  // its first line. On the live board that meant bare `kanban list` issued
  // THREE BoardCards reads where `list --json` issued one, and the extra
  // expensive one was a verbatim re-read of the partition just fetched, against
  // the single hottest query fkanban makes.
  //
  // These pin the shape, not the timing: the viewed partition is read ONCE, and
  // the footer's own read is narrow.
  describe("the multi-board footer", () => {
    const twoBoards = [board(), board({ slug: "scratch", title: "Scratch" })];
    const acrossBoards = () => [
      ...todoCards(10),
      card({ slug: "s-1", title: "S1", board: "scratch", column: "todo", position: "1" }),
      card({ slug: "s-2", title: "S2", board: "scratch", column: "todo", position: "2" }),
    ];

    test("never re-reads the partition it is already rendering", async () => {
      const node = fakeNode(acrossBoards(), twoBoards);
      await listCmd({ cfg: cfgWithIndexes, node });

      const viewed = boardCardQueries(node).filter((q) => q.filter?.HashKey === "default");
      expect(viewed).toHaveLength(1);
    });

    test("reads only the boards it reports on, at a narrow projection", async () => {
      const node = fakeNode(acrossBoards(), twoBoards);
      await listCmd({ cfg: cfgWithIndexes, node });

      const footerRead = boardCardQueries(node).find((q) => q.filter?.HashKey === "scratch");
      expect(footerRead).toBeDefined();
      // Spine + tags. The wide read this replaced asked for all 24.
      expect(footerRead!.fields.slice().sort()).toEqual(
        ["board", "column", "position", "sk", "slug", "tags"],
      );
      // Card is never touched to render a count.
      expect(cardQueries(node)).toHaveLength(0);
    });

    test("a single-board install pays nothing for a footer it will not print", async () => {
      const node = fakeNode(todoCards(10));
      const out = await listCmd({ cfg: cfgWithIndexes, node });

      expect(boardCardQueries(node)).toHaveLength(1);
      expect(out).not.toContain("other board");
    });

    // Invariants — these must pass both before and after the narrowing.
    test("still names each other board and its live card count", async () => {
      const node = fakeNode(acrossBoards(), twoBoards);
      const out = await listCmd({ cfg: cfgWithIndexes, node });

      expect(out).toContain("1 other board has cards");
      expect(out).toContain("scratch (2)");
    });

    test("counts exclude tombstoned cards on the other board", async () => {
      const node = fakeNode(
        [
          ...todoCards(3),
          card({ slug: "s-live", board: "scratch", column: "todo", position: "1" }),
          card({ slug: "s-dead", board: "scratch", column: "todo", position: "2", tags: [TOMBSTONE_TAG] }),
        ],
        twoBoards,
      );
      const out = await listCmd({ cfg: cfgWithIndexes, node });

      expect(out).toContain("scratch (1)");
    });

    test("--json renders no footer and issues no footer read", async () => {
      const node = fakeNode(acrossBoards(), twoBoards);
      await listCmd({ cfg: cfgWithIndexes, node, json: true });

      expect(boardCardQueries(node).filter((q) => q.filter?.HashKey === "scratch")).toHaveLength(0);
    });

    // 2026-08-01 live outage. Bare `kanban list` exited 1 and printed NOTHING
    // because the empty `agent-dogfood-scratch` partition answered the footer's
    // narrow projection with `HTTP 400 … laststore: corrupt: empty rec` — three
    // queries after `default`, holding all 263 real cards, had been read back
    // intact. A one-line navigation hint about a board the user was not looking
    // at took down the board they were.
    //
    // The corrupt marker itself is LastDB's, and it is reachable only through
    // the NARROW projection (the same partition answers the wide 14- and
    // 22-field reads with 0 rows, cleanly). What is fkanban's to own is that a
    // decorative cross-board read could fail a command whose own board was fine.
    describe("when another board's partition cannot be read", () => {
      // Reproduces the live shape: this ONE partition throws on the footer's
      // narrow projection; every other read on the node is healthy.
      const nodeWithCorruptScratch = () => {
        const node = fakeNode(acrossBoards(), twoBoards);
        const inner = node.queryAll.bind(node);
        node.queryAll = (async (q: { schemaHash: string; fields: string[]; filter?: QueryFilter }) => {
          if (q.schemaHash === "boardcardshash" && q.filter?.HashKey === "scratch") {
            // Logged before throwing, so read-budget assertions still see it.
            (node.queries as QueryLog[]).push({ schemaHash: q.schemaHash, filter: q.filter, fields: q.fields });
            throw new Error(
              "Node /api/query returned HTTP 400: Invalid data: read hash-key marker " +
                "mhk:98fb8763:AIPo9o1OGEqqO1bus-P6Zw: Storage backend error: laststore: corrupt: empty rec.",
            );
          }
          return inner(q);
        }) as never;
        return node;
      };

      test("the viewed board still renders instead of the command failing", async () => {
        const out = await listCmd({ cfg: cfgWithIndexes, node: nodeWithCorruptScratch() });

        // The 10 todo cards on `default` are what the user asked for.
        expect(out).toContain("TODO  (10)");
        expect(out).toContain("todo-0");
        expect(out).toContain("todo-9");
      });

      test("the unreadable board is NAMED, never rendered as a board with no cards", async () => {
        const out = await listCmd({ cfg: cfgWithIndexes, node: nodeWithCorruptScratch() });

        expect(out).toContain("could not be read");
        expect(out).toContain("scratch");
        // The distinguishing assertion: "scratch (0)" would be a lie that reads
        // exactly like a healthy empty board.
        expect(out).not.toContain("scratch (0)");
      });

      test("one unreadable partition does not suppress the counts of readable ones", async () => {
        const node = fakeNode(
          [
            ...todoCards(3),
            card({ slug: "s-1", board: "scratch", column: "todo", position: "1" }),
            card({ slug: "r-1", board: "roadmap", column: "todo", position: "1" }),
          ],
          [...twoBoards, board({ slug: "roadmap", title: "Roadmap" })],
        );
        const inner = node.queryAll.bind(node);
        node.queryAll = (async (q: { schemaHash: string; filter?: QueryFilter }) => {
          if (q.schemaHash === "boardcardshash" && q.filter?.HashKey === "scratch") {
            throw new Error("HTTP 400: laststore: corrupt: empty rec");
          }
          return inner(q as never);
        }) as never;

        const out = await listCmd({ cfg: cfgWithIndexes, node });

        expect(out).toContain("roadmap (1)");
        expect(out).toContain("could not be read: scratch");
      });

      test("the failure does not fall back to the expensive cross-board re-read", async () => {
        const node = nodeWithCorruptScratch();
        await listCmd({ cfg: cfgWithIndexes, node });

        // The `null` fallback path re-reads EVERY partition wide, including the
        // one already on screen. A failed board is not a reason to pay that.
        const viewed = boardCardQueries(node).filter((q) => q.filter?.HashKey === "default");
        expect(viewed).toHaveLength(1);
      });
    });
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
