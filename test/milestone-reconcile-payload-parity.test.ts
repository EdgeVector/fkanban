/**
 * `milestone reconcile` printed the proof verdict to a human and withheld it
 * from a machine.
 *
 * `milestoneProofVerdict` re-derives the LIVE proof answer on every read, and
 * exists so a driver reads ONE field instead of pattern-matching prose out of
 * `warnings[]` (see the doc comment on `MilestoneReconcileResult.proof_verdict`).
 * Four `--json`/structuredContent surfaces are built from that same read, each
 * by hand-picking fields off the result object. Three named the verdict. The
 * fourth — `milestone reconcile`, which `milestone-driver.md` step 1 runs on the
 * proof path — did not, while `result.text` from the SAME invocation printed it.
 *
 * Measured on the live primary 2026-08-06, one milestone claiming `passing`
 * with no proof card linked:
 *
 *     human    proof verdict: unproven (no-proof-card; recorded "passing")
 *     --json   keys: children, milestone, proof, ready, repairs, warnings
 *              .milestone.proof_status = "passing"
 *
 *     show --json       proof_verdict: unproven
 *     detail --json     proof_verdict: unproven
 *     portfolio --json  proof_verdict: unproven
 *     reconcile --json  ABSENT
 *
 * So the tests below assert two different things, because the defect had two
 * layers:
 *
 *   1. BEHAVIOUR — reconcile's machine half must carry what its own prose half
 *      says. Asserted on the CLI payload and, through a real MCP client, on
 *      `structuredContent` (which the client validates against the declared
 *      outputSchema, so a field emitted but not declared fails here too).
 *
 *   2. STRUCTURE — the reason this was missable is that the selection happened
 *      four times. `milestoneReconcilePayload` is now the only selector, and
 *      the exhaustiveness test compares it against the keys the read ACTUALLY
 *      returns. A fifth field added to the result type fails that test rather
 *      than silently reaching three surfaces out of four.
 *
 * The exhaustiveness test is the one that matters in a year. It is written
 * against a real result object rather than a hand-copied key list, because a
 * hand-copied list is a second place to forget the same field.
 *
 * REVERT SPLIT — predicted 4/3, MEASURED 4/3. The revert used was the wiring
 * one: `milestoneReconcilePayload` left defined and exported, the three call
 * sites restored to hand-picked literals, the two fields dropped from the MCP
 * output schema. Pre-fix message on the MCP round-trip:
 *
 *     Expected: "unproven"
 *     Received: undefined
 *
 * The three survivors are the three that call the projection DIRECTLY — they
 * assert the selector, not that anything uses it. That asymmetry is why the
 * reach checks in the middle block exist, and it is worth knowing before
 * treating a green run here as covering the CLI: on the CLI path, the reach
 * checks are the entire guard.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { NodeClient, QueryFilter, QueryResponse, QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import {
  milestoneReconcilePayload,
  milestoneReconcileResult,
} from "../src/commands/milestone.ts";
import { createFkanbanMcpServer } from "../src/mcp/server.ts";
import { emptyStructuredFields } from "../src/record.ts";

const CARD_HASH = "card-hash";
const BOARD_HASH = "board-hash";
const MILESTONE_HASH = "milestone-hash";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://127.0.0.1:9",
  userHash: "user",
  schemaServiceUrl: "http://127.0.0.1:9",
  schemaHashes: { board: BOARD_HASH, card: CARD_HASH, milestone: MILESTONE_HASH },
};

type StoredRecord = { keyHash: string; rangeKey: string | null; fields: Record<string, unknown> };

/**
 * Drops a row when any projected field has no atom on it, as LastDB answers.
 * Same shape as `milestone-proof-verdict.test.ts`'s node: a fake that ignores
 * `fields` cannot produce the vanished-card case these fixtures depend on.
 */
