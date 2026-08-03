#!/usr/bin/env bun
/**
 * READ-ONLY probe: how much of a kanban read happens OUTSIDE the node?
 *
 * `lastdb ops` reports `client=kanban kind=query schema=<Card>` at avg ~13ms,
 * and its own phase accounting for that key sums to about the same. Yet a
 * serial `findCard` measured from inside the client takes ~200ms. If that gap
 * is real it dominates every other cost in this codebase — it would explain why
 * narrowing a point-read projection from 23 fields to 2 measured 1.02x, and why
 * two prior runs found round trips, not rows or fields, to be the cost.
 *
 * Method: issue N identical point reads serially in one process, timing each,
 * and read the node's OWN accounting for exactly those requests from
 * /api/status `request_ops` before and after. Anything the client waited for
 * that the node did not spend is outside the node.
 *
 * Writes nothing.
 *
 * Run: bun scripts/probe-client-overhead-vs-node-time.ts [reps]
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { listBoards, listCards } from "../src/record.ts";
import { schemaHashFor } from "../src/config.ts";
import { fieldsFor } from "../src/schemas.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const REPS = Number(process.argv[2] ?? "20");
const cardHash = schemaHashFor("card", cfg);

const boards = await listBoards(node, cfg);
const cards = await listCards(node, cfg, { boards, activeOnly: true });
const slug = cards[0]?.slug;
if (!slug) throw new Error("no active card to probe");
console.log(`probing ${REPS} serial point reads of "${slug}"\n`);

type OpsRow = { count: number; sumMs: number };

/** The node's own total time + count for `client=kanban kind=query schema=<card>`. */
async function readNodeOps(): Promise<OpsRow> {
  const res = await node.rawCall("GET", "/api/status");
  const raw = res.body;
  const body = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown>;
  const status = (body.status ?? body) as Record<string, unknown>;
  const ops = (status.request_ops ?? {}) as Record<string, unknown>;
  // The ring exposes several rankings; any of them carries per-key totals.
  const tables = ["top_by_total_ms", "top_by_count", "top_by_duration"];
  for (const t of tables) {
    const rows = (ops[t] ?? []) as Array<Record<string, unknown>>;
    if (!Array.isArray(rows)) continue;
    for (const r of rows) {
      const schema = String(r.schema ?? "");
      const client = String(r.client ?? "");
      const kind = String(r.kind ?? "");
      if (schema === cardHash && client === "kanban" && kind === "query") {
        return {
          count: Number(r.count ?? 0),
          sumMs: Number(r.sum_ms ?? r.sumMs ?? r.total_ms ?? 0),
        };
      }
    }
  }
  return { count: 0, sumMs: 0 };
}

const before = await readNodeOps();

const perCall: number[] = [];
for (let i = 0; i < REPS; i++) {
  const t = performance.now();
  await node.queryAll({
    schemaHash: cardHash,
    fields: fieldsFor("card"),
    filter: { HashKey: slug } as never,
  });
  perCall.push(performance.now() - t);
}

const after = await readNodeOps();

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const clientTotal = perCall.reduce((a, b) => a + b, 0);
const nodeCount = after.count - before.count;
const nodeTotal = after.sumMs - before.sumMs;

console.log("=== client-measured ===");
console.log(`  calls            ${REPS}`);
console.log(`  median           ${median(perCall).toFixed(1)}ms`);
console.log(`  min / max        ${Math.min(...perCall).toFixed(1)}ms / ${Math.max(...perCall).toFixed(1)}ms`);
console.log(`  total            ${clientTotal.toFixed(0)}ms`);

console.log("\n=== node's own accounting for those same requests ===");
if (nodeCount <= 0) {
  console.log("  (could not isolate — request_ops did not advance for this key; ranking tables");
  console.log("   only carry the top keys, so a quiet schema may not appear)");
} else {
  console.log(`  calls counted    ${nodeCount}   (${nodeCount === REPS ? "exactly ours" : "includes concurrent fleet traffic"})`);
  console.log(`  node total       ${nodeTotal.toFixed(0)}ms`);
  console.log(`  node avg         ${(nodeTotal / nodeCount).toFixed(1)}ms`);
  const outside = clientTotal - nodeTotal * (REPS / nodeCount);
  console.log("\n=== verdict ===");
  console.log(`  in node          ${((nodeTotal * (REPS / nodeCount)) / clientTotal * 100).toFixed(1)}%`);
  console.log(`  OUTSIDE node     ${(outside / clientTotal * 100).toFixed(1)}%  (${(outside / REPS).toFixed(1)}ms per call)`);
}
