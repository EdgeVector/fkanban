// The dependency soft-block must actually enforce on a custom-columns board:
// a card blocked by an undone dep can't be moved/placed into its board's
// TERMINAL (completion) column without --force. Before #87 the enforcement gate
// was the hardcoded WORKING_COLUMNS (doing/review/done), so a board whose
// columns are e.g. `spec,build,ship` had NO enforced column — a blocked card
// could be moved all the way into `ship`, defeating `--deps` on custom boards.
// PR #84 had already generalized dep DONE-ness to the board's terminal column;
// this exercises that the ENFORCEMENT path now consults it too.
//
// Backed by the same in-memory fake NodeClient used in add-update-board.test.ts
// — exercises the real addCmd/moveCmd with no live node.

import { beforeEach, describe, expect, test } from "bun:test";

import { FkanbanError } from "../src/client.ts";
import type { NodeClient, QueryFilter, QueryResponse, QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { boardToFields, findCard, isDepEnforcedColumn, boardTerminalMap, nowIso } from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";
import { addCmd } from "../src/commands/add.ts";
import { moveCmd } from "../src/commands/move.ts";

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

function seedBoard(node: NodeClient, slug: string, columns: string[]) {
  const now = nowIso();
  return node.createRecord({
    schemaHash: cfg.schemaHashes.board!,
    keyHash: slug,
    fields: boardToFields({
      slug,
      title: slug,
      body: "",
      columns,
      created_at: now,
      updated_at: now,
    }),
  });
}

describe("isDepEnforcedColumn", () => {
  const terminal = boardTerminalMap([
    { slug: "zz", title: "Z", body: "", columns: ["spec", "build", "ship"], created_at: "", updated_at: "" },
    { slug: "default", title: "D", body: "", columns: [...DEFAULT_COLUMNS], created_at: "", updated_at: "" },
  ]);

  test("default board: gated set includes the pickup lane plus working columns", () => {
    expect(isDepEnforcedColumn("backlog", "default", terminal)).toBe(false);
    expect(isDepEnforcedColumn("todo", "default", terminal)).toBe(true);
    expect(isDepEnforcedColumn("doing", "default", terminal)).toBe(true);
    expect(isDepEnforcedColumn("review", "default", terminal)).toBe(true);
    expect(isDepEnforcedColumn("done", "default", terminal)).toBe(true);
  });

  test("custom board: the board's terminal column is gated, intermediate ones are not", () => {
    expect(isDepEnforcedColumn("spec", "zz", terminal)).toBe(false);
    expect(isDepEnforcedColumn("build", "zz", terminal)).toBe(false); // out of scope: intermediate
    expect(isDepEnforcedColumn("ship", "zz", terminal)).toBe(true); // terminal/completion column
  });

  test("unresolvable board falls back to literal `done` as the terminal gate", () => {
    const empty = new Map<string, string>();
    expect(isDepEnforcedColumn("ship", "gone", empty)).toBe(false);
    expect(isDepEnforcedColumn("done", "gone", empty)).toBe(true);
  });
});

describe("move: blocked card can't reach a custom board's terminal column", () => {
  let node: NodeClient;

  beforeEach(async () => {
    node = fakeNode();
    await seedBoard(node, "zz", ["spec", "build", "ship"]);
  });

  test("move into `ship` is refused while the dep is unfinished, voiced + no write", async () => {
    await addCmd({ cfg, node, slug: "c1", board: "zz", column: "spec" });
    await addCmd({ cfg, node, slug: "c2", board: "zz", column: "spec", deps: ["c1"] });

    const promise = moveCmd({ cfg, node, slug: "c2", column: "ship" });
    await expect(promise).rejects.toMatchObject({ code: "card_blocked" });
    try {
      await moveCmd({ cfg, node, slug: "c2", column: "ship" });
    } catch (err) {
      const e = err as FkanbanError;
      expect(e.message).toBe('Card "c2" is blocked by "c1" (not yet done).');
      // Hint no longer hardcodes the literal word `done`.
      expect(e.hint).toContain("board's final column");
    }
    // No write: c2 is still in `spec`.
    expect((await findCard(node, cfg, "c2"))?.column).toBe("spec");
  });

  test("--force overrides the terminal-column block", async () => {
    await addCmd({ cfg, node, slug: "c1", board: "zz", column: "spec" });
    await addCmd({ cfg, node, slug: "c2", board: "zz", column: "spec", deps: ["c1"] });
    const res = await moveCmd({ cfg, node, slug: "c2", column: "ship", force: true });
    expect(res).toMatchObject({ to: "ship" });
    expect((await findCard(node, cfg, "c2"))?.column).toBe("ship");
  });

  test("once the dep reaches the terminal column, the move succeeds", async () => {
    await addCmd({ cfg, node, slug: "c1", board: "zz", column: "spec" });
    await addCmd({ cfg, node, slug: "c2", board: "zz", column: "spec", deps: ["c1"] });
    await moveCmd({ cfg, node, slug: "c1", column: "ship" }); // dep now done (terminal)
    const res = await moveCmd({ cfg, node, slug: "c2", column: "ship" });
    expect(res).toMatchObject({ to: "ship" });
    expect((await findCard(node, cfg, "c2"))?.column).toBe("ship");
  });
});

describe("default board: enforcement unchanged", () => {
  let node: NodeClient;

  beforeEach(async () => {
    node = fakeNode();
    await seedBoard(node, "default", [...DEFAULT_COLUMNS]);
  });

  test("blocked card still refused into `doing`", async () => {
    await addCmd({ cfg, node, slug: "d1", title: "D1" });
    await addCmd({ cfg, node, slug: "d2", title: "D2", deps: ["d1"] });
    await expect(moveCmd({ cfg, node, slug: "d2", column: "doing" })).rejects.toMatchObject({
      code: "card_blocked",
    });
  });

  test("unblocked card moves freely into `doing`", async () => {
    await addCmd({ cfg, node, slug: "d1", title: "D1", column: "done" });
    await addCmd({ cfg, node, slug: "d2", title: "D2", deps: ["d1"] });
    const res = await moveCmd({ cfg, node, slug: "d2", column: "doing" });
    expect(res).toMatchObject({ to: "doing" });
  });
});
