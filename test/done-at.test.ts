// `done_at` is lifecycle history, not last-edit history: stamp it once when a
// card first enters its board's terminal column, then preserve it across later
// grooming/tag/body updates.

import { beforeEach, describe, expect, test } from "bun:test";

import type { NodeClient, QueryFilter, QueryResponse, QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { addCmd } from "../src/commands/add.ts";
import { moveCmd } from "../src/commands/move.ts";
import { tagAddCmd } from "../src/commands/tag.ts";
import {
  boardToFields,
  doneAtForColumnTransition,
  findCard,
  nowIso,
} from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";

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
    nodeTransport: () => ({ transport: "tcp" as const }),
  };
}

function seedBoard(node: NodeClient, slug = "default", columns: string[] = [...DEFAULT_COLUMNS]) {
  const now = nowIso();
  return node.createRecord({
    schemaHash: cfg.schemaHashes.board!,
    keyHash: slug,
    fields: boardToFields({ slug, title: slug, body: "", columns, created_at: now, updated_at: now }),
  });
}

describe("done_at stamping", () => {
  let node: NodeClient;

  beforeEach(async () => {
    node = fakeNode();
    await seedBoard(node);
  });

  test("pure transition helper stamps only first entry to the terminal column", () => {
    const now = "2026-07-03T12:00:00.000Z";
    expect(doneAtForColumnTransition(null, "done", [...DEFAULT_COLUMNS], now)).toBe(now);
    expect(doneAtForColumnTransition({ column: "todo", done_at: "" }, "done", [...DEFAULT_COLUMNS], now)).toBe(now);
    expect(doneAtForColumnTransition({ column: "done", done_at: "" }, "done", [...DEFAULT_COLUMNS], now)).toBe("");
    expect(
      doneAtForColumnTransition({ column: "done", done_at: "2026-07-02T00:00:00.000Z" }, "todo", [...DEFAULT_COLUMNS], now),
    ).toBe("2026-07-02T00:00:00.000Z");
  });

  test("move to done stamps done_at and tag/body updates keep it stable", async () => {
    await addCmd({ cfg, node, slug: "probe", title: "Probe", column: "todo" });
    expect((await findCard(node, cfg, "probe"))?.done_at).toBe("");

    await moveCmd({ cfg, node, slug: "probe", column: "done" });
    const stamped = (await findCard(node, cfg, "probe"))?.done_at;
    expect(stamped).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    await tagAddCmd({ cfg, node, slug: "probe", tag: ["sweep-tag"] });
    expect((await findCard(node, cfg, "probe"))?.done_at).toBe(stamped);

    await addCmd({ cfg, node, slug: "probe", body: "updated body" });
    expect((await findCard(node, cfg, "probe"))?.done_at).toBe(stamped);
  });

  test("create directly in the terminal column stamps done_at", async () => {
    await addCmd({ cfg, node, slug: "already-done", column: "done" });
    expect((await findCard(node, cfg, "already-done"))?.done_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("custom-board terminal column is used", async () => {
    await seedBoard(node, "custom", ["spec", "build", "ship"]);
    await addCmd({ cfg, node, slug: "custom-card", board: "custom", column: "spec" });
    await moveCmd({ cfg, node, slug: "custom-card", column: "ship" });
    expect((await findCard(node, cfg, "custom-card"))?.done_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
