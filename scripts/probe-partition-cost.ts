#!/usr/bin/env bun
/**
 * Probe: what does a BoardCards read actually cost, split by column?
 *
 * Read-only against the live primary. Answers three questions the
 * `lastdb ops` ranking cannot:
 *   1. how the `default` partition splits across columns (archive vs active),
 *   2. what the whole-partition HashKey read costs vs the sum of the
 *      per-column HashRangePrefix reads it could be decomposed into,
 *   3. how much of that cost is the terminal (`done`) archive nobody renders.
 *
 * Run: bun scripts/probe-partition-cost.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import {
  BOARD_CARDS_LIST_FIELDS,
  BOARD_CARDS_SPINE_FIELDS,
  boardCardsHash,
  listBoardCardsPartition,
} from "../src/board-cards.ts";
import { listBoards } from "../src/record.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});
const hash = boardCardsHash(cfg);
if (!hash) {
  console.error("board_cards schema not bound");
  process.exit(1);
}

const ms = async <T>(label: string, fn: () => Promise<T>): Promise<[T, number]> => {
  const t0 = performance.now();
  const v = await fn();
  const dt = performance.now() - t0;
  console.log(`  ${label.padEnd(46)} ${dt.toFixed(0).padStart(6)}ms`);
  return [v, dt];
};

const boards = await listBoards(node, cfg);
console.log(`boards: ${boards.map((b) => b.slug).join(", ")}\n`);

const BOARD = "default";

// --- 1. partition shape (spine read: drop-free) ---------------------------
console.log("== partition shape ==");
const [spine] = await ms("HashKey spine (all columns)", () =>
  listBoardCardsPartition(node, cfg, BOARD, { fields: BOARD_CARDS_SPINE_FIELDS }),
);
const byColumn = new Map<string, number>();
for (const c of spine ?? []) byColumn.set(c.column, (byColumn.get(c.column) ?? 0) + 1);
const total = spine?.length ?? 0;
console.log(`  total rows: ${total}`);
for (const [col, n] of [...byColumn.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${col.padEnd(10)} ${String(n).padStart(5)}  (${((n / total) * 100).toFixed(1)}%)`);
}

// --- 2. wide whole-partition vs per-column decomposition ------------------
// Interleave reps so a warming/thrashing node cannot bias one side.
const REPS = 3;
const columns = [...byColumn.keys()].sort();
const wide: number[] = [];
const perColumnSum: number[] = [];
const activeSum: number[] = [];
const doneOnly: number[] = [];

console.log(`\n== read cost, ${BOARD_CARDS_LIST_FIELDS.length}-field list projection, ${REPS} interleaved reps ==`);
for (let r = 0; r < REPS; r += 1) {
  console.log(` rep ${r + 1}`);
  const [, wms] = await ms("HashKey whole partition (what list does)", () =>
    listBoardCardsPartition(node, cfg, BOARD, { fields: BOARD_CARDS_LIST_FIELDS }),
  );
  wide.push(wms);

  let sum = 0;
  let active = 0;
  let done = 0;
  for (const col of columns) {
    const [rows, cms] = await ms(`  HashRangePrefix ${col}#`, () =>
      listBoardCardsPartition(node, cfg, BOARD, {
        column: col,
        fields: BOARD_CARDS_LIST_FIELDS,
      }),
    );
    console.log(`      -> ${rows?.length ?? 0} rows`);
    sum += cms;
    if (col === "done") done += cms;
    else active += cms;
  }
  perColumnSum.push(sum);
  activeSum.push(active);
  doneOnly.push(done);
}

const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
console.log("\n== verdict (median of reps) ==");
console.log(`  whole partition (HashKey)          ${med(wide).toFixed(0)}ms`);
console.log(`  sum of all per-column prefixes     ${med(perColumnSum).toFixed(0)}ms`);
console.log(`  active columns only (no done)      ${med(activeSum).toFixed(0)}ms`);
console.log(`  done column alone                  ${med(doneOnly).toFixed(0)}ms`);
console.log(
  `\n  archive share of a whole-partition read: ${((med(doneOnly) / med(wide)) * 100).toFixed(0)}%`,
);
