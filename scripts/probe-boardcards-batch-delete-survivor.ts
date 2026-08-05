#!/usr/bin/env bun
/**
 * Follow-up probe: in a per-row BoardCards delete loop, one row reliably reads
 * as STILL PRESENT afterwards. Is that a lost delete, or the partition index
 * lagging its own ack?
 *
 * The first batch-delete probe saw this twice out of two per-row arms (48 -> 1)
 * and never in a batched arm (48 -> 0). A lost delete would be a correctness
 * bug in the path `move`/`rank`/`heal` all use. Index lag would instead mean
 * every caller that reads a partition back to confirm a repair is reading
 * pre-delete state — which is the same hazard `upsertBoardCard` already
 * documents for WRITES ("the INDEX lags; the record does not"), reaching the
 * delete side too.
 *
 * The two are distinguishable by waiting: a lost delete stays lost.
 *
 * Prints WHICH row survives (position in the delete order), then re-reads after
 * a delay. WRITES + DELETES to synthetic `zzdelsurv-*` partitions only; board
 * names are appended to --manifest so a sweeper can find them if this dies.
 *
 * Run: bun scripts/probe-boardcards-batch-delete-survivor.ts [--manifest PATH]
 */
import { appendFileSync } from "node:fs";
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import {
  boardCardSk,
  boardCardsHash,
  listBoardCardsPartition,
  upsertBoardCardsBatch,
} from "../src/board-cards.ts";
import type { Card } from "../src/record.ts";

const manifestArg = process.argv.indexOf("--manifest");
const MANIFEST = manifestArg > -1 ? process.argv[manifestArg + 1]! : "";

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
const N = 6;
const SETTLE_MS = 3000;

function cardsFor(board: string): Card[] {
  return Array.from({ length: N }, (_, i) => ({
    slug: `${board}-${i}`,
    title: `survivor row ${i}`,
    column: "todo",
    position: String(1000 + i),
    board,
    body: "",
    created_at: new Date(STAMP).toISOString(),
    updated_at: new Date(STAMP).toISOString(),
  } as Card));
}

const boards: string[] = [];
async function seed(board: string): Promise<Card[]> {
  const cards = cardsFor(board);
  boards.push(board);
  if (MANIFEST) appendFileSync(MANIFEST, `${board}\n`);
  await upsertBoardCardsBatch(node, cfg, cards);
  return cards;
}

async function presentSlugs(board: string, cards: Card[]): Promise<Set<string>> {
  const rows = await listBoardCardsPartition(node, cfg, board);
  const got = new Set((rows ?? []).map((r) => r.slug));
  return new Set(cards.filter((c) => got.has(c.slug)).map((c) => c.slug));
}

try {
  for (let rep = 0; rep < 2; rep++) {
    const board = `zzdelsurv-${STAMP}-r${rep}`;
    const cards = await seed(board);
    console.log(`\nrep ${rep} — seeded ${(await presentSlugs(board, cards)).size}/${N} rows in ${board}`);

    // Per-row delete, in order, recording when each ack lands.
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i]!;
      await node.deleteRecord({
        schemaHash: boardCards!,
        keyHash: board,
        rangeKey: boardCardSk(c.column, c.position, c.slug),
      });
    }

    const immediate = await presentSlugs(board, cards);
    const idxOf = (slug: string) => cards.findIndex((c) => c.slug === slug);
    console.log(
      `  immediately after loop : ${immediate.size} present` +
      (immediate.size
        ? `  -> delete-order index ${[...immediate].map(idxOf).sort((a, b) => a - b).join(",")} of 0..${N - 1}`
        : ""),
    );

    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const settled = await presentSlugs(board, cards);
    console.log(`  after ${SETTLE_MS}ms settle    : ${settled.size} present`);

    if (immediate.size > 0 && settled.size === 0) {
      console.log("  => INDEX LAG. The delete landed; the partition read was stale.");
    } else if (settled.size > 0) {
      console.log(`  => LOST DELETE. Still present after settle: ${[...settled].join(", ")}`);
    } else {
      console.log("  => clean on the first read; no lag observed this rep.");
    }
  }
} finally {
  let removed = 0;
  for (const board of boards) {
    for (const c of cardsFor(board)) {
      try {
        await node.deleteRecord({
          schemaHash: boardCards!,
          keyHash: board,
          rangeKey: boardCardSk(c.column, c.position, c.slug),
        });
        removed += 1;
      } catch { /* already gone */ }
    }
  }
  console.log(`\ncleanup: ${boards.length} partition(s), ${removed} residual row(s) removed`);
}
