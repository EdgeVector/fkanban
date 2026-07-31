// Read-amplification budget for the BOARD LIST (`card_list_index` HashKey
// `all_boards`), the companion to `list-read-amplification.test.ts` (which pins
// the CARD list).
//
// Why this file exists: every card list needs the board set to know which
// BoardCards partitions to query, so `listCards()` reads `all_boards`
// internally. A command that ALSO fetches the board list for itself — to build
// a terminal-column map, to resolve a board body — therefore paid the same
// keyed read twice. It was invisible because both reads succeed and return the
// same answer; only a read COUNT catches it.
//
// Measured on the live board before the fix (`scripts/probe-command-reads.ts`):
//
//   card_list_index  HashKey(all_boards)  fields=3  rows=1  212ms
//   card_list_index  HashKey(all_boards)  fields=3  rows=1  212ms   <- duplicate
//
// 425ms of pure duplication per `kanban pickup status`, the fleet's hottest
// routine. The fix threads an explicit `{ boards }` down into the list helpers.
//
// These tests assert the CONTRACT, not the implementation: one command
// invocation reads the board list at most once. They fail on the pre-fix code.

import { describe, expect, test } from "bun:test";

import { pickupStatusResult } from "../src/commands/pickup_status.ts";
import { pickupLanesResult } from "../src/commands/pickup_lanes.ts";
import { listCmd } from "../src/commands/list.ts";
import { boardListResult } from "../src/commands/board.ts";
import type { NodeClient, QueryFilter, QueryResponse } from "../src/client.ts";
import {
  boardToFields,
  cardToFields,
  emptyStructuredFields,
  toBoardSummary,
  type Board,
  type Card,
} from "../src/record.ts";
import { boardCardFieldsFromCard, boardCardSk } from "../src/board-cards.ts";
import type { Config } from "../src/config.ts";

// The shape a real install has: BoardCards bound AND the board-list rollup
// bound, so `listBoards` takes the production keyed-read path rather than the
// full-scan seed fallback.
const cfgWithIndexes: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: {
    card: "cardhash",
    board: "boardhash",
    board_cards: "boardcardshash",
    card_list_index: "cardlistindexhash",
  },
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
 * Fake node serving Card, Board, BoardCards and the `card_list_index` rollup,
 * logging every query so a test can count reads per key.
 */
