// The milestone half of "a write's confirmation must name every field the write
// changed" — the two write verbs the card-side sweep left out.
//
// Run (f) audited the seven CARD write commands and fixed `dep add`, whose
// result type could express the edge it added but not the column it moved. It
// closed with `milestone add` / `milestone state` as an open item, on the
// narrow ground that they were the only MCP confirmations still hand-built and
// therefore had no second copy of their prose to drift from. That was true and
// it was also the reason they sat outside the reach check. Asking run (f)'s
// question of them directly found three defects, all measured before the fix:
//
// A. `milestone state <slug> active --proof-status failing` returned
//    `proof_status: "failing"` and printed `milestone m1: proving → active`.
//    The proof claim the caller had just changed appeared nowhere in the line.
//
// B. The same command on an ALREADY-active milestone printed
//    `milestone m1: active → active` — a line that reads as a no-op — while the
//    stored `proof_status` went to `failing`. This is the documented
//    fix-forward path: `milestone_failed_proof_requires_active`'s own hint
//    tells operators to "transition to active with --proof-status failing", so
//    it is the confirmation that most needs to say what moved, and it was the
//    one that said the least.
//
// C. `milestone add --proof-status failing` on a `proving` milestone silently
//    transitions it to `active` (the failing-proof rule inside
//    `milestoneAddCmd`). It printed `updated milestone m1 (active)` — the END
//    state, true, and indistinguishable from a milestone that was already
//    active. An operator recording a proof failure was not told they had also
//    moved the outcome out of `proving`.
//
// D. `resolveMilestoneDriver` REFUSES a superseded driver the caller names but
//    silently heals one it merely INHERITED. So any unrelated write — a
//    `--title` rename — rewrote `driver`, the field that decides which routine
//    reconciles the milestone, and the confirmation named neither. Measured:
//    `driver before: program-driver` → `driver after:
//    last-stack-milestone-driver`, confirmation `updated milestone m2
//    (planned)`.
//
// PREDICTED SPLIT, written before running: reverting the fix should fail 6 and
// pass 2. MEASURED: 7 fail / 2 pass. The prediction undercounted by one — I
// forgot test (9), the reach check, which fails on revert too because the
// revert restores the hand-rolled MCP strings it scans for. The survivors were
// the two predicted ones: the quiet gates. A plain state transition and a plain
// create must read exactly as they always have, because a confirmation that
// grows a clause on every write is a confirmation nobody reads.
//
// The revert used for that measurement KEEPS the plumbing and restores only the
// defect — `stateCoerced`/`driverHealed` left uncomputed, and `proof_status_from`
// sourced from the POST-write read instead of the pre-write one. That is the
// regression shape this repo actually hits (run (f): a label "plumbed but never
// wired"), and it is the one a type-level revert would not catch. Pre-fix
// messages, for the record:
//
//     Expected: "milestone m1: active → active; proof pending → failing"
//     Received: "milestone m1: active → active"
//
//     Expected: "updated milestone m1 (active); state proving → active
//                (a failing proof must return the milestone to active)"
//     Received: "updated milestone m1 (active)"

import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { NodeClient, QueryFilter, QueryResponse, QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { milestoneAddCmd, milestoneShowResult, milestoneStateCmd } from "../src/commands/milestone.ts";
import { addCmd } from "../src/commands/add.ts";
import { boardToFields, milestoneToFields, nowIso } from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";
import { formatMilestoneAdd, formatMilestoneState } from "../src/format.ts";
import { createFkanbanMcpServer } from "../src/mcp/server.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash", milestone: "milestonehash" },
};

// Local fake node rather than ./fake-node.ts: these cases need the Milestone
// schema bound, and one of them has to reach past the command layer to seed a
// record whose stored `driver` is the superseded value — the on-disk shape of a
// milestone written before the supersession, which no current command can
// produce.
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
    async updateRecord({ schemaHash, keyHash, fields }) { table(schemaHash).set(keyHash, { ...table(schemaHash).get(keyHash), ...fields }); },
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

const proofBody = ["## GOAL", "prove it", "", "## END STATE", "proven", "", "PROOF: PASS"].join("\n");

/** A milestone in `proving` with a live, passing, terminal proof card. */
async function seedProving(node: NodeClient): Promise<void> {
  await seedBoard(node);
  await milestoneAddCmd({ cfg, node, slug: "m1", title: "M", state: "active", driver: "last-stack-milestone-driver" });
  await addCmd({ cfg, node, slug: "p1", title: "Proof", column: "done", body: proofBody, kind: "validation", milestone: "m1" });
  await milestoneAddCmd({ cfg, node, slug: "m1", proofCard: "p1" });
  await milestoneStateCmd({ cfg, node, slug: "m1", state: "proving" });
}

