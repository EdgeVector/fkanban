// MCP write-tool tests — drive createFkanbanMcpServer over an in-memory
// transport with a real MCP Client and assert every write tool returns
// `structuredContent` matching the underlying command's result object (the
// same shape the CLI emits under `--json`), alongside the human text block.
//
// Backed by an in-memory fake NodeClient (the NodeClient interface is plain),
// so the whole round-trip is exercised with no live node / schema service —
// the same "unit-testable without a live node" approach as the command
// formatters in unit.test.ts. Because the client validates structuredContent
// against each tool's declared outputSchema, a schema/result mismatch fails
// the test here, not just at runtime.

import { beforeEach, describe, expect, test } from "bun:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createFkanbanMcpServer } from "../src/mcp/server.ts";
import type { NodeClient, QueryResponse, QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { boardToFields, nowIso } from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash" },
};

// In-memory fake node: a (schemaHash → keyHash → fields) store. Mirrors just
// enough of fold_db_node's contract for the write commands — point reads via a
// HashKey filter, full scans without one, and create/update/delete upserts.
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
    const entries = filter ? (t.has(filter.HashKey) ? [[filter.HashKey, t.get(filter.HashKey)!] as const] : []) : [...t.entries()];
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

// Seed the default board so add/move resolve a board.
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

async function connectedClient(node: NodeClient): Promise<Client> {
  const server = createFkanbanMcpServer({ cfg, node });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

describe("MCP write tools return structuredContent", () => {
  let node: NodeClient;
  let client: Client;

  beforeEach(async () => {
    node = fakeNode();
    await seedDefaultBoard(node);
    client = await connectedClient(node);
  });

  test("fkanban_board_create echoes { slug, action }", async () => {
    const res = await client.callTool({ name: "fkanban_board_create", arguments: { slug: "sprint" } });
    expect(res.structuredContent).toEqual({ slug: "sprint", action: "created" });
    // Human text block is still present for clients that ignore structuredContent.
    expect((res.content as Array<{ type: string; text: string }>)[0]?.text).toBe("created board sprint");
  });

  test("fkanban_add echoes { slug, action, board, column }", async () => {
    const res = await client.callTool({ name: "fkanban_add", arguments: { slug: "card-a", column: "todo" } });
    expect(res.structuredContent).toEqual({ slug: "card-a", action: "created", board: "default", column: "todo" });
    expect((res.content as Array<{ type: string; text: string }>)[0]?.text).toBe("created card card-a → default/todo");

    // A second add for the same slug reports the update transition.
    const upd = await client.callTool({ name: "fkanban_add", arguments: { slug: "card-a", column: "doing" } });
    expect(upd.structuredContent).toEqual({ slug: "card-a", action: "updated", board: "default", column: "doing" });
  });

  test("fkanban_move echoes { slug, from, to }", async () => {
    await client.callTool({ name: "fkanban_add", arguments: { slug: "card-b", column: "todo" } });
    const res = await client.callTool({ name: "fkanban_move", arguments: { slug: "card-b", column: "doing" } });
    expect(res.structuredContent).toEqual({ slug: "card-b", from: "todo", to: "doing" });
    expect((res.content as Array<{ type: string; text: string }>)[0]?.text).toBe("moved card-b: todo → doing");
  });

  test("fkanban_dep_add / fkanban_dep_rm echo { slug, dep, action, deps }", async () => {
    await client.callTool({ name: "fkanban_add", arguments: { slug: "ui", column: "todo" } });
    await client.callTool({ name: "fkanban_add", arguments: { slug: "api", column: "todo" } });

    const added = await client.callTool({ name: "fkanban_dep_add", arguments: { slug: "ui", dep: "api" } });
    expect(added.structuredContent).toEqual({ slug: "ui", dep: "api", action: "added", deps: ["api"] });
    expect((added.content as Array<{ type: string; text: string }>)[0]?.text).toBe(
      "ui now depends on api (deps: api)",
    );

    const removed = await client.callTool({ name: "fkanban_dep_rm", arguments: { slug: "ui", dep: "api" } });
    expect(removed.structuredContent).toEqual({ slug: "ui", dep: "api", action: "removed", deps: [] });
    expect((removed.content as Array<{ type: string; text: string }>)[0]?.text).toBe(
      "ui no longer depends on api (deps: none)",
    );
  });

  test("fkanban_rm echoes { slug }", async () => {
    await client.callTool({ name: "fkanban_add", arguments: { slug: "card-c", column: "todo" } });
    const res = await client.callTool({ name: "fkanban_rm", arguments: { slug: "card-c" } });
    expect(res.structuredContent).toEqual({ slug: "card-c" });
    expect((res.content as Array<{ type: string; text: string }>)[0]?.text).toBe("removed card card-c");
  });

  test("each write tool advertises an outputSchema", async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of [
      "fkanban_add",
      "fkanban_move",
      "fkanban_dep_add",
      "fkanban_dep_rm",
      "fkanban_rm",
      "fkanban_board_create",
    ]) {
      expect(byName.get(name)?.outputSchema, `${name} should declare an outputSchema`).toBeDefined();
    }
  });
});
