import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { NodeClient, QueryFilter, QueryResponse, QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { milestoneAddCmd, milestoneListResult, milestoneReconcileResult, milestoneShowResult, milestoneStateCmd } from "../src/commands/milestone.ts";
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
    await expect(milestoneStateCmd({ cfg, node, slug: "ship-self-hosting", state: "proving" }))
      .rejects.toMatchObject({ code: "milestone_proof_card_required" });
    await addCmd({ cfg, node, slug: "ship-proof", title: "Ship proof", milestone: "ship-self-hosting", kind: "validation", column: "backlog" });
    await milestoneAddCmd({ cfg, node, slug: "ship-self-hosting", proofCard: "ship-proof" });
    expect(await milestoneStateCmd({ cfg, node, slug: "ship-self-hosting", state: "proving" })).toEqual({
      slug: "ship-self-hosting", from: "active", to: "proving", proof_status: "pending",
    });
    // Milestones do not share the Card schema and therefore cannot enter pickup.
    expect((await listCards(node, cfg)).map((card) => card.slug)).toEqual(["ship-proof"]);
  });

  test("completion requires terminal machine-readable passing proof and failed proof fixes forward", async () => {
    const node = fakeNode();
    await seedBoard(node);
    await milestoneAddCmd({ cfg, node, slug: "outcome-proof", title: "Proven outcome", state: "active", driver: "driver" });
    await addCmd({ cfg, node, slug: "outcome-proof-card", title: "Terminal proof", body: "DONE-WHEN: file /tmp/proof matches /^PASS/", milestone: "outcome-proof", kind: "validation", column: "done" });
    await milestoneAddCmd({ cfg, node, slug: "outcome-proof", proofCard: "outcome-proof-card" });
    await milestoneStateCmd({ cfg, node, slug: "outcome-proof", state: "proving" });
    await expect(milestoneStateCmd({ cfg, node, slug: "outcome-proof", state: "complete" }))
      .rejects.toMatchObject({ code: "milestone_proof_not_passing" });
    await milestoneAddCmd({ cfg, node, slug: "outcome-proof", proofStatus: "passing" });
    await expect(milestoneStateCmd({ cfg, node, slug: "outcome-proof", state: "complete" }))
      .rejects.toMatchObject({ code: "milestone_proof_not_passing" });
    await addCmd({ cfg, node, slug: "outcome-proof-card", body: "DONE-WHEN: file /tmp/proof matches /^PASS/\nPROOF: PASS", milestone: "outcome-proof", kind: "validation", column: "done" });
    expect(await milestoneStateCmd({ cfg, node, slug: "outcome-proof", state: "complete" })).toMatchObject({ to: "complete", proof_status: "passing" });
    expect((await milestoneShowResult({ cfg, node, slug: "outcome-proof" })).milestone.completed_at).not.toBe("");

    expect(await milestoneStateCmd({ cfg, node, slug: "outcome-proof", state: "active", proofStatus: "failing" })).toMatchObject({
      from: "complete", to: "active", proof_status: "failing",
    });
  });

  test("reconcile exposes the ready child frontier and proof warnings", async () => {
    const node = fakeNode();
    await seedBoard(node);
    await milestoneAddCmd({ cfg, node, slug: "outcome-reconcile", title: "Reconcile me", state: "active" });
    await addCmd({ cfg, node, slug: "ready-slice", title: "Ready slice", milestone: "outcome-reconcile", repo: "EdgeVector/fkanban", base: "main", kind: "pr", column: "todo" });
    await addCmd({ cfg, node, slug: "parked-slice", title: "Parked slice", milestone: "outcome-reconcile", kind: "pr", column: "backlog" });
    const result = await milestoneReconcileResult({ cfg, node, slug: "outcome-reconcile" });
    expect(result.ready.map((card) => card.slug)).toEqual(["ready-slice"]);
    expect(result.warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining(["no-driver", "no-proof-card"]));
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
    await addCmd({ cfg, node, slug: "mcp-proof", title: "MCP proof", milestone: "mcp-outcome", kind: "validation", column: "backlog" });
    await milestoneAddCmd({ cfg, node, slug: "mcp-outcome", proofCard: "mcp-proof" });
    const moved = await client.callTool({ name: "fkanban_milestone_state", arguments: { slug: "mcp-outcome", state: "proving" } });
    expect(moved.structuredContent).toEqual({ slug: "mcp-outcome", from: "active", to: "proving", proof_status: "pending" });
    const reconciled = await client.callTool({ name: "fkanban_milestone_reconcile", arguments: { slug: "mcp-outcome" } });
    expect(reconciled.isError).not.toBe(true);
    expect((reconciled.structuredContent as { proof: { slug: string } }).proof.slug).toBe("mcp-proof");
  });
});
