#!/usr/bin/env bun
/**
 * Probe: does the SHIPPING reap wrapper — `deleteBoardCardRowsBySk`, over the
 * real client, against the real node — now take the batch path?
 *
 * `probe-boardcards-batch-delete.ts` proved the WIRE accepts a batched delete by
 * building the operation by hand. That is a different claim from "the function
 * kanban actually calls sends one". The unit tests close that gap against a
 * fake; this closes it against the primary, which is where a wire-shape mistake
 * would surface and a fake cannot.
 *
 * Counts requests by wrapping `rawCall`/`deleteRecord` on the live client, so
 * the assertion is "one request for N rows", not "it finished".
 *
 * WRITES + DELETES to a synthetic `zzreaplive-*` partition only. No Board
 * record is created, so nothing appears on `board list`.
 *
 * Run: bun scripts/probe-boardcards-reap-live.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import {
  boardCardSk,
  boardCardsHash,
  deleteBoardCardRowsBySk,
  upsertBoardCardsBatch,
} from "../src/board-cards.ts";
import type { Card } from "../src/record.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
  opsLabel: "kanban-probe",
});

const boardCards = boardCardsHash(cfg);
if (!boardCards) throw new Error("no board_cards schema hash in config");

const STAMP = Date.now();
const BOARD = `zzreaplive-${STAMP}`;
const N = 8;

const cards: Card[] = Array.from({ length: N }, (_, i) => ({
  slug: `${BOARD}-${i}`,
  title: `reap row ${i}`,
  column: "todo",
  position: String(1000 + i),
  board: BOARD,
  body: "",
  created_at: new Date(STAMP).toISOString(),
  updated_at: new Date(STAMP).toISOString(),
} as Card));

const sks = cards.map((c) => boardCardSk(c.column, c.position, c.slug));

// Count what the reap actually issues.
//
// Wrap the two OBJECT PROPERTIES the reap wrapper binds (`node.deleteRecords`,
// `node.deleteRecord`) — not `rawCall`. The client's batch envelope closes over
// an INTERNAL `rawCallImpl`, so a `node.rawCall` patch applied after
// construction never fires and reports zero requests for a batch that did
// happen. This probe made that mistake on its first run and read RED off it.
let batchRequests = 0;
let batchedRows = 0;
let perRowDeletes = 0;
const realDeleteRecords = node.deleteRecords!.bind(node);
node.deleteRecords = async (rows) => {
  batchRequests += 1;
  batchedRows += rows.length;
  return realDeleteRecords(rows);
};
const realDelete = node.deleteRecord.bind(node);
node.deleteRecord = async (opts) => {
  perRowDeletes += 1;
  return realDelete(opts);
};

console.log(`live reap — ${N} rows -> ${BOARD}`);
console.log(`client exposes deleteRecords: ${typeof node.deleteRecords === "function"}\n`);

await upsertBoardCardsBatch(node, cfg, cards);
batchRequests = 0; // the seed's own batch is not what is under test

const t0 = performance.now();
const attempted = await deleteBoardCardRowsBySk(node, cfg, BOARD, sks);
const ms = performance.now() - t0;

console.log(`reaped ${attempted}/${N} sks in ${Math.round(ms)}ms`);
console.log(`  batch requests   : ${batchRequests} (carrying ${batchedRows} row(s))`);
console.log(`  per-row deletes  : ${perRowDeletes}`);

if (batchRequests === 1 && batchedRows === N && perRowDeletes === 0) {
  console.log(`\nGREEN — ${N} rows retired in ONE request; the gate was taken once, not ${N} times.`);
} else if (perRowDeletes > 0) {
  console.log(`\nRED — fell back to ${perRowDeletes} per-row delete(s); the batch path was not taken.`);
} else {
  console.log(`\nRED — expected 1 batch request, saw ${batchRequests}.`);
}

// Belt and braces: anything the reap missed goes now.
let residual = 0;
for (const sk of sks) {
  try {
    await realDelete({ schemaHash: boardCards, keyHash: BOARD, rangeKey: sk });
    residual += 1;
  } catch { /* already gone */ }
}
console.log(`cleanup: ${residual} residual delete(s) issued against ${BOARD}`);