function fakeNode(
  cards: Card[],
  boards: Board[] = [board()],
): NodeClient & { queries: QueryLog[] } {
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
  // The board-list rollup row, already seeded — the steady state on a real node.
  const indexRows: Record<string, { fields: Record<string, unknown>; key: { hash: string; range: null } }> = {
    all_boards: {
      fields: { key: "all_boards", payload_json: JSON.stringify(boards.map(toBoardSummary)) },
      key: { hash: "all_boards", range: null },
    },
  };

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
      queries.push({ schemaHash: q.schemaHash, filter: q.filter, fields: q.fields });
      if (q.schemaHash === "cardlistindexhash") {
        const key = q.filter?.HashKey;
        const row = typeof key === "string" ? indexRows[key] : undefined;
        return { ok: true, results: row ? [row] : [] };
      }
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

/** Reads of the `all_boards` rollup — the read this file budgets. */
const boardListReads = (node: { queries: QueryLog[] }) =>
  node.queries.filter((q) => q.schemaHash === "cardlistindexhash" && q.filter?.HashKey === "all_boards");

/**
 * A full-scan of the Board product also answers "what boards exist". Counting
 * it alongside the rollup keeps the assertion honest if a path ever falls back
 * to the seed scan instead of the keyed read.
 */
const boardScans = (node: { queries: QueryLog[] }) =>
  node.queries.filter((q) => q.schemaHash === "boardhash" && !q.filter?.HashKey);

function todoCards(n: number): Card[] {
  return Array.from({ length: n }, (_, i) =>
    card({ slug: `todo-${i}`, title: `Todo ${i}`, column: "todo", position: String(i + 1) }),
  );
}

describe("board-list read amplification — one command reads the board list once", () => {
  test("pickup status reads all_boards exactly once", async () => {
    const node = fakeNode(todoCards(6));
    await pickupStatusResult({ cfg: cfgWithIndexes, node });

    // Pre-fix this was 2: Promise.all([listCards(), listBoards()]) and
    // listCards() reads the board list internally.
    expect(boardListReads(node)).toHaveLength(1);
    expect(boardScans(node)).toHaveLength(0);
  });

  test("pickup lanes reads all_boards exactly once", async () => {
    const node = fakeNode(todoCards(6));
    await pickupLanesResult({ cfg: cfgWithIndexes, node });

    expect(boardListReads(node)).toHaveLength(1);
    expect(boardScans(node)).toHaveLength(0);
  });

  test("board list reads all_boards exactly once even though it also counts cards", async () => {
    const node = fakeNode(todoCards(6));
    await boardListResult({ cfg: cfgWithIndexes, node });

    // `board list` fetches boards, then listCardsForDisplay for per-board
    // counts — which needed the same board set.
    expect(boardListReads(node)).toHaveLength(1);
    expect(boardScans(node)).toHaveLength(0);
  });

  // Regression guard, not a witness for this fix: the footer already threads its
  // board set (fkanban 355bd64), so `listCardsForDisplay` is only the fallback
  // when `listOtherBoardCardsForFooter` returns null. Pinned so the footer path
  // cannot silently regrow the second read.
  test("a board-wide list with the cross-board footer reads all_boards exactly once", async () => {
    const node = fakeNode([
      ...todoCards(4),
      card({ slug: "other-a", board: "other", column: "todo", position: "1" }),
    ], [board(), board({ slug: "other", title: "Other board" })]);
    await listCmd({ cfg: cfgWithIndexes, node });

    expect(boardListReads(node)).toHaveLength(1);
    expect(boardScans(node)).toHaveLength(0);
  });

  test("--group-by-milestone reads all_boards once, not once per consumer", async () => {
    // `listMilestones` needs the board set too, so this path read the rollup
    // THREE times pre-fix: listBoards + listCards + listMilestones.
    const cfg: Config = {
      ...cfgWithIndexes,
      schemaHashes: {
        ...cfgWithIndexes.schemaHashes,
        milestone: "milestonehash",
        board_milestones: "boardmilestoneshash",
      },
    };
    const node = fakeNode(todoCards(4));
    await listCmd({ cfg, node, groupByMilestone: true });

    expect(boardListReads(node)).toHaveLength(1);
    expect(boardScans(node)).toHaveLength(0);
  });

  test("board-list read cost is independent of card count", async () => {
    const small = fakeNode(todoCards(5));
    await pickupStatusResult({ cfg: cfgWithIndexes, node: small });

    const large = fakeNode(todoCards(300));
    await pickupStatusResult({ cfg: cfgWithIndexes, node: large });

    expect(boardListReads(large)).toHaveLength(boardListReads(small).length);
  });

  test("the threaded board set is the one actually used to query partitions", async () => {
    // Guards the obvious wrong fix: accepting `{ boards }` and then ignoring it,
    // which would keep the read count at 1 only by accident of caching. Two
    // boards in, two BoardCards partitions queried.
    const node = fakeNode(
      [card({ slug: "a", board: "default" }), card({ slug: "b", board: "other" })],
      [board(), board({ slug: "other", title: "Other board" })],
    );
    const { report } = await pickupStatusResult({ cfg: cfgWithIndexes, node });

    expect(report).toBeDefined();
    const partitions = new Set(
      node.queries
        .filter((q) => q.schemaHash === "boardcardshash")
        .map((q) => {
          const prefix = (q.filter as unknown as { HashRangePrefix?: { hash?: string } } | undefined)?.HashRangePrefix;
          return prefix?.hash ?? (q.filter?.HashKey as string | undefined);
        })
        .filter((h): h is string => typeof h === "string"),
    );
    expect(partitions).toEqual(new Set(["default", "other"]));
    expect(boardListReads(node)).toHaveLength(1);
  });
});