async function mcpClient(node: NodeClient): Promise<Client> {
  const server = createFkanbanMcpServer({ cfg, node });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "milestone-confirmation-test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

const textOf = (res: unknown): string =>
  ((res as { content: { type: string; text: string }[] }).content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");

describe("milestone write confirmations name every field the write changed", () => {
  test("(1) `milestone state` names a proof claim it changed alongside the state", async () => {
    const node = fakeNode();
    await seedProving(node);

    const res = await milestoneStateCmd({ cfg, node, slug: "m1", state: "active", proofStatus: "failing" });

    expect(res.proof_status_from).toBe("pending");
    expect(res.proof_status).toBe("failing");
    expect(formatMilestoneState(res)).toBe("milestone m1: proving → active; proof pending → failing");
  });

  test("(2) a transition whose state does not move still says what did", async () => {
    // The sharpest case, and the one the old line got most wrong: `active →
    // active` is a true statement that reads as "nothing happened".
    const node = fakeNode();
    await seedBoard(node);
    await milestoneAddCmd({ cfg, node, slug: "m1", title: "M", state: "active", driver: "last-stack-milestone-driver" });

    const res = await milestoneStateCmd({ cfg, node, slug: "m1", state: "active", proofStatus: "failing" });

    expect((await milestoneShowResult({ cfg, node, slug: "m1" })).milestone.proof_status).toBe("failing");
    expect(formatMilestoneState(res)).toBe("milestone m1: active → active; proof pending → failing");
  });

  test("(3) `milestone add --proof-status failing` names the lifecycle move it caused", async () => {
    const node = fakeNode();
    await seedProving(node);

    const res = await milestoneAddCmd({ cfg, node, slug: "m1", proofStatus: "failing" });

    expect(res.stateCoerced).toEqual({
      from: "proving",
      to: "active",
      reason: "a failing proof must return the milestone to active",
    });
    expect(formatMilestoneAdd(res)).toBe(
      "updated milestone m1 (active); state proving → active " +
      "(a failing proof must return the milestone to active)",
    );
  });

  test("(4) an inherited superseded driver rewrite is reported by the write that healed it", async () => {
    const node = fakeNode();
    await seedBoard(node);
    await milestoneAddCmd({ cfg, node, slug: "m2", title: "M2", state: "planned", driver: "last-stack-milestone-driver" });
    // Rewrite the stored driver under the command layer — `milestoneAddCmd`
    // refuses to WRITE a superseded driver, so the only way to reach the heal
    // path is a record that already has one. Written through `milestoneToFields`
    // so the seeded row is whole: a LastDB keyed read returns a row only when
    // every projected field has an atom, and a hand-built subset would read as
    // ABSENT rather than as a milestone with a stale driver.
    const stored = (await milestoneShowResult({ cfg, node, slug: "m2" })).milestone;
    await node.updateRecord({
      schemaHash: cfg.schemaHashes.milestone!,
      keyHash: "m2",
      fields: milestoneToFields({ ...stored, driver: "program-driver" }),
    });

    const res = await milestoneAddCmd({ cfg, node, slug: "m2", title: "M2 renamed" });

    expect((await milestoneShowResult({ cfg, node, slug: "m2" })).milestone.driver).toBe("last-stack-milestone-driver");
    expect(res.driverHealed).toEqual({ from: "program-driver", to: "last-stack-milestone-driver" });
    expect(formatMilestoneAdd(res)).toBe(
      "updated milestone m2 (planned); driver program-driver → last-stack-milestone-driver " +
      "(superseded driver healed; it decides which routine reconciles this milestone)",
    );
  });

  test("(5) `fkanban_milestone_state` says what the CLI says", async () => {
    const node = fakeNode();
    await seedProving(node);

    const client = await mcpClient(node);
    const res = await client.callTool({
      name: "fkanban_milestone_state",
      arguments: { slug: "m1", state: "active", proof_status: "failing" },
    });

    expect(textOf(res)).toBe("milestone m1: proving → active; proof pending → failing");
    // Declared on the output schema, not an undeclared passenger.
    expect((res as unknown as { structuredContent: { proof_status_from: string } })
      .structuredContent.proof_status_from).toBe("pending");
  });

  test("(6) `fkanban_milestone_add` says what the CLI says", async () => {
    const node = fakeNode();
    await seedProving(node);

    const client = await mcpClient(node);
    const res = await client.callTool({
      name: "fkanban_milestone_add",
      arguments: { slug: "m1", proof_status: "failing" },
    });

    expect(textOf(res)).toBe(
      "updated milestone m1 (active); state proving → active " +
      "(a failing proof must return the milestone to active)",
    );
  });

  test("(7) QUIET GATE — a plain transition reads exactly as it always has", async () => {
    const node = fakeNode();
    await seedProving(node);

    const res = await milestoneStateCmd({ cfg, node, slug: "m1", state: "active" });

    expect(res.driverHealed).toBeUndefined();
    expect(formatMilestoneState(res)).toBe("milestone m1: proving → active");
  });

  test("(8) QUIET GATE — a plain create reads exactly as it always has", async () => {
    const node = fakeNode();
    await seedBoard(node);

    const res = await milestoneAddCmd({ cfg, node, slug: "m3", title: "M3", state: "planned" });

    expect(res.stateCoerced).toBeUndefined();
    expect(res.driverHealed).toBeUndefined();
    expect(formatMilestoneAdd(res)).toBe("created milestone m3 (planned)");
  });

  test("(9) neither milestone write verb hand-builds its own confirmation any more", async () => {
    // Test (8) of the card-side sweep excluded these two BY NAME. The exemption
    // is gone from that file; this asserts the other half — that the exclusion
    // was removed because the tools were fixed, not because the check was
    // loosened. A future edit that drops the exemption back in fails here.
    const reach = readFileSync(
      new URL("./write-confirmations-name-every-field-changed.test.ts", import.meta.url),
      "utf8",
    );
    expect(reach).not.toContain('!line.includes("milestone")');

    const src = readFileSync(new URL("../src/mcp/server.ts", import.meta.url), "utf8");
    const milestoneHandRolled = src
      .split("\n")
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => line.startsWith("return toolResult(`") && line.includes("milestone"));

    expect(milestoneHandRolled.map(({ line, n }) => `${n}: ${line}`)).toEqual([]);
  });
});
