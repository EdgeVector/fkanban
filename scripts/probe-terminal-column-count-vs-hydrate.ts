#!/usr/bin/env bun
/**
 * READ-ONLY probe: is a bounded page's `total_count` the WHOLE filter's count,
 * or just the page's?
 *
 * `kanban list` renders at most `DEFAULT_COLUMN_LIMIT` cards per column and
 * collapses the rest to "… N more". To print N it currently hydrates every row
 * in the terminal column — 155 of the 193 rows on the live `default` board —
 * and then throws 143 of them away. If the node's count pass already reports
 * the true total for a bounded read, N is free and those 143 hydrations are
 * pure waste.
 *
 * Interleaved against a control arm, because a before/after delta around a
 * single command is not a measurement on this node (background fleet traffic
 * moves the counters between arms).
 *
 * Run: bun scripts/probe-terminal-column-count-vs-hydrate.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { boardCardsHash, BOARD_CARDS_LIST_FIELDS, boardCardsWireProjection } from "../src/board-cards.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});
const schemaHash = boardCardsHash(cfg);
if (!schemaHash) throw new Error("BoardCards schema not bound");

const BOARD = "default";
const TERMINAL = "done";
const fields = boardCardsWireProjection([...BOARD_CARDS_LIST_FIELDS]);

type Shape = { rows: number; total: number | null; hasMore: boolean | null; ms: number };

async function rawQuery(limit: number, filter: unknown): Promise<Shape> {
  const t0 = performance.now();
  const res = await node.rawCall("POST", "/api/query", {
    schema_name: schemaHash,
    fields,
    limit,
    filter,
  });
  const ms = performance.now() - t0;
  if (res.status !== 200) throw new Error(`status ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);
  const raw = res.body;
  const body = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown>;
  if (process.env.PROBE_DUMP_KEYS === "1") {
    console.log("    body keys:", Object.keys(body).join(","));
  }
  // Production's pagination metadata is TOP-LEVEL on the /api/query body
  // (`total_count` / `returned_count` / `limit` / `offset` / `has_more`), not
  // nested under `page` — `page` is the SDK's own parsed shape.
  const rows = (body.results ?? body.rows ?? []) as unknown[];
  const total = (body.total_count as number | undefined) ?? (body.row_count as number | undefined) ?? null;
  const hasMore = (body.has_more as boolean | undefined) ?? null;
  return { rows: rows.length, total: total ?? null, hasMore: hasMore ?? null, ms };
}

const prefix = { HashRangePrefix: { hash: BOARD, prefix: `${TERMINAL}#` } };
const whole = { HashKey: BOARD };

console.log("=== shape check: does a bounded page report the filter's true total? ===\n");
const full = await rawQuery(1000, prefix);
console.log(`  terminal column, limit=1000  rows=${full.rows} total=${full.total} has_more=${full.hasMore} ${full.ms.toFixed(0)}ms`);
for (const limit of [1, 12, 40]) {
  const r = await rawQuery(limit, prefix);
  const verdict =
    r.total === full.rows ? "TRUE TOTAL" : r.total === r.rows ? "page-only (useless)" : `? (${r.total})`;
  console.log(`  terminal column, limit=${String(limit).padStart(4)}  rows=${String(r.rows).padStart(3)} total=${String(r.total).padStart(4)} has_more=${r.hasMore} ${r.ms.toFixed(0).padStart(5)}ms  -> ${verdict}`);
}

console.log("\n=== cost: whole partition vs (active rows + bounded terminal page) ===");
console.log("    7 interleaved reps, medians\n");

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const wholeMs: number[] = [];
const splitMs: number[] = [];
const controlMs: number[] = [];

// Ranges that exclude the terminal column, same construction as
// `excludeColumnRanges` — everything strictly before `done#` and after `done$`.
const beforeTerminal = { HashRangeRange: { hash: BOARD, start: "", end: `${TERMINAL}#` } };
const afterTerminal = { HashRangeRange: { hash: BOARD, start: `${TERMINAL}$`, end: "￿" } };

for (let i = 0; i < 7; i++) {
  const w = await rawQuery(1000, whole);
  wholeMs.push(w.ms);

  const t0 = performance.now();
  const [a, b, term] = await Promise.all([
    rawQuery(1000, beforeTerminal),
    rawQuery(1000, afterTerminal),
    rawQuery(12, prefix),
  ]);
  splitMs.push(performance.now() - t0);

  // Control arm: the same whole-partition read again, so background traffic
  // that drifts between arms shows up as whole-vs-control spread, not as a win.
  const c = await rawQuery(1000, whole);
  controlMs.push(c.ms);

  if (i === 0) {
    console.log(`  rep 0 rows: whole=${w.rows}  before=${a.rows} after=${b.rows} terminalPage=${term.rows} (total=${term.total})`);
  }
}

console.log(`\n  whole partition (HashKey)          median ${median(wholeMs).toFixed(0)}ms`);
console.log(`  control (same read, later in rep)   median ${median(controlMs).toFixed(0)}ms`);
console.log(`  active ranges + bounded terminal    median ${median(splitMs).toFixed(0)}ms`);
