// `board create --columns` must reject a list containing DUPLICATE names,
// exactly like the rest of fkanban's validate-loudly contract (slugs,
// `--column` typos, dep cycles). A duplicate would otherwise be stored verbatim
// and silently corrupt the board: `list` renders the doubled column (and every
// card in it) TWICE, with a doubled count. The guard lives in `boardCreateCmd`,
// throws `dup_columns` BEFORE any createRecord/updateRecord (no partial write),
// and only fires when `--columns` was explicitly supplied — the trim/filter
// done by parseTags upstream (whitespace padding, empty segments, all-empty →
// default columns) stays graceful and untouched.
//
// Backed by the same in-memory fake NodeClient used in add-update-board.test.ts.

import { beforeEach, describe, expect, test } from "bun:test";

import { FkanbanError } from "../src/client.ts";
import type { NodeClient, QueryFilter, QueryResponse, QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { listBoards } from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";
import { boardCreateCmd } from "../src/commands/board.ts";

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
  const rowsFor = (schemaHash: string, filter?: QueryFilter): QueryRow[] => {
    const t = tableFor(schemaHash);
    const entries = filter?.HashKey
      ? (t.has(filter.HashKey) ? [[filter.HashKey, t.get(filter.HashKey)!] as const] : [])
      : [...t.entries()].filter(([, fields]) =>
          !filter || Object.entries(filter).every(([field, value]) => fields[field] === value)
        );
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
    nodeTransport: () => ({ transport: "unavailable" as const }),
  };
}

describe("board create rejects duplicate column names", () => {
  let node: NodeClient;

  beforeEach(() => {
    node = fakeNode();
  });

  test("a duplicate name is rejected and NOTHING is written", async () => {
    await expect(
      boardCreateCmd({ cfg, node, slug: "dup", columns: ["todo", "todo", "done"] }),
    ).rejects.toMatchObject({ code: "dup_columns" });
    // No partial write: the board never landed.
    const boards = await listBoards(node, cfg);
    expect(boards.find((b) => b.slug === "dup")).toBeUndefined();
  });

  test("error message + hint name the offending column", async () => {
    try {
      await boardCreateCmd({ cfg, node, slug: "dup", columns: ["todo", "todo", "done"] });
      throw new Error("expected boardCreateCmd to throw dup_columns");
    } catch (err) {
      expect(err).toBeInstanceOf(FkanbanError);
      const e = err as FkanbanError;
      expect(e.code).toBe("dup_columns");
      expect(e.message).toBe('Duplicate column name "todo" in --columns.');
      expect(e.hint).toBe('Column names must be unique: "todo".');
    }
  });

  test("multiple distinct duplicates are all listed in the hint", async () => {
    try {
      await boardCreateCmd({ cfg, node, slug: "dup", columns: ["a", "a", "b", "b", "c"] });
      throw new Error("expected boardCreateCmd to throw dup_columns");
    } catch (err) {
      const e = err as FkanbanError;
      expect(e.code).toBe("dup_columns");
      expect(e.message).toBe('Duplicate column name "a" in --columns.');
      expect(e.hint).toBe('Column names must be unique: "a", "b".');
    }
  });

  test("duplicates are case-sensitive (exact strings) — Todo vs todo is fine", async () => {
    const res = await boardCreateCmd({ cfg, node, slug: "mixed", columns: ["Todo", "todo", "Done"] });
    expect(res).toMatchObject({ action: "created", slug: "mixed" });
    const boards = await listBoards(node, cfg);
    expect(boards.find((b) => b.slug === "mixed")?.columns).toEqual(["Todo", "todo", "Done"]);
  });

  // --- the currently-graceful behaviors must stay intact (parseTags handles
  // trim/filter upstream; these arrive as the already-cleaned list) ---

  test("a unique explicit list still succeeds", async () => {
    const res = await boardCreateCmd({
      cfg,
      node,
      slug: "ok",
      columns: ["backlog", "todo", "doing", "done"],
    });
    expect(res).toMatchObject({ action: "created", slug: "ok" });
    const boards = await listBoards(node, cfg);
    expect(boards.find((b) => b.slug === "ok")?.columns).toEqual([
      "backlog",
      "todo",
      "doing",
      "done",
    ]);
  });

  test('"a,,b" (empty segment dropped by parseTags) → ["a","b"], accepted', async () => {
    // parseTags turns "a,,b" into ["a","b"] before boardCreateCmd sees it.
    const res = await boardCreateCmd({ cfg, node, slug: "gappy", columns: ["a", "b"] });
    expect(res).toMatchObject({ action: "created" });
    const boards = await listBoards(node, cfg);
    expect(boards.find((b) => b.slug === "gappy")?.columns).toEqual(["a", "b"]);
  });

  test("no columns supplied → default columns, no dup check", async () => {
    const res = await boardCreateCmd({ cfg, node, slug: "defaulted" });
    expect(res).toMatchObject({ action: "created" });
    const boards = await listBoards(node, cfg);
    expect(boards.find((b) => b.slug === "defaulted")?.columns).toEqual([...DEFAULT_COLUMNS]);
  });

  test("an empty column list → default columns, no dup check", async () => {
    // parseTags("") → [] → boardCreateCmd falls back to DEFAULT_COLUMNS.
    const res = await boardCreateCmd({ cfg, node, slug: "empty", columns: [] });
    expect(res).toMatchObject({ action: "created" });
    const boards = await listBoards(node, cfg);
    expect(boards.find((b) => b.slug === "empty")?.columns).toEqual([...DEFAULT_COLUMNS]);
  });

  test("an empty column list on update preserves an existing custom layout", async () => {
    await boardCreateCmd({ cfg, node, slug: "custom", columns: ["alpha", "beta", "ship"] });
    const res = await boardCreateCmd({ cfg, node, slug: "custom", columns: [] });
    expect(res).toMatchObject({ action: "updated", slug: "custom" });
    const boards = await listBoards(node, cfg);
    expect(boards.find((b) => b.slug === "custom")?.columns).toEqual(["alpha", "beta", "ship"]);
  });

  test("a non-empty column list on update still replaces columns", async () => {
    await boardCreateCmd({ cfg, node, slug: "custom", columns: ["alpha", "beta", "ship"] });
    const res = await boardCreateCmd({ cfg, node, slug: "custom", columns: ["triage", "done"] });
    expect(res).toMatchObject({ action: "updated", slug: "custom" });
    const boards = await listBoards(node, cfg);
    expect(boards.find((b) => b.slug === "custom")?.columns).toEqual(["triage", "done"]);
  });
});
