import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { NodeClient, QueryFilter, QueryResponse, QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { classifyMilestoneGap, milestoneAddCmd, milestoneDetailResult, milestoneGapReportResult, milestoneGroomResult, milestoneListResult, milestonePortfolioResult, milestoneReconcileResult, milestoneShowResult, milestoneStateCmd } from "../src/commands/milestone.ts";
import { addCmd } from "../src/commands/add.ts";
import { listCmd } from "../src/commands/list.ts";
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
      northStar: "north-star-lastgit", driver: "last-stack-milestone-driver",
    });
    expect(created).toEqual({ slug: "ship-self-hosting", action: "created", state: "active" });
    expect((await milestoneListResult({ cfg, node })).milestones.map((m) => m.slug)).toEqual(["ship-self-hosting"]);
    expect((await milestoneShowResult({ cfg, node, slug: "ship-self-hosting" })).milestone.driver).toBe("last-stack-milestone-driver");
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

  test("DONE-WHEN file PASS/PASS-OFFLINE counts as terminal proof evidence", async () => {
    const { hasPassingProofEvidence } = await import("../src/commands/milestone.ts");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fkanban-proof-"));
    const passFile = path.join(dir, "ns.md");
    const failFile = path.join(dir, "fail.md");
    fs.writeFileSync(passFile, "PASS-OFFLINE\n\n# North Star proof\n");
    fs.writeFileSync(failFile, "FAIL\nnot good\n");
    const bodyPass = `DONE-WHEN: file ${passFile} matches /^PASS/`;
    const bodyFail = `DONE-WHEN: file ${failFile} matches /^PASS/`;
    const bodyMissing = "DONE-WHEN: file /tmp/does-not-exist-fkanban-proof.md matches /^PASS/";
    expect(hasPassingProofEvidence(bodyPass)).toBe(true);
    expect(hasPassingProofEvidence(bodyFail)).toBe(false);
    expect(hasPassingProofEvidence(bodyMissing)).toBe(false);
    expect(hasPassingProofEvidence("PROOF: PASS")).toBe(true);
    // Integration: complete via file evidence without PROOF: line
    const node = fakeNode();
    await seedBoard(node);
    await milestoneAddCmd({ cfg, node, slug: "file-proof-ms", title: "File proof", state: "active", driver: "driver" });
    await addCmd({
      cfg, node, slug: "file-proof-card", title: "NS proof",
      body: bodyPass, milestone: "file-proof-ms", kind: "validation", column: "done",
    });
    await milestoneAddCmd({ cfg, node, slug: "file-proof-ms", proofCard: "file-proof-card" });
    await milestoneStateCmd({ cfg, node, slug: "file-proof-ms", state: "proving" });
    await milestoneAddCmd({ cfg, node, slug: "file-proof-ms", proofStatus: "passing" });
    expect(await milestoneStateCmd({ cfg, node, slug: "file-proof-ms", state: "complete" }))
      .toMatchObject({ to: "complete", proof_status: "passing" });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("reconcile exposes the ready child frontier and proof warnings", async () => {
    const node = fakeNode();
    await seedBoard(node);
    await milestoneAddCmd({ cfg, node, slug: "outcome-reconcile", title: "Reconcile me", state: "active" });
    await addCmd({
      cfg,
      node,
      slug: "ready-slice",
      title: "Ready slice",
      milestone: "outcome-reconcile",
      repo: "EdgeVector/fkanban",
      base: "main",
      kind: "pr",
      column: "todo",
      body: "Repo: EdgeVector/fkanban\nBase: main\n\n## GOAL\nReady milestone slice.\n\n## END STATE\nDone.\n",
    });
    await addCmd({ cfg, node, slug: "parked-slice", title: "Parked slice", milestone: "outcome-reconcile", kind: "pr", column: "backlog" });
    const result = await milestoneReconcileResult({ cfg, node, slug: "outcome-reconcile" });
    expect(result.ready.map((card) => card.slug)).toEqual(["ready-slice"]);
    // Driver defaults to last-stack-milestone-driver; only proof-card warning remains.
    expect(result.warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining(["no-proof-card"]));
    expect(result.milestone.driver).toBe("last-stack-milestone-driver");
  });

  test("portfolio, detail, grooming, and grouped board expose the milestone operating view", async () => {
    const node = fakeNode();
    await seedBoard(node);
    await milestoneAddCmd({ cfg, node, slug: "healthy-outcome", title: "Healthy outcome", state: "active", northStar: "north-a", driver: "driver-a" });
    await addCmd({
      cfg,
      node,
      slug: "healthy-slice",
      title: "Healthy slice",
      milestone: "healthy-outcome",
      northStar: "north-a",
      repo: "EdgeVector/fkanban",
      base: "main",
      kind: "pr",
      column: "todo",
      body: "Repo: EdgeVector/fkanban\nBase: main\n\n## GOAL\nHealthy milestone slice.\n\n## END STATE\nDone.\n",
    });
    await addCmd({ cfg, node, slug: "healthy-proof", title: "Healthy proof", milestone: "healthy-outcome", northStar: "north-a", kind: "validation", column: "backlog" });
    await milestoneAddCmd({ cfg, node, slug: "healthy-outcome", proofCard: "healthy-proof" });
    await addCmd({ cfg, node, slug: "operational-card", title: "Operational card", kind: "tracker", column: "backlog" });

    const portfolio = await milestonePortfolioResult({ cfg, node });
    expect(portfolio.entries[0]).toMatchObject({ slug: "healthy-outcome", north_star: "north-a", state: "active", ready: ["healthy-slice"], proof_status: "pending" });
    const detail = await milestoneDetailResult({ cfg, node, slug: "healthy-outcome" });
    expect(detail.detail.columns.todo?.map((card) => card.slug)).toEqual(["healthy-slice"]);
    expect(detail.text).toContain("Healthy outcome");
    expect((await milestoneGroomResult({ cfg, node })).issues).toEqual([]);

    const grouped = await listCmd({ cfg, node, groupByMilestone: true });
    expect(grouped).toContain("HEALTHY OUTCOME");
    expect(grouped).toContain("UNASSIGNED / OPERATIONAL");
    expect(grouped).toContain("healthy-slice");
    const groupedJson = JSON.parse(await listCmd({ cfg, node, groupByMilestone: true, json: true }));
    expect(groupedJson.groups.map((group: { slug: string }) => group.slug)).toEqual(["healthy-outcome", "unassigned-operational"]);
  });

  test("groom renders blocked and proving fixtures without false implementation-done", async () => {
    const node = fakeNode();
    await seedBoard(node);
    await milestoneAddCmd({ cfg, node, slug: "blocked-outcome", title: "Blocked", state: "active" });
    await milestoneAddCmd({ cfg, node, slug: "blocked-outcome", state: "blocked" });
    // Proof-only milestone (no implementation children) must NOT claim "implementation done".
    await milestoneAddCmd({ cfg, node, slug: "proving-outcome", title: "Proving", state: "active", driver: "driver" });
    await addCmd({ cfg, node, slug: "proving-proof", title: "Proof", milestone: "proving-outcome", kind: "validation", column: "backlog" });
    await milestoneAddCmd({ cfg, node, slug: "proving-outcome", proofCard: "proving-proof" });
    await milestoneStateCmd({ cfg, node, slug: "proving-outcome", state: "proving" });
    const groom = await milestoneGroomResult({ cfg, node });
    const codes = groom.issues.map((issue) => issue.code);
    // New milestones default driver=last-stack-milestone-driver (no no-driver warning).
    expect(codes).toEqual(expect.arrayContaining(["blocked-no-reason"]));
    expect(codes).not.toContain("implementation-done-proof-pending");
    expect(groom.text).toContain("blocked-outcome");
    // Proof-only proving milestone is healthy (no false "implementation done"), so
    // it correctly does not appear in the warnings list.
    expect(groom.issues.some((issue) => issue.milestone === "proving-outcome")).toBe(false);
  });

  test("implementation-done-proof-pending only when real implementation children are terminal", async () => {
    const node = fakeNode();
    await seedBoard(node);
    await milestoneAddCmd({
      cfg, node, slug: "done-impl-outcome", title: "Done impl", state: "active", driver: "driver",
    });
    await addCmd({
      cfg, node, slug: "done-impl-slice", title: "Done slice", milestone: "done-impl-outcome",
      repo: "EdgeVector/fkanban", base: "main", kind: "pr", column: "done",
      body: "Repo: EdgeVector/fkanban\nBase: main\n\n## GOAL\nShip slice.\n\n## END STATE\nMerged.\n",
    });
    await addCmd({
      cfg, node, slug: "done-impl-proof", title: "Proof", milestone: "done-impl-outcome",
      kind: "validation", column: "backlog",
    });
    await milestoneAddCmd({ cfg, node, slug: "done-impl-outcome", proofCard: "done-impl-proof" });

    // Empty / never-started milestone: no false positive.
    await milestoneAddCmd({
      cfg, node, slug: "empty-outcome", title: "Empty", state: "planned", driver: "driver",
    });

    const groom = await milestoneGroomResult({ cfg, node });
    const codesByMs = new Map<string, string[]>();
    for (const issue of groom.issues) {
      const ms = issue.milestone ?? "";
      const list = codesByMs.get(ms) ?? [];
      list.push(issue.code);
      codesByMs.set(ms, list);
    }
    expect(codesByMs.get("done-impl-outcome") ?? []).toContain("implementation-done-proof-pending");
    expect(codesByMs.get("empty-outcome") ?? []).not.toContain("implementation-done-proof-pending");
  });

  test("gap-report classifies in_flight, idle_promoteable, and idle_empty deterministically", async () => {
    const node = fakeNode();
    await seedBoard(node);

    await milestoneAddCmd({
      cfg, node, slug: "ms-flight", title: "In flight", state: "active", northStar: "ns-a", driver: "driver",
    });
    await addCmd({
      cfg, node, slug: "flight-pr", title: "Flight PR", milestone: "ms-flight", northStar: "ns-a",
      repo: "EdgeVector/fkanban", base: "main", kind: "pr", column: "doing",
      body: "Repo: EdgeVector/fkanban\nBase: main\n\n## GOAL\nWork.\n\n## END STATE\nDone.\n",
    });

    await milestoneAddCmd({
      cfg, node, slug: "ms-promote", title: "Promote me", state: "active", northStar: "ns-b", driver: "driver",
    });
    await addCmd({
      cfg, node, slug: "promote-pr", title: "Promote PR", milestone: "ms-promote", northStar: "ns-b",
      repo: "EdgeVector/fkanban", base: "main", kind: "pr", column: "backlog",
      body: "Repo: EdgeVector/fkanban\nBase: main\n\n## GOAL\nWork.\n\n## END STATE\nDone.\n",
    });

    await milestoneAddCmd({
      cfg, node, slug: "ms-empty", title: "Empty", state: "planned", northStar: "ns-c", driver: "driver",
    });

    const { report } = await milestoneGapReportResult({ cfg, node });
    const bySlug = Object.fromEntries(report.milestones.map((m) => [m.slug, m]));

    expect(bySlug["ms-flight"]?.status).toBe("in_flight");
    expect(bySlug["ms-flight"]?.action).toBe("skip");

    expect(bySlug["ms-promote"]?.status).toBe("idle_promoteable");
    expect(bySlug["ms-promote"]?.action).toBe("promote");
    expect(bySlug["ms-promote"]?.promoteable).toEqual(["promote-pr"]);

    expect(bySlug["ms-empty"]?.status).toBe("idle_empty");
    expect(bySlug["ms-empty"]?.action).toBe("decompose");

    expect(report.work_queue.map((w) => w.slug)).toEqual(["ms-promote", "ms-empty"]);
    expect(report.action_counts.promote).toBeGreaterThanOrEqual(1);
    expect(report.action_counts.decompose).toBeGreaterThanOrEqual(1);

    // Pure classifier: hollow backlog PR is not promoteable
    const hollow = classifyMilestoneGap(
      {
        slug: "ms-hollow", title: "H", body: "", board: "default", state: "active", position: "1",
        north_star: "ns-x", driver: "d", deps: [], proof_card: "", proof_status: "pending", block_reason: "",
        created_at: nowIso(), updated_at: nowIso(), completed_at: "",
      },
      [{
        slug: "hollow-pr", title: "Hollow", body: "Repo: EdgeVector/fkanban\nBase: main\n", board: "default",
        column: "backlog", position: "1", assignee: "", tags: [], deps: [], surfaces: [],
        created_at: nowIso(), created_by: "", updated_at: nowIso(), done_at: "",
        db: "", repo: "EdgeVector/fkanban", base: "main", kind: "pr", block_status: "none", block_reason: "",
        north_star: "ns-x", milestone: "ms-hollow", pr_url: "", branch: "",
      } as never],
      [{ slug: "hollow-pr", title: "Hollow", column: "backlog", blocked: false, blockedBy: [] }],
      null,
    );
    expect(hollow.status).toBe("idle_blocked");
    expect(hollow.promoteable).toEqual([]);
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
      slug: "mcp-outcome", title: "MCP outcome", state: "active", driver: "last-stack-milestone-driver",
    } });
    expect(created.isError).not.toBe(true);
    expect(created.structuredContent).toEqual({ slug: "mcp-outcome", action: "created", state: "active" });
    const listed = await client.callTool({ name: "fkanban_milestone_list", arguments: {} });
    expect((listed.structuredContent as { milestones: Array<{ slug: string }> }).milestones[0]?.slug).toBe("mcp-outcome");
    const shown = await client.callTool({ name: "fkanban_milestone_show", arguments: { slug: "mcp-outcome" } });
    expect((shown.structuredContent as { milestone: { driver: string } }).milestone.driver).toBe("last-stack-milestone-driver");
    await addCmd({ cfg, node, slug: "mcp-proof", title: "MCP proof", milestone: "mcp-outcome", kind: "validation", column: "backlog" });
    await milestoneAddCmd({ cfg, node, slug: "mcp-outcome", proofCard: "mcp-proof" });
    const moved = await client.callTool({ name: "fkanban_milestone_state", arguments: { slug: "mcp-outcome", state: "proving" } });
    expect(moved.structuredContent).toEqual({ slug: "mcp-outcome", from: "active", to: "proving", proof_status: "pending" });
    const reconciled = await client.callTool({ name: "fkanban_milestone_reconcile", arguments: { slug: "mcp-outcome" } });
    expect(reconciled.isError).not.toBe(true);
    expect((reconciled.structuredContent as { proof: { slug: string } }).proof.slug).toBe("mcp-proof");
    for (const [name, args] of [
      ["fkanban_milestone_portfolio", {}],
      ["fkanban_milestone_detail", { slug: "mcp-outcome" }],
      ["fkanban_milestone_groom", {}],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
    }
  });
});
