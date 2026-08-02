#!/usr/bin/env bun
/**
 * Probe: how big should a BoardCards write batch be?
 *
 * `probe-boardcards-write-lock-contention.ts` established that N writes into one
 * partition serialize on the node's per-`(molecule, hash)` gate, and that one
 * `/api/mutations/batch` request takes that gate ONCE — 2.1x over serial at
 * N=12. That says batch; it does not say how large a batch.
 *
 * Both ends are real risks, so neither should be picked by taste:
 *   - too small — back to paying the gate per chunk, and the win decays
 *   - too large — one request carrying every card's 24 fields, admitted on the
 *     lane its COMBINED payload implies (`Lane::for_write_bytes`), all-or-
 *     nothing on failure, and a long hold on the partition gate that every
 *     other kanban process is queued behind
 *
 * Fixed total work (48 rows), varying chunk size. Writes to synthetic
 * `zzbatchsize-*` partitions only; no Board record is created, so nothing
 * appears on `board list`. Every row is removed on the way out.
 *
 * Run: bun scripts/probe-boardcards-batch-size.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { boardCardsHash, boardCardFieldsFromCard } from "../src/board-cards.ts";
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
const TOTAL = 48;
const SIZES = [1, 4, 12, 24, 48];

const written: Array<{ board: string; sk: string }> = [];

function syntheticCard(i: number, board: string): Card {
  return {
    slug: `zzbatchsize-${STAMP}-${i}`,
    title: `batch size probe row ${i} — a title of roughly realistic width`,
    column: "todo",
    position: String(1000 + i),
    board,
    body: "",
    created_at: new Date(STAMP).toISOString(),
    updated_at: new Date(STAMP).toISOString(),
  } as Card;
}

async function writeChunk(cards: Card[]): Promise<number> {
  const ops = cards.map((card) => {
    const fields = boardCardFieldsFromCard(card);
    const board = String(fields.board);
    const sk = String(fields.sk);
    written.push({ board, sk });
    return {
      type: "mutation",
      schema: boardCards,
      fields_and_values: fields,
      key_value: { hash: board, range: sk },
      mutation_type: "update",
    };
  });
  const bytes = new TextEncoder().encode(JSON.stringify(ops)).length;
  const res = await node.rawCall("POST", "/api/mutations/batch", ops);
  if (res.status !== 200) {
    throw new Error(`batch route ${res.status}: ${String(res.body).slice(0, 300)}`);
  }
  return bytes;
}

async function cleanup(): Promise<void> {
  let failed = 0;
  for (const { board, sk } of written) {
    try {
      await node.deleteRecord({ schemaHash: boardCards!, keyHash: board, rangeKey: sk });
    } catch {
      failed += 1;
    }
  }
  console.log(`\ncleanup: ${written.length - failed}/${written.length} probe rows removed`);
}

try {
  console.log(`BoardCards batch size — ${TOTAL} rows total per regime, one partition each\n`);
  console.log("chunk   requests    total     per-write   largest req");
  console.log("-----   --------   -------   ---------   -----------");

  for (const size of SIZES) {
    const board = `zzbatchsize-${STAMP}-s${size}`;
    const cards = Array.from({ length: TOTAL }, (_, i) => syntheticCard(i, board));
    let maxBytes = 0;
    let requests = 0;
    const t0 = performance.now();
    for (let i = 0; i < cards.length; i += size) {
      maxBytes = Math.max(maxBytes, await writeChunk(cards.slice(i, i + size)));
      requests += 1;
    }
    const ms = performance.now() - t0;
    console.log(
      `${String(size).padStart(5)}   ${String(requests).padStart(8)}   ` +
        `${String(Math.round(ms)).padStart(5)}ms   ${String(Math.round(ms / TOTAL)).padStart(7)}ms   ` +
        `${String(Math.round(maxBytes / 1024)).padStart(8)} KiB`,
    );
  }
} finally {
  await cleanup();
}
