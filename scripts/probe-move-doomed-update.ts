#!/usr/bin/env bun
/**
 * Probe: does a `move`'s destination write pay a DOOMED round trip?
 *
 * ## Why this exists
 *
 * `upsertBoardCard`'s inner `write()` is try-update / catch-create:
 *
 *     try { await node.updateRecord(...) }
 *     catch { await node.createRecord(...) }
 *
 * A move's destination sk (`column#position#slug`) is by construction a row
 * that does not exist yet — the comment above `retireSupersededRows` says so
 * explicitly. So IF an update against an absent row fails, every move pays a
 * full mutation round trip that cannot succeed, on the interactive path, and
 * `lastdb ops` says a BoardCards mutation costs ~830ms of molecule_gate alone.
 *
 * But `client.ts:updateRecords` asserts the opposite for the batch route:
 * "an update against an absent row is an upsert storing what is sent". The
 * tree therefore contains both beliefs, one per route, and neither can be
 * settled by reading more of it. Only the running binary knows.
 *
 * ## What is measured
 *
 *   1. update -> absent row: does it throw, and what does it cost?
 *   2. if it does NOT throw, did it actually STORE the row (upsert), or
 *      silently no-op? A no-op that reports success would be far worse than a
 *      throw — the catch would never fire and the card would vanish.
 *   3. create -> absent row, as the cost control.
 *   4. update -> row that now exists, the ordinary narrow-write case.
 *
 * Point 2 is the one that matters. "It didn't throw" is not "it worked".
 *
 * WRITES, to synthetic `zzdoomed-*` rows on a synthetic board partition only.
 * Never touches `default`, never creates a Board record (so nothing appears on
 * `board list` — see papercut-kanban-stress-boards-leak-...). Every row it
 * writes is deleted on the way out, including on failure.
 *
 * Run: bun scripts/probe-move-doomed-update.ts
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

const schemaHash = boardCardsHash(cfg);
if (!schemaHash) throw new Error("no board_cards schema hash in config");

const STAMP = Date.now();
const BOARD = `zzdoomed-${STAMP}`;
const REPS = 5;

const written: Array<{ board: string; sk: string }> = [];

function syntheticCard(i: number, column: string, position: string): Card {
  return {
    slug: `zzdoomed-${STAMP}-${i}`,
    title: `doomed-update probe row ${i}`,
    column,
    position,
    board: BOARD,
    body: "",
    created_at: new Date(STAMP).toISOString(),
    updated_at: new Date(STAMP).toISOString(),
  } as Card;
}

type Outcome = { ms: number; threw: boolean; err?: string };

async function attempt(verb: "update" | "create", card: Card): Promise<Outcome> {
  const fields = boardCardFieldsFromCard(card);
  const board = String(fields.board);
  const sk = String(fields.sk);
  written.push({ board, sk });
  const t0 = performance.now();
  try {
    if (verb === "update") {
      await node.updateRecord({ schemaHash: schemaHash!, fields, keyHash: board, rangeKey: sk });
    } else {
      await node.createRecord({ schemaHash: schemaHash!, fields, keyHash: board, rangeKey: sk });
    }
    return { ms: performance.now() - t0, threw: false };
  } catch (err) {
    return { ms: performance.now() - t0, threw: true, err: String(err).slice(0, 200) };
  }
}

/** Did the row actually land? Read it back by its exact key. */
async function rowExists(card: Card): Promise<boolean> {
  const fields = boardCardFieldsFromCard(card);
  const res = await node.queryAll({
    schemaHash: schemaHash!,
    fields: ["slug", "title", "column", "board"],
    filter: { HashKey: String(fields.board) },
  });
  return res.results.some((r) => String((r.fields ?? {}).slug ?? "") === card.slug);
}

function stat(label: string, xs: number[]): string {
  if (xs.length === 0) return `${label.padEnd(34)} (none)`;
  const avg = xs.reduce((a, b) => a + b, 0) / xs.length;
  const min = Math.min(...xs);
  const max = Math.max(...xs);
  return `${label.padEnd(34)} avg=${avg.toFixed(0).padStart(5)}ms  min=${min.toFixed(0).padStart(5)}ms  max=${max.toFixed(0).padStart(5)}ms  n=${xs.length}`;
}

async function main() {
  console.log(`board partition: ${BOARD}  (synthetic, no Board record)\n`);

  // --- 1 & 2: update against a row that does not exist -------------------
  const updateAbsent: number[] = [];
  let updateAbsentThrew = 0;
  let updateAbsentStored = 0;
  let firstErr = "";
  for (let i = 0; i < REPS; i++) {
    const card = syntheticCard(i, "todo", String(1000 + i));
    const out = await attempt("update", card);
    updateAbsent.push(out.ms);
    if (out.threw) {
      updateAbsentThrew++;
      if (!firstErr) firstErr = out.err ?? "";
    } else if (await rowExists(card)) {
      updateAbsentStored++;
    }
  }

  // --- 3: create against a row that does not exist -----------------------
  const createAbsent: number[] = [];
  for (let i = 0; i < REPS; i++) {
    const card = syntheticCard(100 + i, "todo", String(2000 + i));
    const out = await attempt("create", card);
    createAbsent.push(out.ms);
  }

  // --- 4: update against a row that DOES exist (the narrow-write case) ---
  const updatePresent: number[] = [];
  for (let i = 0; i < REPS; i++) {
    const card = syntheticCard(i, "todo", String(1000 + i));
    const out = await attempt("update", { ...card, title: `rewritten ${i}` } as Card);
    updatePresent.push(out.ms);
  }

  console.log(stat("update -> ABSENT row", updateAbsent));
  console.log(stat("create -> ABSENT row", createAbsent));
  console.log(stat("update -> PRESENT row", updatePresent));
  console.log("");
  console.log(`update->absent threw:  ${updateAbsentThrew}/${REPS}`);
  console.log(`update->absent STORED: ${updateAbsentStored}/${REPS}  <- upsert iff this equals n and threw=0`);
  if (firstErr) console.log(`first error: ${firstErr}`);
  console.log("");
  if (updateAbsentThrew === 0 && updateAbsentStored === REPS) {
    console.log("VERDICT: /api/mutation update UPSERTS. The try/catch createRecord");
    console.log("         fallback in upsertBoardCard.write() never fires for a move.");
  } else if (updateAbsentThrew === REPS) {
    console.log("VERDICT: update->absent FAILS. Every move pays a doomed round trip.");
  } else {
    console.log("VERDICT: MIXED / silent no-op — read the numbers above carefully.");
  }
}

try {
  await main();
} finally {
  let cleaned = 0;
  for (const row of written) {
    try {
      await node.deleteRecord({ schemaHash: schemaHash!, keyHash: row.board, rangeKey: row.sk });
      cleaned++;
    } catch {
      // best effort; report the shortfall rather than hiding it
    }
  }
  console.log(`\ncleanup: deleted ${cleaned}/${written.length} probe rows from ${BOARD}`);
}
