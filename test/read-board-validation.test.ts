// `list` / `search` must validate an explicitly-passed `--board` the same way
// `add` does: a typo'd board name should throw the canonical `board_not_found`
// FkanbanError (message + hint, exits non-zero via the top-level handler), not
// silently render an empty board / "No cards match". The no-`--board` paths
// (default board / cross-board search) must stay unchanged.
//
// Backed by the same in-memory fake NodeClient used in mcp.test.ts — exercises
// the real command functions with no live node / schema service.

import { beforeEach, describe, expect, test } from "bun:test";

import { FkanbanError } from "../src/client.ts";
import type { NodeClient, QueryResponse, QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { boardToFields, nowIso } from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";
import { addCmd } from "../src/commands/add.ts";
import { listCmd } from "../src/commands/list.ts";
import { searchCmd } from "../src/commands/search.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash" },
};

function fakeNode(): NodeClient {
  const store = new Map<string, Map<string, Record<string, unknown>>>();
  const tableFor = (schemaHash: string) => {
    let t = store.get(schemaHash);
    if (!t) {
      t = new Map();
      store.set(schemaHash, t);
    }
    return t;
  };
  const rowsFor = (schemaHash: string, filter?: { HashKey: string }): QueryRow[] => {
    const t = tableFor(schemaHash);
    const entries = filter
      ? t.has(filter.HashKey)
        ? [[filter.HashKey, t.get(filter.HashKey)!] as const]
        : []
      : [...t.entries()];
    return entries.map(([hash, fields]) => ({ fields, key: { hash, range: null } }));
  };
  const notImpl = (m: string) => async (): Promise<never> => {
    throw new Error(`fakeNode.${m} not implemented`);
  };
  return {
    baseUrl: cfg.nodeUrl,
    userHash: cfg.userHash,
    autoIdentity: notImpl("autoIdentity"),
    bootstrap: notImpl("bootstrap"),
    loadSchemas: notImpl("loadSchemas"),
    listSchemas: notImpl("listSchemas"),
    async createRecord({ schemaHash, fields, keyHash }) {
      tableFor(schemaHash).set(keyHash, fields);
    },
    async updateRecord({ schemaHash, fields, keyHash }) {
      tableFor(schemaHash).set(keyHash, fields);
    },
    async deleteRecord({ schemaHash, keyHash }) {
      tableFor(schemaHash).delete(keyHash);
    },
    async queryAll({ schemaHash, filter }): Promise<QueryResponse> {
      const results = rowsFor(schemaHash, filter);
      return { ok: true, results, returned_count: results.length, total_count: results.length };
    },
    rawCall: notImpl("rawCall") as NodeClient["rawCall"],
  };
}

function seedDefaultBoard(node: NodeClient) {
  const now = nowIso();
  return node.createRecord({
    schemaHash: cfg.schemaHashes.board!,
    keyHash: "default",
    fields: boardToFields({
      slug: "default",
      title: "Default",
      body: "",
      columns: [...DEFAULT_COLUMNS],
      created_at: now,
      updated_at: now,
    }),
  });
}

// The canonical error `add` raises for a missing board, so the read-command
// assertions can demand byte-identical message + hint + code.
function expectedBoardNotFound(slug: string): FkanbanError {
  return new FkanbanError({
    code: "board_not_found",
    message: `Board "${slug}" does not exist.`,
    hint: `Create it first: \`fkanban board create ${slug}\` (or use the default board).`,
  });
}

describe("list/search validate an explicit --board", () => {
  let node: NodeClient;

  beforeEach(async () => {
    node = fakeNode();
    await seedDefaultBoard(node);
    await addCmd({ cfg, node, slug: "card-a", title: "Card A", column: "todo" });
  });

  test("list --board <bogus> throws board_not_found (message + hint)", async () => {
    const ref = expectedBoardNotFound("ghost");
    expect(listCmd({ cfg, node, board: "ghost" })).rejects.toMatchObject({
      code: "board_not_found",
      message: ref.message,
      hint: ref.hint,
    });
  });

  test("search q --board <bogus> throws board_not_found (message + hint)", async () => {
    const ref = expectedBoardNotFound("ghost");
    expect(searchCmd({ cfg, node, query: "card", board: "ghost" })).rejects.toMatchObject({
      code: "board_not_found",
      message: ref.message,
      hint: ref.hint,
    });
  });

  test("list --board <bogus> is a FkanbanError (non-zero exit via top-level handler)", async () => {
    expect(listCmd({ cfg, node, board: "ghost" })).rejects.toBeInstanceOf(FkanbanError);
  });

  test("search --board <bogus> is a FkanbanError (non-zero exit via top-level handler)", async () => {
    expect(searchCmd({ cfg, node, query: "card", board: "ghost" })).rejects.toBeInstanceOf(FkanbanError);
  });

  test("list with no --board still succeeds (default board)", async () => {
    const out = await listCmd({ cfg, node });
    expect(out).toContain("card-a");
  });

  test("list --board default still succeeds unchanged", async () => {
    const out = await listCmd({ cfg, node, board: "default" });
    expect(out).toContain("card-a");
  });

  test("search with no --board still succeeds (spans all boards)", async () => {
    const out = await searchCmd({ cfg, node, query: "card" });
    expect(out).toContain("card-a");
  });

  test("search --board default still succeeds unchanged", async () => {
    const out = await searchCmd({ cfg, node, query: "card", board: "default" });
    expect(out).toContain("card-a");
  });
});

