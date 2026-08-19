// First-run `kanban list` after `kanban init` must not enumerate a schema.
//
// Measured class: 2026-07-19 `situations list` 400 `full_schema_scan_not_allowed`
// on a FRESH node; 2026-08-19 llms-txt-install-smoke `kanban:list exit=1` after
// `kanban init` exited 0. LastDB has no scan: point get O(1), range under one
// hash O(log M). Init used to write the default Board record without dual-writing
// `all_boards`, so `listBoards` fell through to a Board census.
//
// These tests model a Mini that rejects unfiltered `/api/query` and `/api/list`.

import { describe, expect, test } from "bun:test";

import { FkanbanError, type NodeClient, type QueryFilter } from "../src/client.ts";
import { fakeNode } from "./fake-node.ts";
import type { Config } from "../src/config.ts";
import { seedDefaultBoard } from "../src/commands/init.ts";
import { listCmd, listResult } from "../src/commands/list.ts";
import {
  BOARD_LIST_INDEX_KEY,
  type BoardSummary,
} from "../src/card-list-index.ts";
import {
  boardToFields,
  listBoards,
  nowIso,
  toBoardSummary,
  type Board,
} from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";

const CARD = "cardhash";
const BOARD = "boardhash";
const INDEX = "cardlistindexhash";
const BOARD_CARDS = "boardcardshash";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: {
    card: CARD,
    board: BOARD,
    card_list_index: INDEX,
    board_cards: BOARD_CARDS,
  },
};

function defaultBoard(): Board {
  return {
    slug: "default",
    title: "Default board",
    body: "",
    columns: [...DEFAULT_COLUMNS],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function isKeyedFilter(filter: QueryFilter | undefined): boolean {
  if (!filter) return false;
  const f = filter as Record<string, unknown>;
  return (
    typeof f.HashKey === "string" ||
    (typeof f.HashRangePrefix === "object" && f.HashRangePrefix !== null) ||
    (typeof f.HashRangeKey === "object" && f.HashRangeKey !== null) ||
    (typeof f.HashRangeRange === "object" && f.HashRangeRange !== null)
  );
}

const SCAN_REJECTED = new FkanbanError({
  code: "full_schema_scan_not_allowed",
  message: "full_schema_scan_not_allowed",
  hint: "Use HashKey / HashRangePrefix under one hash. Scan does not exist.",
});

/** Live Mini: unfiltered queryAll and /api/list are schema censuses and 400. */
function noScanNode(): ReturnType<typeof fakeNode> {
  const inner = fakeNode({
    hashFields: { [BOARD]: "slug", [INDEX]: "key", [BOARD_CARDS]: "board", [CARD]: "slug" },
  });
  const queryAll = inner.queryAll.bind(inner);
  inner.queryAll = async ({ schemaHash, fields, filter }) => {
    if (!isKeyedFilter(filter)) throw SCAN_REJECTED;
    return queryAll({ schemaHash, fields, filter });
  };
  inner.listRecordKeys = async () => {
    throw SCAN_REJECTED;
  };
  return inner;
}

function seedBoardRecord(node: NodeClient, b: Board) {
  return node.createRecord({
    schemaHash: BOARD,
    keyHash: b.slug,
    fields: boardToFields(b),
  });
}

function indexEntries(node: ReturnType<typeof fakeNode>): BoardSummary[] | null {
  const row = node.rowAt(INDEX, BOARD_LIST_INDEX_KEY);
  if (!row) return null;
  const raw = row.fields.payload_json;
  if (typeof raw !== "string" || raw.length === 0) return [];
  return JSON.parse(raw) as BoardSummary[];
}

describe("first-run kanban list is keyed, not a schema census", () => {
  test("listBoards after init-shaped seed uses HashKey(default) when all_boards is absent", async () => {
    const node = noScanNode();
    await seedBoardRecord(node, defaultBoard());

    const boards = await listBoards(node, cfg);

    expect(boards.map((b) => b.slug)).toEqual(["default"]);
    expect(indexEntries(node)?.map((b) => b.slug)).toEqual(["default"]);
    expect(node.reads.every((r) => isKeyedFilter(r.filter))).toBe(true);
  });

  test("bare list after a seeded default board exits 0 with the empty-board hint", async () => {
    const node = noScanNode();
    await seedBoardRecord(node, defaultBoard());

    const text = await listCmd({ cfg, node, displayOnly: true });

    expect(text).toContain("No cards yet");
    expect(text).toContain("add my-first-card");
  });

  test("listResult does not issue an unfiltered query when the footer has no other boards", async () => {
    const node = noScanNode();
    await seedBoardRecord(node, defaultBoard());

    const res = await listResult({ cfg, node, displayOnly: true });

    expect(res.board.slug).toBe("default");
    expect(res.cards).toEqual([]);
    expect(node.reads.every((r) => isKeyedFilter(r.filter))).toBe(true);
  });
});

describe("init dual-writes all_boards when seeding default", () => {
  test("seedDefaultBoard creates the board and the rollup row", async () => {
    const node = noScanNode();
    const lines: string[] = [];

    const board = await seedDefaultBoard(node, cfg, (line) => lines.push(line));

    expect(board.slug).toBe("default");
    expect(node.rowAt(BOARD, "default")).toBeDefined();
    expect(indexEntries(node)?.map((b) => b.slug)).toEqual(["default"]);
    expect(indexEntries(node)?.[0]?.columns).toEqual([...DEFAULT_COLUMNS]);
    expect(lines.some((l) => l.includes('created board "default"'))).toBe(true);
  });

  test("seedDefaultBoard repairs a missing rollup when the board already exists", async () => {
    const node = noScanNode();
    await seedBoardRecord(node, { ...defaultBoard(), created_at: nowIso(), updated_at: nowIso() });

    await seedDefaultBoard(node, cfg, () => {});

    expect(indexEntries(node)?.map((b) => b.slug)).toEqual(["default"]);
    expect(await listBoards(node, cfg)).toHaveLength(1);
  });

  test("seedDefaultBoard is a no-op upsert on a already-listed default board", async () => {
    const node = noScanNode();
    const b = defaultBoard();
    await seedBoardRecord(node, b);
    await node.createRecord({
      schemaHash: INDEX,
      keyHash: BOARD_LIST_INDEX_KEY,
      fields: {
        key: BOARD_LIST_INDEX_KEY,
        payload_json: JSON.stringify([toBoardSummary(b)]),
        updated_at: nowIso(),
      },
    });

    await seedDefaultBoard(node, cfg, () => {});

    expect(indexEntries(node)?.map((b) => b.slug)).toEqual(["default"]);
  });
});
