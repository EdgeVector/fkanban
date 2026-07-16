// The dependency soft-block must actually enforce on a custom-columns board:
// a card blocked by an undone dep can't be moved/placed into its board's
// TERMINAL (completion) column without --force. Before #87 the enforcement gate
// was the hardcoded WORKING_COLUMNS (doing/done), so a board whose
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
    { slug: "zz", title: "Z", body: "", columns: [...DEFAULT_COLUMNS], created_at: "", updated_at: "" },
    { slug: "default", title: "D", body: "", columns: [...DEFAULT_COLUMNS], created_at: "", updated_at: "" },
  ]);

  test("default board: gated set is working columns + pickup todo (backlog is not)", () => {
    // Tom 2026-07-14: default/todo is the pickup claim lane — unfinished deps
    // are refused there so cards don't look "ready" while blocked.
    expect(isDepEnforcedColumn("backlog", "default", terminal)).toBe(false);
    expect(isDepEnforcedColumn("todo", "default", terminal)).toBe(true);
    expect(isDepEnforcedColumn("doing", "default", terminal)).toBe(true);
    expect(isDepEnforcedColumn("review", "default", terminal)).toBe(false);
    expect(isDepEnforcedColumn("done", "default", terminal)).toBe(true);
  });

  test("non-default board: working columns + terminal are gated (todo is default-only)", () => {
    // Fixed columns everywhere; todo pickup gate is default-board only.
    expect(isDepEnforcedColumn("backlog", "zz", terminal)).toBe(false);
    expect(isDepEnforcedColumn("todo", "zz", terminal)).toBe(false);
    expect(isDepEnforcedColumn("doing", "zz", terminal)).toBe(true);
    expect(isDepEnforcedColumn("done", "zz", terminal)).toBe(true);
  });

  test("unresolvable board falls back to literal `done` as the terminal gate", () => {
    const empty = new Map<string, string>();
    expect(isDepEnforcedColumn("ship", "gone", empty)).toBe(false); // unknown name not working
    expect(isDepEnforcedColumn("done", "gone", empty)).toBe(true);
  });
});

describe("move: blocked card can't reach done on a non-default board", () => {
  let node: NodeClient;

  beforeEach(async () => {
    node = fakeNode();
    await seedBoard(node, "zz", [...DEFAULT_COLUMNS]);
  });

  test("move into `done` is refused while the dep is unfinished, voiced + no write", async () => {
    await addCmd({ cfg, node, slug: "c1", board: "zz", column: "todo" });
    await addCmd({ cfg, node, slug: "c2", board: "zz", column: "todo", deps: ["c1"] });

    // Place c2 in doing (allowed on non-default while blocked? doing is working → blocked)
    await expect(moveCmd({ cfg, node, slug: "c2", column: "doing" })).rejects.toMatchObject({
      code: "card_blocked",
    });
    await expect(moveCmd({ cfg, node, slug: "c2", column: "done" })).rejects.toMatchObject({
      code: "card_blocked",
    });
    expect((await findCard(node, cfg, "c2"))?.column).toBe("todo");
  });

  test("--force overrides the terminal-column block", async () => {
    await addCmd({ cfg, node, slug: "c1", board: "zz", column: "todo" });
    await addCmd({ cfg, node, slug: "c2", board: "zz", column: "todo", deps: ["c1"] });
    const res = await moveCmd({ cfg, node, slug: "c2", column: "done", force: true });
    expect(res).toMatchObject({ to: "done" });
    expect((await findCard(node, cfg, "c2"))?.column).toBe("done");
  });

  test("once the dep reaches the terminal column, the move succeeds", async () => {
    await addCmd({ cfg, node, slug: "c1", board: "zz", column: "todo" });
    await addCmd({ cfg, node, slug: "c2", board: "zz", column: "todo", deps: ["c1"] });
    await moveCmd({ cfg, node, slug: "c1", column: "done" });
    const res = await moveCmd({ cfg, node, slug: "c2", column: "done" });
    expect(res).toMatchObject({ to: "done" });
    expect((await findCard(node, cfg, "c2"))?.column).toBe("done");
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
