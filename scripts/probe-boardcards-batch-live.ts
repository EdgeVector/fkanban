#!/usr/bin/env bun
/**
 * Probe: does `upsertBoardCardsBatch` — the real wrapper, over the real client
 * method, against the real node — write what it claims to?
 *
 * The lock-contention and batch-size probes went straight to `rawCall`, and the
 * unit tests go through a fake. Neither one exercises
 * `NodeClient.updateRecords`, so neither can catch a wire-shape mistake in the
 * one function that actually ships. This does: it writes a chunk-and-a-bit
 * through the wrapper, reads the partition back, and compares.
 *
 * WRITES, to a synthetic `zzbatchlive-*` partition only. No Board record is
 * created, so nothing appears on `board list`. Rows are removed on the way out.
 *
 * Run: bun scripts/probe-boardcards-batch-live.ts
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
});

const boardCards = boardCardsHash(cfg);
if (!boardCards) throw new Error("no board_cards schema hash in config");

const STAMP = Date.now();
const BOARD = `zzbatchlive-${STAMP}`;
const N = BOARD_CARDS_WRITE_BATCH + 5;

const cards: Card[] = Array.from({ length: N }, (_, i) => ({
  slug: `zzbatchlive-${STAMP}-${i}`,
  title: `live batch row ${i}`,
  column: "todo",
  position: String(1000 + i),
  board: BOARD,
  body: "",
  created_at: new Date(STAMP).toISOString(),
  updated_at: new Date(STAMP).toISOString(),
} as Card));

async function cleanup(): Promise<void> {
  let removed = 0;
  for (const c of cards) {
    try {
      await node.deleteRecord({
        schemaHash: boardCards!,
        keyHash: BOARD,
        rangeKey: boardCardSk(c.column, c.position, c.slug),
      });
      removed += 1;
    } catch { /* already gone */ }
  }
  console.log(`\ncleanup: ${removed}/${cards.length} probe rows removed`);
}

try {
  console.log(`live batch wrapper — ${N} rows (chunk ${BOARD_CARDS_WRITE_BATCH}) -> ${BOARD}\n`);
  console.log(`client exposes updateRecords: ${typeof node.updateRecords === "function"}`);

  const failures: string[] = [];
  const t0 = performance.now();
  await upsertBoardCardsBatch(node, cfg, cards, (card) => failures.push(card.slug));
  const ms = performance.now() - t0;
  console.log(`wrote ${N} rows in ${Math.round(ms)}ms (${Math.round(ms / N)}ms/write)`);
  console.log(`per-row fallback failures: ${failures.length}`);

  // Read it back WIDE. A batch that 200s but stores a partial row is the
  // failure this is here to catch — `listBoardCardsPartition` is the projected
  // read every board surface uses, and it drops rows missing a projected field.
  const rows = await listBoardCardsPartition(node, cfg, BOARD);
  const got = new Set((rows ?? []).map((r) => r.slug));
  const missing = cards.filter((c) => !got.has(c.slug)).map((c) => c.slug);

  console.log(`\nprojected read back : ${rows?.length ?? "null"} / ${N} rows`);
  if (missing.length > 0) {
    console.log(`MISSING (${missing.length}): ${missing.slice(0, 5).join(", ")}`);
    console.log("\nRED — batched rows are not wholly readable.");
  } else {
    console.log("\nGREEN — every batched row reads back whole through the projected read.");
  }
} finally {
  await cleanup();
}
