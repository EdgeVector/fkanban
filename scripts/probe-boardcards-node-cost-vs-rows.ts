#!/usr/bin/env bun
/**
 * READ-ONLY probe: how much of a BoardCards read is the NODE, and does it scale
 * with rows or with the request?
 *
 * ## The claim this exists to test
 *
 * `lastdb ops` has reported for five consecutive chief-engineer runs that
 * BoardCards is kanban's dominant node cost, and run (n) sharpened it into a
 * handoff item stated as an inversion:
 *
 *   | schema      | count  | sum       | avg/call |
 *   | card        | 46,934 | 148,819ms | 3.2ms    |
 *   | board_cards | 23,761 | 1,686,790ms | 71ms   |
 *
 *   "The thin membership index costs 22x more per call than reading whole
 *    cards. `board_cards` exists to be the cheap read."
 *
 * That is an avg-per-CALL comparison between a read that returns ~105 rows and
 * a point read that returns 1. Per call it is true and per row it may be the
 * exact opposite, and which one it is decides whether there is anything to fix:
 * if BoardCards is already cheap per row, the 71ms is the price of asking for
 * 105 rows at once and the index is behaving correctly.
 *
 * ## Method
 *
 * Same schema, same partition, same projection width — only the row count
 * varies, using the real column prefixes of the live board, which give a
 * natural 0/15/39/51/105 spread without writing anything.
 *
 * Node-side time comes from the node's OWN `request_ops` accounting, sampled
 * before and after each case group, so the ~183ms per-request transport latency
 * that dominates client-side wall time
 * ([[papercut-lastdb-183ms-fixed-latency-per-socket-request-on-an-idle-node]])
 * is excluded by construction rather than estimated.
 *
 * ## The contamination guard, which is not optional here
 *
 * `request_ops` is a node-wide ring shared with every other kanban process on
 * this machine — the routine fleet included. A delta taken around this probe's
 * calls will include anyone else's BoardCards reads in the same window. So the
 * probe compares the node's count delta against its own call count and REFUSES
 * to report per-case numbers when they disagree, instead of quietly dividing
 * someone else's work by this probe's denominator.
 *
 * Writes nothing.
 *
 * Run: bun scripts/probe-boardcards-node-cost-vs-rows.ts [reps] [board]
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { BOARD_CARDS_SPINE_FIELDS, boardCardsHash } from "../src/board-cards.ts";

const reps = Number(process.argv[2] ?? 6);
const board = process.argv[3] ?? "default";
const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const hash = boardCardsHash(cfg);
if (!hash) {
  console.error("no board_cards schema hash in config");
  process.exit(1);
}

// One projection for every case, so row count is the only independent variable.
const FIELDS = [...BOARD_CARDS_SPINE_FIELDS];

type Case = { label: string; filter: Record<string, unknown> };
// HashRangePrefix takes a fold HashRangeFilter OBJECT, not a positional pair —
// `{ HashRangePrefix: [board, prefix] }` is accepted by the TS type and rejected
// by the node with a bare HTTP 400 carrying no field name. Matching
// `board-cards.ts:749` exactly rather than reconstructing the shape.
const cases: Case[] = [
  { label: "doing#", filter: { HashRangePrefix: { hash: board, prefix: "doing#" } } },
  { label: "todo#", filter: { HashRangePrefix: { hash: board, prefix: "todo#" } } },
  { label: "backlog#", filter: { HashRangePrefix: { hash: board, prefix: "backlog#" } } },
  { label: "done#", filter: { HashRangePrefix: { hash: board, prefix: "done#" } } },
  { label: "whole partition", filter: { HashKey: board } },
];

type OpsRow = { count: number; sumMs: number };

/** The node's own count + total ms for `client=kanban kind=query schema=board_cards`. */
async function readNodeOps(): Promise<OpsRow> {
  const res = await node.rawCall("GET", "/api/status");
  const raw = res.body;
  const body = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown>;
  const status = (body.status ?? body) as Record<string, unknown>;
  const ops = (status.request_ops ?? {}) as Record<string, unknown>;
  for (const t of ["top_by_total_ms", "top_by_count", "top_by_duration"]) {
    const rows = (ops[t] ?? []) as Array<Record<string, unknown>>;
    if (!Array.isArray(rows)) continue;
    for (const r of rows) {
      if (
        String(r.schema ?? "") === hash &&
        String(r.client ?? "") === "kanban" &&
        String(r.kind ?? "") === "query"
      ) {
        return {
          count: Number(r.count ?? 0),
          sumMs: Number(r.sum_ms ?? r.sumMs ?? r.total_ms ?? 0),
        };
      }
    }
  }
  return { count: 0, sumMs: 0 };
}

