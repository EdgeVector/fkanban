#!/usr/bin/env bun
/**
 * Probe: what does `groom board-cards-heal`'s per-row upsert loop cost, versus
 * the same rows through `upsertBoardCardsBatch`?
 *
 * The heal's two pure-upsert branches (`upsert-truth`, `refresh-thin-fields`)
 * call `upsertBoardCard` once per card in a serial loop. This times that exact
 * call — same options the heal passes (`skipOrphanPurge`) —
 * against the batch wrapper doing the identical logical work.
 *
 * ## Controls, because the last three runs were all confounded
 *
 *  - DISTINCT slugs per row, so nothing pays the ~2.2s same-slot deferred-put
 *    gate that made a previous run's deletes look 15x a create.
 *  - A FRESH synthetic partition per arm per rep. Two arms sharing a board
 *    would queue on each other's gate and time the contention, not the path.
 *  - Arms INTERLEAVED (serial, batch, serial, batch, …), because the fleet's
 *    own load drifts on the minute scale and a block design would alias it.
 *  - Every arm READS ITS PARTITION BACK and asserts the row count. A probe
 *    that does not witness its own writes is how a previous run timed six
 *    moves of a card that did not exist.
 *
 * ## The answer, so it is not re-derived: do NOT batch the heal
 *
 * Measured 2026-08-05 on the live primary (lastdbd 0.23.3-canary.20260801),
 * 24 rows per arm: serial **1704 ms/row**, batch **808 ms/row** — batch is
 * **2.1x**, which reproduces the 2.10x in `upsertBoardCardsBatch`'s own
 * docstring on a different binary. So the primitive works.
 *
 * It is still the wrong thing to point at `board_cards_heal`, because the heal
 * does not write enough rows for it to matter. This file's sibling evidence is
 * the production record already in
 * `board_cards_heal.ts` (`DEFAULT_BOARD_CARDS_HEAL_REMOVAL_FLOOR`): across
 * **617 hourly runs that healed anything, the largest repair was 13 rows**, and
 * the distribution is dominated by 1 (259 runs) and 2 (160 runs). Batching a
 * loop whose median length is 1 buys nothing, and the one-chunk win at 13 rows
 * lands on 9 runs out of 617.
 *
 * The 686-mutation heal named in
 * papercut-kanban-board-cards-partition-gate-is-the-board-write-bottleneck is
 * an outlier against that record, not steady state. Establish what a heal
 * actually issues per run before optimizing it — `healed` counts REPAIRS, and
 * one repair is several mutations.
 *
 * WRITES to synthetic `zzhealbench-*` partitions only. No Board record is
 * created, so nothing appears on `board list`. Rows are removed on the way out.
 *
 * Run: bun scripts/probe-heal-upsert-serial-vs-batch.ts [reps] [rowsPerArm]
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import {
  boardCardSk,
  boardCardsHash,
  listBoardCardsPartition,
  upsertBoardCard,
  upsertBoardCardsBatch,
} from "../src/board-cards.ts";
import type { Card } from "../src/record.ts";

const REPS = Number(process.argv[2] ?? 3);
const ROWS = Number(process.argv[3] ?? 48);

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

function makeCards(board: string, n: number): Card[] {
  return Array.from({ length: n }, (_, i) => ({
    slug: `${board}-${i}`,
    title: `heal bench row ${i}`,
    column: "todo",
    position: String(1000 + i),
    board,
    body: "",
    created_at: new Date(STAMP).toISOString(),
    updated_at: new Date(STAMP).toISOString(),
  } as Card));
}

async function cleanup(board: string, cards: Card[]): Promise<void> {
  for (const c of cards) {
    try {
      await node.deleteRecord({
        schemaHash: boardCards!,
        keyHash: board,
        rangeKey: boardCardSk(c.column, c.position, c.slug),
      });
    } catch {
      // best effort; synthetic partition
    }
  }
}

/** Read the partition back so an arm cannot report a time for work it skipped. */
async function witness(board: string, want: number): Promise<number> {
  const rows = await listBoardCardsPartition(node, cfg, board);
  if (rows.length !== want) {
    throw new Error(`witness FAILED on ${board}: wrote ${want}, read back ${rows.length}`);
  }
  return rows.length;
}

type Arm = "serial" | "batch";

async function runArm(arm: Arm, rep: number): Promise<number> {
  const board = `zzhealbench-${STAMP}-${arm}-${rep}`;
  const cards = makeCards(board, ROWS);
  const t0 = performance.now();
  if (arm === "serial") {
    // Exactly what board_cards_heal's upsert-truth branch does, per row.
    for (const c of cards) {
      await upsertBoardCard(node, cfg, c, null, { skipOrphanPurge: true });
    }
  } else {
    const failed: string[] = [];
    await upsertBoardCardsBatch(node, cfg, cards, (c) => failed.push(c.slug));
    if (failed.length) throw new Error(`batch arm had ${failed.length} failed rows`);
  }
  const ms = performance.now() - t0;
  await witness(board, ROWS);
  await cleanup(board, cards);
  return ms;
}

const results: Record<Arm, number[]> = { serial: [], batch: [] };

for (let rep = 0; rep < REPS; rep++) {
  for (const arm of ["serial", "batch"] as Arm[]) {
    const ms = await runArm(arm, rep);
    results[arm].push(ms);
    console.log(
      `rep=${rep} arm=${arm.padEnd(6)} rows=${ROWS} wall=${ms.toFixed(0)}ms ` +
        `per_row=${(ms / ROWS).toFixed(1)}ms`,
    );
  }
}

function med(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

const ms = med(results.serial);
const mb = med(results.batch);
console.log("");
console.log(`median serial ${ms.toFixed(0)}ms (${(ms / ROWS).toFixed(1)}ms/row)`);
console.log(`median batch  ${mb.toFixed(0)}ms (${(mb / ROWS).toFixed(1)}ms/row)`);
console.log(`batch is ${(ms / mb).toFixed(2)}x the serial loop, ${ROWS} rows/arm, ${REPS} reps`);
console.log(`gate acquisitions: serial=${ROWS} batch=${Math.ceil(ROWS / 48)}`);
