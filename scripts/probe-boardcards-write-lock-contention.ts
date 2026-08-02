#!/usr/bin/env bun
/**
 * Probe: is a BoardCards write slow because of the PARTITION, or because of the
 * partition LOCK — and does batching escape it?
 *
 * ## Why this exists
 *
 * `lastdb ops` on the live primary, 12h55m uptime, ranked kanban's BoardCards
 * mutation as one of the node's top consumers, and its phase sums say where the
 * time goes:
 *
 *     lock_wait=460574970us  apply=92665850us  change_record=77353589us
 *     (569 calls, 632s wall)  ->  lock_wait is 73%, ~809ms per call
 *
 * The node takes a per-`(molecule, hash)` mutex before applying a write
 * (`acquire_molecule_write_locks`). `changed_key_for` builds a `ChangedKey`
 * carrying BOTH hash and range for a HashRange field, but the lock key is built
 * from `ck.disk_hash()` — the hash HALF. So for BoardCards (HashRange,
 * hash=board) every card on one board shares one gate per field, and kanban
 * puts ~300 cards on `default`.
 *
 * That is a hypothesis, and the honest test of it is not reading more Rust: it
 * is whether writes to ONE partition serialize while writes to MANY do not.
 *
 * ## The four regimes (same N, same field payload, same node)
 *
 *   A  serial, one partition        — the baseline, no concurrency to lose
 *   B  concurrent x3, one partition — if the gate is per-partition, ~= A
 *   C  concurrent x3, N partitions  — the control: same work, no shared gate
 *   D  one /api/mutations/batch     — N writes, ONE lock acquisition
 *
 * B vs C is what isolates the LOCK from the work: identical payload and
 * identical concurrency, differing only in whether the writes share a hash.
 * A is there so "concurrency bought nothing" is measurable rather than asserted.
 * D is there because the node already exposes a batch route that takes the
 * gate once for the whole group — and kanban has never called it.
 *
 * WRITES, to synthetic `zzlockprobe-*` board partitions only. It never touches
 * `default` and never creates a Board record, so nothing appears on `board
 * list` (the leak mode of `kanban-stress.sh`, see
 * papercut-kanban-stress-boards-leak-and-portal-wt-branches-from-stale-main).
 * Every row it writes is deleted on the way out, including on failure.
 *
 * Run: bun scripts/probe-boardcards-write-lock-contention.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { boardCardSk, boardCardsHash, boardCardFieldsFromCard } from "../src/board-cards.ts";
import { mapWithConcurrency } from "../src/concurrency.ts";
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
const N = 12;
const WIDTH = 3;

/** Rows written, so cleanup reaches every one of them even after a throw. */
const written: Array<{ board: string; sk: string }> = [];

function syntheticCard(i: number, board: string): Card {
  return {
    slug: `zzlockprobe-${STAMP}-${i}`,
    title: `lock contention probe row ${i}`,
    column: "todo",
    position: String(1000 + i),
    board,
    body: "",
    created_at: new Date(STAMP).toISOString(),
    updated_at: new Date(STAMP).toISOString(),
  } as Card;
}

async function writeOne(card: Card): Promise<void> {
  const fields = boardCardFieldsFromCard(card);
  const board = String(fields.board);
  const sk = String(fields.sk);
  written.push({ board, sk });
  await node.updateRecord({ schemaHash: boardCards!, fields, keyHash: board, rangeKey: sk });
}

/**
 * Regime D — one request carrying every mutation.
 *
 * `Operation` is `#[serde(tag = "type", deny_unknown_fields)]`, so the wire
 * shape is exact: a stray or misspelled key is a 400, not a silent drop. The
 * batch route resolves each schema, then hands the whole vec to
 * `write_mutations_batch_async`, which groups by schema and acquires the
 * molecule locks ONCE for the group.
 */
async function writeBatch(cards: Card[]): Promise<void> {
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
  const res = await node.rawCall("POST", "/api/mutations/batch", ops);
  if (res.status !== 200) {
    throw new Error(`batch route ${res.status}: ${String(res.body).slice(0, 400)}`);
  }
}

async function timed(label: string, fn: () => Promise<void>): Promise<number> {
  const t0 = performance.now();
  await fn();
  const ms = performance.now() - t0;
  console.log(
    `${label.padEnd(34)} ${String(Math.round(ms)).padStart(6)}ms total   ` +
      `${String(Math.round(ms / N)).padStart(5)}ms/write`,
  );
  return ms;
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
  console.log(
    `\ncleanup: ${written.length - failed}/${written.length} probe rows removed` +
      (failed ? ` (${failed} left behind — they are on zzlockprobe-* boards, not default)` : ""),
  );
}

try {
  console.log(`BoardCards write lock contention — N=${N} rows per regime, concurrency ${WIDTH}\n`);

  const boardA = `zzlockprobe-${STAMP}-a`;
  const boardB = `zzlockprobe-${STAMP}-b`;
  const boardD = `zzlockprobe-${STAMP}-d`;

  const a = await timed("A serial, one partition", async () => {
    for (let i = 0; i < N; i++) await writeOne(syntheticCard(i, boardA));
  });

  const b = await timed(`B concurrent x${WIDTH}, one partition`, async () => {
    await mapWithConcurrency(
      Array.from({ length: N }, (_, i) => i),
      (i) => writeOne(syntheticCard(i, boardB)),
      WIDTH,
    );
  });

  const c = await timed(`C concurrent x${WIDTH}, ${N} partitions`, async () => {
    await mapWithConcurrency(
      Array.from({ length: N }, (_, i) => i),
      (i) => writeOne(syntheticCard(i, `zzlockprobe-${STAMP}-c${i}`)),
      WIDTH,
    );
  });

  const d = await timed("D one batch request, one partition", async () => {
    await writeBatch(Array.from({ length: N }, (_, i) => syntheticCard(i, boardD)));
  });

  console.log("\n--- verdict ---");
  const speedupB = a / b;
  const speedupC = a / c;
  const speedupD = a / d;
  console.log(`B (same partition)  speedup vs serial: ${speedupB.toFixed(2)}x`);
  console.log(`C (spread out)      speedup vs serial: ${speedupC.toFixed(2)}x`);
  console.log(`D (one batch)       speedup vs serial: ${speedupD.toFixed(2)}x`);
  console.log(
    "\nPartition lock is CONFIRMED if C is materially faster than B at identical\n" +
      "concurrency and payload — the only difference between them is the shared hash.",
  );
} finally {
  await cleanup();
}