type Result = {
  label: string;
  rows: number;
  clientMs: number;
  nodeMs: number;
  nodeCalls: number;
  clean: boolean;
};

const results: Result[] = [];

// Warm-up, discarded — the first touch of a cold shard is a different measurement.
for (const c of cases) await node.queryAll({ schemaHash: hash, fields: FIELDS, filter: c.filter as never });

for (const c of cases) {
  const before = await readNodeOps();
  let clientTotal = 0;
  let rows = 0;
  for (let r = 0; r < reps; r++) {
    const t0 = performance.now();
    const res = await node.queryAll({ schemaHash: hash, fields: FIELDS, filter: c.filter as never });
    clientTotal += performance.now() - t0;
    rows = res.results.length;
  }
  const after = await readNodeOps();
  const nodeCalls = after.count - before.count;
  results.push({
    label: c.label,
    rows,
    clientMs: clientTotal / reps,
    nodeMs: (after.sumMs - before.sumMs) / Math.max(nodeCalls, 1),
    nodeCalls,
    clean: nodeCalls === reps,
  });
}

console.log(`\nBoardCards node cost vs rows — board=${board} fields=${FIELDS.length} reps=${reps}\n`);
console.log("  case              rows   client/call   node/call   node/row   ops-calls");
for (const r of results) {
  const perRow = r.rows > 0 ? `${(r.nodeMs / r.rows).toFixed(2)}ms` : "     -";
  console.log(
    `  ${r.label.padEnd(16)} ${String(r.rows).padStart(4)}   ` +
      `${r.clientMs.toFixed(0).padStart(8)}ms   ${r.nodeMs.toFixed(1).padStart(7)}ms   ${perRow.padStart(8)}   ` +
      `${r.nodeCalls}${r.clean ? "" : " CONTAMINATED"}`,
  );
}

const dirty = results.filter((r) => !r.clean);
if (dirty.length > 0) {
  console.log(
    `\n  WARNING — ${dirty.length}/${results.length} case(s) saw more node calls than this probe issued.`,
  );
  console.log(`  Another kanban process read board_cards in the same window, so those`);
  console.log(`  node/call figures divide someone else's work by this probe's count.`);
  console.log(`  Re-run when the fleet is quiet before drawing a per-row conclusion.`);
}

// Fit node-side ms against row count over the clean cases only.
const pts = results.filter((r) => r.clean).map((r) => ({ x: r.rows, y: r.nodeMs }));
if (pts.length >= 3) {
  const mx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
  const my = pts.reduce((a, p) => a + p.y, 0) / pts.length;
  const slope =
    pts.reduce((a, p) => a + (p.x - mx) * (p.y - my), 0) /
    pts.reduce((a, p) => a + (p.x - mx) ** 2, 0);
  const intercept = my - slope * mx;
  console.log(
    `\n  node-side fit over ${pts.length} clean cases: ${intercept.toFixed(1)}ms + ${slope.toFixed(2)}ms/row`,
  );
  console.log(
    `  => a ${results[results.length - 1]!.rows}-row whole-partition read is ~${(intercept + slope * results[results.length - 1]!.rows).toFixed(0)}ms of node time,`,
  );
  console.log(`     of which ~${intercept.toFixed(0)}ms is owed to the request and the rest to rows.`);
} else {
  console.log(`\n  too few clean cases (${pts.length}) to fit a per-row cost.`);
}