function fakeNode(seed: { cards?: Array<Record<string, unknown>>; milestones?: Array<Record<string, unknown>> }): NodeClient {
  const store = new Map<string, Map<string, StoredRecord>>();
  const storeKey = (keyHash: string, rangeKey?: string | null) => `${keyHash}\0${rangeKey ?? ""}`;
  const tableFor = (schemaHash: string) => {
    let t = store.get(schemaHash);
    if (!t) store.set(schemaHash, (t = new Map()));
    return t;
  };
  for (const c of seed.cards ?? []) tableFor(CARD_HASH).set(storeKey(String(c.slug)), { keyHash: String(c.slug), rangeKey: null, fields: { ...c } });
  for (const m of seed.milestones ?? []) tableFor(MILESTONE_HASH).set(storeKey(String(m.slug)), { keyHash: String(m.slug), rangeKey: null, fields: { ...m } });
  tableFor(BOARD_HASH).set(storeKey("default"), {
    keyHash: "default",
    rangeKey: null,
    fields: { slug: "default", title: "Default", body: "", columns: ["backlog", "todo", "doing", "done"], created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" },
  });

  const matchesFilter = (rec: StoredRecord, filter?: QueryFilter): boolean => {
    if (!filter) return true;
    const f = filter as Record<string, unknown>;
    if (typeof f.HashKey === "string") return rec.keyHash === f.HashKey;
    const prefix = f.HashRangePrefix as { hash: string; prefix: string } | undefined;
    if (prefix) return rec.keyHash === prefix.hash && (rec.rangeKey ?? "").startsWith(prefix.prefix);
    return true;
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
    async createRecord({ schemaHash, fields, keyHash, rangeKey }) {
      tableFor(schemaHash).set(storeKey(keyHash, rangeKey), { keyHash, rangeKey: rangeKey ?? null, fields: { ...fields } });
    },
    async updateRecord({ schemaHash, fields, keyHash, rangeKey }) {
      tableFor(schemaHash).set(storeKey(keyHash, rangeKey), { keyHash, rangeKey: rangeKey ?? null, fields: { ...tableFor(schemaHash).get(storeKey(keyHash, rangeKey))?.fields, ...fields } });
    },
    async deleteRecord({ schemaHash, keyHash, rangeKey }) {
      tableFor(schemaHash).delete(storeKey(keyHash, rangeKey));
    },
    async queryAll({ schemaHash, fields, filter }): Promise<QueryResponse> {
      const results: QueryRow[] = [];
      for (const rec of tableFor(schemaHash).values()) {
        if (!matchesFilter(rec, filter)) continue;
        if (fields.some((name) => !(name in rec.fields))) continue;
        const projected: Record<string, unknown> = {};
        for (const name of fields) projected[name] = rec.fields[name];
        results.push({ fields: projected, key: { hash: rec.keyHash, range: rec.rangeKey } });
      }
      return { ok: true, results, returned_count: results.length, total_count: results.length };
    },
    rawCall: notImpl("rawCall") as NodeClient["rawCall"],
    nodeTransport: () => ({ transport: "unavailable" as const }),
  };
}

const milestoneRecord = (partial: Record<string, unknown> = {}): Record<string, unknown> => ({
  slug: "m1",
  title: "Milestone one",
  body: "",
  board: "default",
  state: "complete",
  position: "10",
  north_star: "ns-1",
  driver: "last-stack-milestone-driver",
  deps: [],
  proof_card: "proof",
  proof_status: "passing",
  block_reason: "",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  completed_at: "2026-02-01T00:00:00.000Z",
  ...partial,
});

const cardRecord = (partial: Record<string, unknown> = {}): Record<string, unknown> => ({
  slug: "proof",
  title: "Prove it end to end",
  body: "## GOAL\nProve it.\n\n## END STATE\nProven.\n\nPROOF: PASS\n",
  board: "default",
  column: "done",
  position: "10",
  assignee: "",
  tags: [],
  deps: [],
  created_at: "2026-01-01T00:00:00.000Z",
  created_by: "test",
  updated_at: "2026-01-01T00:00:00.000Z",
  ...emptyStructuredFields(),
  kind: "validation",
  repo: "EdgeVector/fkanban",
  milestone: "m1",
  ...partial,
});

/**
 * The live board's recurring shape: completed, proof recorded `passing`, proof
 * card deleted. The stored claim is intact and false — exactly the case a
 * machine consumer has to be able to see.
 */
const completedThenDeleted = { cards: [], milestones: [milestoneRecord()] };

/** The keys `milestoneReconcileResult` returns that are NOT the read's payload. */
const CARRIERS = new Set(["text", "repairs", "boards"]);

describe("reconcile's machine half carries what its prose half says", () => {
  test("the payload names the verdict that contradicts the stored claim", async () => {
    const result = await milestoneReconcileResult({ cfg, node: fakeNode(completedThenDeleted), slug: "m1", apply: false });

    // RED before the change: the CLI and MCP both hand-picked a subset that
    // stopped at `warnings`, so this key was simply absent.
    const payload = milestoneReconcilePayload(result);
    expect(payload.proof_verdict).toBe("unproven");
    expect(payload.proof_verdict_reason).toBe("missing-proof-card");

    // The stored claim SURVIVES beside the verdict — healing it away would erase
    // the only record that a passing proof was ever asserted. Which is also why
    // the verdict has to be present: this field is what a driver would otherwise
    // gate on, alone.
    expect(payload.milestone.proof_status).toBe("passing");

    // Both halves of the same invocation, asserted against each other. This is
    // the parity the defect broke: prose corrected the claim, structure did not.
    expect(result.text).toContain("proof verdict: unproven");
    expect(result.text).toContain('recorded "passing"');
  });

  test("and it is a real verdict, not a constant — intact evidence reads passing", async () => {
    // Positive control. Every other assertion here expects `unproven`, so a fix
    // that hardcoded the pessimistic answer would satisfy all of them and be
    // worse than the defect: a driver that can never complete a milestone.
    // Same fixture, proof card restored.
    const withProof = { cards: [cardRecord()], milestones: [milestoneRecord()] };
    const result = await milestoneReconcileResult({ cfg, node: fakeNode(withProof), slug: "m1", apply: false });

    const payload = milestoneReconcilePayload(result);
    expect(payload.proof_verdict).toBe("passing");
    expect(payload.milestone.proof_status).toBe("passing");
    // Agreement between claim and evidence prints no correction clause.
    expect(result.text).toContain("proof verdict: passing");
    expect(result.text).not.toContain("recorded");
  });

  test("fkanban_milestone_reconcile's structuredContent carries it too", async () => {
    // Through a real MCP client, so the declared outputSchema is validated
    // against the emitted payload: a field emitted-but-undeclared fails here,
    // and so does one declared-but-unemitted. `dry_run` keeps this a read.
    const server = createFkanbanMcpServer({ cfg, node: fakeNode(completedThenDeleted) });
    const client = new Client({ name: "test", version: "0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const res = await client.callTool({ name: "fkanban_milestone_reconcile", arguments: { slug: "m1", dry_run: true } });
    const structured = res.structuredContent as { proof_verdict: string; proof_verdict_reason: string; milestone: { proof_status: string } };

    expect(structured.proof_verdict).toBe("unproven");
    expect(structured.proof_verdict_reason).toBe("missing-proof-card");
    expect(structured.milestone.proof_status).toBe("passing");

    // An agent that reads only the text block must see the same correction as
    // one that reads only structuredContent. Neither rendering is the fallback.
    const text = (res.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")?.text ?? "";
    expect(text).toContain("proof verdict: unproven");
  });
});

describe("no surface re-hand-picks the reconcile payload", () => {
  /**
   * The failure this repo actually regresses to is "plumbed but never wired":
   * `milestoneReconcilePayload` keeps existing and a call site quietly goes back
   * to listing fields off `result`. Every assertion above that calls the
   * projection DIRECTLY survives that revert — verified, not assumed — so
   * without this check the CLI half would be guarded by nothing.
   *
   * The give-away of a hand-picked reconcile subset is one object literal
   * naming `ready` and `warnings` off the same result. After the fix, zero
   * files match; `milestoneReconcilePayload` is the only selector.
   */
  const SOURCES = ["src/cli.ts", "src/mcp/server.ts", "src/commands/milestone.ts"];

  test("no source file selects reconcile fields by hand", () => {
    for (const rel of SOURCES) {
      const src = readFileSync(join(import.meta.dir, "..", rel), "utf8");
      const handRolled = src
        .split("\n")
        .map((line, i) => ({ line, no: i + 1 }))
        .filter(({ line }) => /ready:\s*result\.ready/.test(line) && /warnings:\s*result\.warnings/.test(line));
      expect(
        handRolled.map(({ no, line }) => `${rel}:${no} ${line.trim()}`),
      ).toEqual([]);
    }
  });

  test("each payload-emitting surface routes through the projection", () => {
    // Matched on the SPREAD form, not the bare name. `commands/milestone.ts`
    // both defines and calls the projection, and the definition line contains
    // `milestoneReconcilePayload(` — so a bare-name check passes there no matter
    // what the call site does. Every real call site spreads the result into its
    // own envelope (`repairs` for CLI/MCP, `columns` for detail); the definition
    // never does. Caught by asking what the check would do under the revert.
    for (const rel of SOURCES) {
      const src = readFileSync(join(import.meta.dir, "..", rel), "utf8");
      expect(src).toContain("...milestoneReconcilePayload(");
    }
  });

  test("the MCP tool DECLARES the verdict fields, not just emits them", async () => {
    // The schema is the agent-facing contract: a field that arrives undeclared
    // is one a host may strip, and one no agent knows to look for. Read off the
    // registered tool rather than the source, so this asserts what a client
    // actually sees.
    const server = createFkanbanMcpServer({ cfg, node: fakeNode(completedThenDeleted) });
    const client = new Client({ name: "test", version: "0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const { tools } = await client.listTools();
    const schema = tools.find((t) => t.name === "fkanban_milestone_reconcile")?.outputSchema as
      | { properties?: Record<string, unknown> }
      | undefined;
    const declared = Object.keys(schema?.properties ?? {}).sort();

    const result = await milestoneReconcileResult({ cfg, node: fakeNode(completedThenDeleted), slug: "m1", apply: false });
    const expected = [...Object.keys(milestoneReconcilePayload(result)), "repairs"].sort();

    expect(declared).toEqual(expected);
  });
});

describe("the projection stays exhaustive over what the read returns", () => {
  test("every non-carrier field of a reconcile result reaches the payload", async () => {
    // The regression this guards is not "proof_verdict went missing again" — it
    // is the NEXT field. Compare against the keys the real read produces rather
    // than a list written out here, because a hand-written list is a second
    // place to forget the same thing.
    const result = await milestoneReconcileResult({ cfg, node: fakeNode(completedThenDeleted), slug: "m1", apply: false });

    const readKeys = Object.keys(result).filter((k) => !CARRIERS.has(k)).sort();
    const payloadKeys = Object.keys(milestoneReconcilePayload(result)).sort();

    expect(payloadKeys).toEqual(readKeys);
  });

  test("the carriers are still carriers, and still present", async () => {
    // If `repairs` or `text` stopped being returned, the exhaustiveness test
    // above would keep passing while quietly checking less — the vacuous-green
    // shape. Pin that they exist and that the payload deliberately omits them:
    // `repairs` describes what THIS invocation wrote, not what the read found,
    // and each caller re-attaches it beside the payload.
    const result = await milestoneReconcileResult({ cfg, node: fakeNode(completedThenDeleted), slug: "m1", apply: false });

    for (const carrier of CARRIERS) expect(result).toHaveProperty(carrier);
    for (const carrier of CARRIERS) expect(milestoneReconcilePayload(result)).not.toHaveProperty(carrier);
  });
});