// `list --column <col>` must validate the column the same way `move`/`add` do
// (the shared `ensureColumn`): a typo'd column should throw the canonical
// `invalid_column` FkanbanError (message + hint, non-zero exit), not silently
// filter every card out and render an empty board on either the text or
// `--json` path. The no-`--column` path must stay unchanged.
describe("list validates an explicit --column", () => {
  let node: NodeClient;

  beforeEach(async () => {
    node = fakeNode();
    await seedDefaultBoard(node);
    await addCmd({ cfg, node, slug: "card-a", title: "Card A", column: "todo" });
  });

  test("list --column <bogus> throws invalid_column (message + hint)", async () => {
    expect(listCmd({ cfg, node, column: "notacolumn" })).rejects.toMatchObject({
      code: "invalid_column",
      message: `"notacolumn" is not a column on this board.`,
      hint: `Valid columns: ${[...DEFAULT_COLUMNS].join(" | ")}`,
    });
  });

  test("list --column <bogus> is a FkanbanError (non-zero exit via top-level handler)", async () => {
    expect(listCmd({ cfg, node, column: "notacolumn" })).rejects.toBeInstanceOf(FkanbanError);
  });

  test("list --column <bogus> --json also throws (no `[]` render)", async () => {
    expect(listCmd({ cfg, node, column: "notacolumn", json: true })).rejects.toBeInstanceOf(FkanbanError);
  });

  test("list --column <valid> still succeeds", async () => {
    const out = await listCmd({ cfg, node, column: "todo" });
    expect(out).toContain("card-a");
  });

  test("list --column <valid> --json returns the filtered cards", async () => {
    const out = await listCmd({ cfg, node, column: "todo", json: true });
    expect(JSON.parse(out)).toHaveLength(1);
  });

  test("list with no --column still succeeds (unchanged hot path)", async () => {
    const out = await listCmd({ cfg, node });
    expect(out).toContain("card-a");
  });
});

// `search --column <col>` must validate the column the same way `list --column`
// does (the shared `ensureColumn`): a typo'd column should throw the canonical
// `invalid_column` FkanbanError (message + hint, non-zero exit) — inherited by
// the MCP `fkanban_search` tool via `searchResult` — not silently filter every
// card out and report "No cards match". With `--board` the custom board's
// columns are honored; without it, the canonical `DEFAULT_COLUMNS`. The
// no-`--column` path must stay unchanged.
describe("search validates an explicit --column", () => {
  let node: NodeClient;

  beforeEach(async () => {
    node = fakeNode();
    await seedDefaultBoard(node);
    await addCmd({ cfg, node, slug: "card-a", title: "Card A", column: "todo" });
  });

  test("search --column <bogus> throws invalid_column (message + hint)", async () => {
    expect(searchCmd({ cfg, node, query: "card", column: "notacolumn" })).rejects.toMatchObject({
      code: "invalid_column",
      message: `"notacolumn" is not a column on this board.`,
      hint: `Valid columns: ${[...DEFAULT_COLUMNS].join(" | ")}`,
    });
  });

  test("search --column <bogus> is a FkanbanError (non-zero exit via top-level handler)", async () => {
    expect(searchCmd({ cfg, node, query: "card", column: "notacolumn" })).rejects.toBeInstanceOf(FkanbanError);
  });

  test("search --column <bogus> --json also throws (no `[]` render)", async () => {
    expect(searchCmd({ cfg, node, query: "card", column: "notacolumn", json: true })).rejects.toBeInstanceOf(
      FkanbanError,
    );
  });

  test("search --board <existing> --column <bogus> throws invalid_column", async () => {
    expect(searchCmd({ cfg, node, query: "card", board: "default", column: "notacolumn" })).rejects.toMatchObject({
      code: "invalid_column",
    });
  });

  test("search --column <valid> still succeeds", async () => {
    const out = await searchCmd({ cfg, node, query: "card", column: "todo" });
    expect(out).toContain("card-a");
  });

  test("search --column <valid> --json returns the filtered cards", async () => {
    const out = await searchCmd({ cfg, node, query: "card", column: "todo", json: true });
    expect(JSON.parse(out)).toHaveLength(1);
  });

  test("search with no --column still succeeds (unchanged hot path)", async () => {
    const out = await searchCmd({ cfg, node, query: "card" });
    expect(out).toContain("card-a");
  });
});
