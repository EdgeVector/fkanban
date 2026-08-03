#!/usr/bin/env bun
/**
 * Probe: after a BoardCards write returns 200, when is the row READABLE?
 *
 * ## Why this exists
 *
 * `probe-move-doomed-update.ts` found that an `update` against an absent row
 * returns success but the row was visible to an immediately-following
 * partition query only 3 times in 5. Two explanations fit that observation and
 * they demand opposite responses:
 *
 *   (a) the write was LOST — a 200 that stored nothing. P0.
 *   (b) the write is DURABLE but not yet VISIBLE to a query — read-after-write
 *       lag. Not data loss, but a correctness hazard for every kanban path
 *       that writes and then reads back to decide what to do next.
 *
 * "It came back 200" distinguishes neither. This one does: on a miss it keeps
 * re-reading, so a row that appears at attempt 4 is lag and a row that never
 * appears is loss.
 *
 * It reads back BOTH ways, because they are not the same question on this
 * schema:
 *   - partition query (`HashKey`) — what every kanban list/heal path uses
 *   - point read (`HashKey` + `RangeKey`) — the exact key just written
 * A row visible to a point read but not the partition query is an INDEX lag,
 * which is a different fix from a storage lag.
 *
 * WRITES synthetic `zzvis-*` rows to a synthetic board partition only. Never
 * touches `default`, never creates a Board record. All rows deleted on the way
 * out, including on failure.
 *
 * Run: bun scripts/probe-write-readback-visibility.ts [reps]
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { boardCardsHash, boardCardFieldsFromCard } from "../src/board-cards.ts";
import type { Card } from "../src/record.ts";

const REPS = Number(process.argv[2] ?? 8);
const MAX_POLLS = 25;
const POLL_MS = 200;

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const schemaHash = boardCardsHash(cfg);
if (!schemaHash) throw new Error("no board_cards schema hash in config");

const STAMP = Date.now();
const BOARD = `zzvis-${STAMP}`;
const written: Array<{ board: string; sk: string }> = [];

function syntheticCard(i: number): Card {
  return {
    slug: `zzvis-${STAMP}-${i}`,
    title: `visibility probe row ${i}`,
    column: "todo",
    position: String(1000 + i),
    board: BOARD,
    body: "",
    created_at: new Date(STAMP).toISOString(),
    updated_at: new Date(STAMP).toISOString(),
  } as Card;
}

async function inPartition(slug: string): Promise<boolean> {
  const res = await node.queryAll({
    schemaHash: schemaHash!,
    fields: ["slug", "column", "board"],
    filter: { HashKey: BOARD },
  });
  return res.results.some((r) => String((r.fields ?? {}).slug ?? "") === slug);
}

async function atPoint(sk: string, slug: string): Promise<boolean> {
  const res = await node.queryAll({
    schemaHash: schemaHash!,
    fields: ["slug", "column", "board"],
    filter: { HashRangePrefix: { hash: BOARD, prefix: sk } } as never,
  });
  return res.results.some((r) => String((r.fields ?? {}).slug ?? "") === slug);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Row = {
  i: number;
  writeMs: number;
  firstSeenPoll: number | null;
  firstSeenMs: number | null;
  pointSeenFirst: boolean;
};

async function main() {
  console.log(`board partition: ${BOARD} (synthetic)   reps=${REPS} poll=${POLL_MS}ms x${MAX_POLLS}\n`);
  const rows: Row[] = [];

  for (let i = 0; i < REPS; i++) {
    const card = syntheticCard(i);
    const fields = boardCardFieldsFromCard(card);
    const sk = String(fields.sk);
    written.push({ board: BOARD, sk });

    const t0 = performance.now();
    await node.updateRecord({ schemaHash: schemaHash!, fields, keyHash: BOARD, rangeKey: sk });
    const writeMs = performance.now() - t0;

    const tAck = performance.now();
    let firstSeenPoll: number | null = null;
    let firstSeenMs: number | null = null;
    let pointSeenFirst = false;

    for (let p = 1; p <= MAX_POLLS; p++) {
      const [part, point] = await Promise.all([inPartition(card.slug), atPoint(sk, card.slug)]);
      if (part) {
        firstSeenPoll = p;
        firstSeenMs = performance.now() - tAck;
        pointSeenFirst = point && p === 1 && !part ? true : pointSeenFirst;
        break;
      }
      if (point) pointSeenFirst = true;
      await sleep(POLL_MS);
    }
    rows.push({ i, writeMs, firstSeenPoll, firstSeenMs, pointSeenFirst });
    const seen = firstSeenPoll === null
      ? "NEVER"
      : `poll ${firstSeenPoll} (+${firstSeenMs!.toFixed(0)}ms)`;
    console.log(
      `row ${String(i).padStart(2)}  write=${writeMs.toFixed(0).padStart(5)}ms  visible-in-partition: ${seen}` +
        (pointSeenFirst ? "   [point read saw it FIRST]" : ""),
    );
  }

  const immediate = rows.filter((r) => r.firstSeenPoll === 1).length;
  const lagged = rows.filter((r) => r.firstSeenPoll !== null && r.firstSeenPoll > 1);
  const never = rows.filter((r) => r.firstSeenPoll === null).length;
  const pointFirst = rows.filter((r) => r.pointSeenFirst).length;

  console.log("");
  console.log(`visible on first read : ${immediate}/${REPS}`);
  console.log(`visible only after lag: ${lagged.length}/${REPS}` +
    (lagged.length ? `  (max +${Math.max(...lagged.map((r) => r.firstSeenMs!)).toFixed(0)}ms)` : ""));
  console.log(`NEVER visible         : ${never}/${REPS}`);
  console.log(`point read led index  : ${pointFirst}/${REPS}`);
  console.log("");
  if (never > 0) {
    console.log("VERDICT: LOST WRITES — a 200 that stored nothing. P0.");
  } else if (lagged.length > 0) {
    console.log("VERDICT: READ-AFTER-WRITE LAG — writes are durable but a query");
    console.log("         issued right after the ack can miss them. Any kanban path");
    console.log("         that writes then re-reads to decide is racing the index.");
  } else {
    console.log("VERDICT: read-your-write held on every rep in this sample.");
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
      // best effort
    }
  }
  console.log(`\ncleanup: deleted ${cleaned}/${written.length} probe rows from ${BOARD}`);
}
