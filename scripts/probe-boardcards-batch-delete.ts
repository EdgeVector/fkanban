#!/usr/bin/env bun
/**
 * Probe: will `/api/mutations/batch` accept `mutation_type: "delete"`, and is
 * batching the delete half of a board write actually cheaper than the per-row
 * loop we ship today?
 *
 * ## Why ask
 *
 * `NodeClient.updateRecords` hard-codes `mutation_type: "update"`, so
 * `upsertBoardCardsBatch` can batch only the WRITE half of a board mutation.
 * Every sk retirement — the delete in every `move`, every `rank` reposition,
 * every `groom board-cards-heal` repair — still goes one row per request, and
 * the node gates a BoardCards write per `(molecule, hash-half)`, i.e. once per
 * BOARD. So each of those deletes takes the whole board's write gate on its own.
 *
 * fold's `execute_mutations_batch` builds each item through the same
 * `MutationComponents { .., mutation_type, .. }` as the single-record route, so
 * a delete in a batch should be structurally identical to a single delete. That
 * is an argument, not a witness. This is the witness.
 *
 * ## What it measures
 *
 * Three interleaved reps, alternating which arm goes first so a warming node
 * cannot hand either one the win:
 *
 *   A. per-row  `deleteRecord` x N   (what ships)
 *   B. batched  delete ops in chunks (what is proposed)
 *
 * and after each arm, a projected partition read-back asserting the rows are
 * ACTUALLY gone — a 200 that deletes nothing would otherwise look like a win.
 *
 * WRITES + DELETES, to synthetic `zzbatchdel-*` partitions only. No Board
 * record is created, so nothing appears on `board list`. Every row this makes
 * is removed on the way out, including on failure.
 *
 * Run: bun scripts/probe-boardcards-batch-delete.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import {
  BOARD_CARDS_WRITE_BATCH,
  boardCardSk,
  boardCardsHash,
  listBoardCardsPartition,
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
const N = BOARD_CARDS_WRITE_BATCH; // one full chunk per arm
const REPS = 3;

const madeBoards: string[] = [];

function cardsFor(board: string): Card[] {
  return Array.from({ length: N }, (_, i) => ({
    slug: `${board}-${i}`,
    title: `batch delete row ${i}`,
    column: "todo",
    position: String(1000 + i),
    board,
    body: "",
    created_at: new Date(STAMP).toISOString(),
    updated_at: new Date(STAMP).toISOString(),
  } as Card));
}

/** Seed one synthetic partition, batched (the fast path we already trust). */
async function seed(board: string): Promise<Card[]> {
  const cards = cardsFor(board);
  madeBoards.push(board);
  await upsertBoardCardsBatch(node, cfg, cards);
  return cards;
}

/** How many of these rows does the projected partition read still return? */
async function stillPresent(board: string, cards: Card[]): Promise<number> {
  const rows = await listBoardCardsPartition(node, cfg, board);
  const got = new Set((rows ?? []).map((r) => r.slug));
  return cards.filter((c) => got.has(c.slug)).length;
}

/** Arm A — what ships: one request per row. */
async function deletePerRow(board: string, cards: Card[]): Promise<number> {
  const t0 = performance.now();
  for (const c of cards) {
    await node.deleteRecord({
      schemaHash: boardCards!,
      keyHash: board,
      rangeKey: boardCardSk(c.column, c.position, c.slug),
    });
  }
  return performance.now() - t0;
}

/**
 * Arm B — proposed: `mutation_type: "delete"` items in one batch request.
 *
 * Built here rather than through a client method on purpose: the point is to
 * find out whether the WIRE accepts it before any client code is written for it.
 */
async function deleteBatched(board: string, cards: Card[]): Promise<number> {
  const t0 = performance.now();
  for (let i = 0; i < cards.length; i += BOARD_CARDS_WRITE_BATCH) {
    const chunk = cards.slice(i, i + BOARD_CARDS_WRITE_BATCH);
    const ops = chunk.map((c) => ({
      type: "mutation",
      schema: boardCards!,
      fields_and_values: {},
      key_value: { hash: board, range: boardCardSk(c.column, c.position, c.slug) },
      mutation_type: "delete",
    }));
    const res = await node.rawCall("POST", "/api/mutations/batch", ops);
    if (res.status !== 200) {
      throw new Error(
        `batch delete rejected: HTTP ${res.status} ${JSON.stringify(res.json ?? res.body).slice(0, 400)}`,
      );
    }
  }
  return performance.now() - t0;
}

async function cleanup(): Promise<void> {
  let removed = 0;
  for (const board of madeBoards) {
    for (const c of cardsFor(board)) {
      try {
        await node.deleteRecord({
          schemaHash: boardCards!,
          keyHash: board,
          rangeKey: boardCardSk(c.column, c.position, c.slug),
        });
        removed += 1;
      } catch { /* already gone — the arms delete most of these by design */ }
    }
  }
  console.log(`\ncleanup: swept ${madeBoards.length} probe partition(s), ${removed} residual row(s) removed`);
}

const perRow: number[] = [];
const batched: number[] = [];
let wireRejected: string | null = null;

try {
  console.log(`batch-delete probe — ${N} rows/arm, ${REPS} interleaved reps, chunk ${BOARD_CARDS_WRITE_BATCH}\n`);

  for (let rep = 0; rep < REPS; rep++) {
    // Alternate the order so neither arm always runs on the warmer node.
    const batchFirst = rep % 2 === 1;
    const order: Array<"batch" | "row"> = batchFirst ? ["batch", "row"] : ["row", "batch"];

    for (const arm of order) {
      const board = `zzbatchdel-${STAMP}-r${rep}-${arm}`;
      const cards = await seed(board);
      const before = await stillPresent(board, cards);

      let ms: number;
      try {
        ms = arm === "row" ? await deletePerRow(board, cards) : await deleteBatched(board, cards);
      } catch (err) {
        if (arm === "batch") {
          wireRejected = String(err);
          console.log(`\nRED — the node refused a batched delete:\n  ${wireRejected}`);
          break;
        }
        throw err;
      }

      const after = await stillPresent(board, cards);
      (arm === "row" ? perRow : batched).push(ms);
      console.log(
        `rep ${rep} ${arm.padEnd(5)} : ${String(Math.round(ms)).padStart(6)}ms ` +
        `(${Math.round(ms / N)}ms/row)  rows ${before} -> ${after}` +
        (after === 0 ? "" : `   <-- ${after} SURVIVED the delete`),
      );
    }
    if (wireRejected) break;
  }

  if (!wireRejected) {
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const r = mean(perRow);
    const b = mean(batched);
    console.log(`\nper-row mean : ${Math.round(r)}ms  (${Math.round(r / N)}ms/row)`);
    console.log(`batched mean : ${Math.round(b)}ms  (${Math.round(b / N)}ms/row)`);
    console.log(`speedup      : ${(r / b).toFixed(2)}x`);
    console.log(
      b < r
        ? "\nGREEN — the node accepts batched deletes and they are cheaper than the per-row loop."
        : "\nAMBER — batched deletes are accepted but NOT faster here; do not ship on this evidence.",
    );
  }
} finally {
  await cleanup();
}
