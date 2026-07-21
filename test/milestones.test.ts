import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { NodeClient, QueryFilter, QueryResponse, QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { milestoneAddCmd, milestoneListResult, milestoneShowResult, milestoneStateCmd } from "../src/commands/milestone.ts";
import { addCmd } from "../src/commands/add.ts";
import { boardToFields, findCard, listCards, nowIso } from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";
import { createFkanbanMcpServer } from "../src/mcp/server.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash", milestone: "milestonehash" },
};

function fakeNode(): NodeClient {
  const store = new Map<string, Map<string, Record<string, unknown>>>();
  const table = (hash: string) => {
    let value = store.get(hash);
    if (!value) {
      value = new Map();
      store.set(hash, value);
    }
    return value;
  };
  const rows = (hash: string, filter?: QueryFilter): QueryRow[] => {
    const source = table(hash);
    const entries = filter?.HashKey
      ? (source.has(filter.HashKey) ? [[filter.HashKey, source.get(filter.HashKey)!] as const] : [])
      : [...source.entries()];
    return entries.map(([key, fields]) => ({ fields, key: { hash: key, range: null } }));
  };
  const notImplemented = async (): Promise<never> => { throw new Error("not implemented"); };
  return {
    baseUrl: cfg.nodeUrl,
    userHash: cfg.userHash,
    autoIdentity: notImplemented,
    bootstrap: notImplemented,
    loadSchemas: notImplemented,
    listSchemas: notImplemented,
    async createRecord({ schemaHash, keyHash, fields }) { table(schemaHash).set(keyHash, fields); },
    async updateRecord({ schemaHash, keyHash, fields }) { table(schemaHash).set(keyHash, fields); },
    async deleteRecord({ schemaHash, keyHash }) { table(schemaHash).delete(keyHash); },
    async queryAll({ schemaHash, filter }): Promise<QueryResponse> {
      const results = rows(schemaHash, filter);
      return { ok: true, results, returned_count: results.length, total_count: results.length };
    },
    rawCall: notImplemented,
    nodeTransport: () => ({ transport: "unavailable" as const }),
  };
}

async function seedBoard(node: NodeClient): Promise<void> {
  const now = nowIso();
  await node.createRecord({
    schemaHash: cfg.schemaHashes.board!,
    keyHash: "default",
    fields: boardToFields({ slug: "default", title: "Default", body: "", columns: [...DEFAULT_COLUMNS], created_at: now, updated_at: now }),
  });
}

async function milestoneMcpClient(node: NodeClient): Promise<Client> {
  const server = createFkanbanMcpServer({ cfg, node });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "milestone-test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

describe("first-class milestones", () => {
  test("create/list/show/state operate on a separate Milestone schema", async () => {
    const node = fakeNode();
    await seedBoard(node);
    const created = await milestoneAddCmd({
      cfg, node, slug: "ship-self-hosting", title: "Ship self-hosting", state: "active",
      northStar: "north-star-lastgit", driver: "program-driver",
    });
    expect(created).toEqual({ slug: "ship-self-hosting", action: "created", state: "active" });
    expect((await milestoneListResult({ cfg, node })).milestones.map((m) => m.slug)).toEqual(["ship-self-hosting"]);
    expect((await milestoneShowResult({ cfg, node, slug: "ship-self-hosting" })).milestone.driver).toBe("program-driver");
    expect(await milestoneStateCmd({ cfg, node, slug: "ship-self-hosting", state: "proving" })).toEqual({
      slug: "ship-self-hosting", from: "active", to: "proving",
    });
    // Milestones do not share the Card schema and therefore cannot enter pickup.
    expect(await listCards(node, cfg)).toEqual([]);
  });

  test("cards link to a live milestone and reject board/North-Star drift", async () => {
    const node = fakeNode();
    await seedBoard(node);
    await milestoneAddCmd({
      cfg, node, slug: "outcome-a", title: "Outcome A", state: "active", northStar: "north-star-a",
    });
    await addCmd({
      cfg, node, slug: "slice-a", title: "Slice A", milestone: "outcome-a", northStar: "north-star-a",
      repo: "EdgeVector/fkanban", base: "main", kind: "pr", column: "backlog",
    });
    expect((await findCard(node, cfg, "slice-a"))?.milestone).toBe("outcome-a");
    await expect(addCmd({
      cfg, node, slug: "slice-b", milestone: "outcome-a", northStar: "north-star-b",
      repo: "EdgeVector/fkanban", base: "main", kind: "pr", column: "backlog",
    })).rejects.toMatchObject({ code: "milestone_north_star_mismatch" });
    await expect(addCmd({
      cfg, node, slug: "slice-c", milestone: "missing-outcome",
      repo: "EdgeVector/fkanban", base: "main", kind: "pr", column: "backlog",
    })).rejects.toMatchObject({ code: "milestone_not_found" });
  });

  test("MCP exposes create/list/show/state with schema-validated structured results", async () => {
    const node = fakeNode();
    await seedBoard(node);
    const client = await milestoneMcpClient(node);
    const created = await client.callTool({ name: "fkanban_milestone_add", arguments: {
      slug: "mcp-outcome", title: "MCP outcome", state: "active", driver: "program-driver",
    } });
    expect(created.isError).not.toBe(true);
    expect(created.structuredContent).toEqual({ slug: "mcp-outcome", action: "created", state: "active" });
    const listed = await client.callTool({ name: "fkanban_milestone_list", arguments: {} });
    expect((listed.structuredContent as { milestones: Array<{ slug: string }> }).milestones[0]?.slug).toBe("mcp-outcome");
    const shown = await client.callTool({ name: "fkanban_milestone_show", arguments: { slug: "mcp-outcome" } });
    expect((shown.structuredContent as { milestone: { driver: string } }).milestone.driver).toBe("program-driver");
    const moved = await client.callTool({ name: "fkanban_milestone_state", arguments: { slug: "mcp-outcome", state: "proving" } });
    expect(moved.structuredContent).toEqual({ slug: "mcp-outcome", from: "active", to: "proving" });
  });
});
