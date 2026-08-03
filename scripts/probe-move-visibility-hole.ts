#!/usr/bin/env bun
/**
 * Probe: during a `move`, is the card EVER absent from the board?
 *
 * ## The claim under test
 *
 * `upsertBoardCard`'s longest comment defends its write-then-delete ordering:
 *
 *   > Writing first makes the in-between state "the card has two rows" — and
 *   > that state is one this codebase already handles on purpose ...
 *   > A failed destination write now leaves the card exactly where it was
 *   > instead of nowhere.
 *
 * That reasoning assumes the destination row is READABLE once its write acks.
 * `probe-write-readback-visibility.ts` measured that it is not: on this node a
 * BoardCards write is invisible to both a partition query and a point read for
 * ~400-750ms after the ack. So the ordering argument has an unexamined step —
 * the source delete is issued during the destination row's invisibility window.
 *
 * If the delete's own visibility lag is shorter than the write's remaining lag,
 * the board passes through a state where NEITHER row is readable: the card is
 * off the board entirely. That is precisely the failure the ordering was chosen
 * to prevent, and it would be invisible to every test that checks the end state.
 *
 * ## Method
 *
 * A poller reads the partition continuously while a real move runs through the
 * real `upsertBoardCard`. It records, per sample, how many rows carry the slug:
 * 1 = normal, 2 = the intended transient duplicate, **0 = the hole**.
 *
 * The poller runs concurrently with the move rather than between its steps, so
 * it observes what a real `kanban list` racing a real `kanban move` would see.
 *
 * WRITES synthetic `zzhole-*` rows to a synthetic board partition only. Never
 * touches `default`, never creates a Board record. Rows deleted on the way out.
 *
 * Run: bun scripts/probe-move-visibility-hole.ts [moves]
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { boardCardsHash, boardCardSk, upsertBoardCard } from "../src/board-cards.ts";
import type { Card } from "../src/record.ts";

const MOVES = Number(process.argv[2] ?? 4);
const POLL_MS = 60;

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const schemaHash = boardCardsHash(cfg);
if (!schemaHash) throw new Error("no board_cards schema hash in config");

const STAMP = Date.now();
const BOARD = `zzhole-${STAMP}`;
const written = new Set<string>();

function card(i: number, column: string, position: string): Card {
  return {
    slug: `zzhole-${STAMP}-${i}`,
    title: `move-hole probe ${i}`,
    column,
    position,
    board: BOARD,
    body: "",
    created_at: new Date(STAMP).toISOString(),
    updated_at: new Date().toISOString(),
  } as Card;
}

async function rowsFor(slug: string): Promise<number> {
  const res = await node.queryAll({
    schemaHash: schemaHash!,
    fields: ["slug", "column", "board"],
    filter: { HashKey: BOARD },
  });
  return res.results.filter((r) => String((r.fields ?? {}).slug ?? "") === slug).length;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function settle(slug: string, want: number, budgetMs = 8000): Promise<boolean> {
  const t0 = performance.now();
  while (performance.now() - t0 < budgetMs) {
    if ((await rowsFor(slug)) === want) return true;
    await sleep(POLL_MS);
  }
  return false;
}

async function main() {
  console.log(`board partition: ${BOARD} (synthetic)   moves=${MOVES} poll=${POLL_MS}ms\n`);

  let holes = 0;
  let dupesSeen = 0;
  let samplesTotal = 0;

  for (let i = 0; i < MOVES; i++) {
    const src = card(i, "todo", "1000");
    const dst = card(i, "doing", "2000");
    written.add(boardCardSk(src.column, src.position, src.slug));
    written.add(boardCardSk(dst.column, dst.position, dst.slug));

    // Seed the source row and wait until it is genuinely readable, so the
    // move starts from a state a real board would be in.
    await upsertBoardCard(node, cfg, src, null, { skipOrphanPurge: true });
    if (!(await settle(src.slug, 1))) {
      console.log(`row ${i}: source never became readable — skipping this rep`);
      continue;
    }

    // Poll the partition while the move runs.
    let stop = false;
    const seen: number[] = [];
    const poller = (async () => {
      while (!stop) {
        try {
          seen.push(await rowsFor(src.slug));
        } catch {
          // a failed read is not evidence about the hole; drop the sample
        }
      }
    })();

    const t0 = performance.now();
    await upsertBoardCard(node, cfg, dst, src);
    const moveMs = performance.now() - t0;

    // Keep watching past the ack — the hole, if any, opens during the
    // destination row's post-ack invisibility window.
    await sleep(1200);
    stop = true;
    await poller;

    const zero = seen.filter((n) => n === 0).length;
    const two = seen.filter((n) => n === 2).length;
    holes += zero;
    dupesSeen += two;
    samplesTotal += seen.length;
    console.log(
      `move ${String(i).padStart(2)}  ${moveMs.toFixed(0).padStart(5)}ms  samples=${String(seen.length).padStart(3)}  ` +
        `rows=0: ${String(zero).padStart(3)}  rows=1: ${String(seen.filter((n) => n === 1).length).padStart(3)}  rows=2: ${String(two).padStart(3)}` +
        (zero > 0 ? "   <-- HOLE" : ""),
    );

    await settle(dst.slug, 1);
  }

  console.log("");
  console.log(`samples total          : ${samplesTotal}`);
  console.log(`samples with ZERO rows : ${holes}`);
  console.log(`samples with TWO rows  : ${dupesSeen}  (the intended transient duplicate)`);
  console.log("");
  if (holes > 0) {
    console.log("VERDICT: THE HOLE IS REAL. A concurrent reader sees the card on NO");
    console.log("         board mid-move — the exact state write-then-delete ordering");
    console.log("         was chosen to prevent.");
  } else {
    console.log("VERDICT: no hole observed. The write-then-delete ordering holds");
    console.log("         under the measured index lag.");
  }
}

try {
  await main();
} finally {
  let cleaned = 0;
  for (const sk of written) {
    try {
      await node.deleteRecord({ schemaHash: schemaHash!, keyHash: BOARD, rangeKey: sk });
      cleaned++;
    } catch {
      // best effort
    }
  }
  console.log(`\ncleanup: deleted ${cleaned}/${written.size} probe rows from ${BOARD}`);
}
