#!/usr/bin/env bun
/**
 * Sweep synthetic BoardCards partitions left behind by probe runs.
 *
 * The probes in this directory write to `zz<name>-<stamp>` partitions and clean
 * up in a `finally`. A probe that is KILLED — the batch-delete probe hit a 10
 * minute timeout mid-run on 2026-08-05 — never reaches that block, and its rows
 * are then unreachable by name: nothing records the stamp, and no Board record
 * points at the partition, so `board list`, `groom`, and parity-check all skip
 * them forever.
 *
 * A full scan is the only thing that can see them, which is exactly why this is
 * a separate deliberate script and not something a probe does on the way out.
 *
 * Default is DRY RUN. Pass --apply to delete.
 *
 * Run: bun scripts/sweep-probe-boardcards-litter.ts [--apply] [--prefix zz]
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { boardCardsHash, deleteBoardCardRowsBySk } from "../src/board-cards.ts";

const APPLY = process.argv.includes("--apply");
const prefixArg = process.argv.indexOf("--prefix");
const PREFIX = prefixArg > -1 ? process.argv[prefixArg + 1]! : "zz";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
  opsLabel: "kanban-probe",
});

const boardCards = boardCardsHash(cfg);
if (!boardCards) throw new Error("no board_cards schema hash in config");

// Read the ADDRESS, not the payload: `board` is the partition key and `sk` the
// range key, and those two are all a reap needs. A row missing an atom for a
// projected field is dropped by the node, so keeping this to two fields also
// keeps the scan from silently hiding partial rows it could otherwise address.
const res = await node.queryAll({
  schemaHash: boardCards,
  fields: ["board", "sk"],
  allowFullScan: true,
});

// A QueryResponse carries `results`, NOT `rows`. Reading the wrong property
// yields `undefined`, which reports a clean sweep on a dirty node — this script
// printed exactly that on its first run. The row count is asserted below rather
// than trusted, because "0 rows" is the shape a broken read and an empty result
// share.
const rows = res.results ?? [];
if (rows.length === 0) {
  throw new Error(
    "full scan of BoardCards returned 0 rows — the board is never empty, so this is a broken read, not a clean node",
  );
}

const bySk = new Map<string, string[]>();
for (const row of rows) {
  const f = row.fields ?? {};
  // The KEY is the address; the `board`/`sk` fields are payload copies a
  // partial write can leave stale or absent (see `spineRowsFromQueryRows`).
  const board = row.key?.hash || (typeof f.board === "string" ? f.board : "");
  const sk = row.key?.range || (typeof f.sk === "string" ? f.sk : "");
  if (!board || !sk || !board.startsWith(PREFIX)) continue;
  const list = bySk.get(board) ?? [];
  list.push(sk);
  bySk.set(board, list);
}

const total = [...bySk.values()].reduce((a, b) => a + b.length, 0);
console.log(`scanned ${rows.length} BoardCards row(s)`);
console.log(`synthetic partitions matching "${PREFIX}*": ${bySk.size}, holding ${total} row(s)\n`);

for (const [board, sks] of [...bySk].sort()) {
  console.log(`  ${board.padEnd(40)} ${String(sks.length).padStart(4)} row(s)`);
}

if (bySk.size === 0) {
  console.log("\nnothing to sweep.");
} else if (!APPLY) {
  console.log(`\nDRY RUN — re-run with --apply to delete these ${total} row(s).`);
} else {
  let reaped = 0;
  for (const [board, sks] of bySk) {
    reaped += await deleteBoardCardRowsBySk(node, cfg, board, sks);
  }
  console.log(`\nswept ${reaped} row(s) across ${bySk.size} partition(s).`);
}
