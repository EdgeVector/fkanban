#!/usr/bin/env bun
/**
 * Why does writing ONE BoardCards row cold-load ~4 shards, when READING the
 * whole partition loads ~0.2?
 *
 * ## The observation this exists to explain
 *
 * `lastdb ops` on the live primary, `Top by cold shard loads`, has ranked the
 * same row first for two consecutive chief-engineer runs — it is the largest
 * read-cost entry on the whole node, and it is a WRITE:
 *
 *   | client | kind     | schema      | loads  | count | loads/call |
 *   |--------|----------|-------------|--------|-------|------------|
 *   | kanban | mutation | board_cards | 14,484 | 3,734 | **3.9**    |
 *   | kanban | query    | board_cards |  1,225 | 6,450 | 0.19       |
 *   | kanban | query    | card        |  1,385 | 33,342| 0.04       |
 *
 * Reading a 181-row partition costs a fifth of a cold load. Writing ONE row
 * into that same partition costs four. Whatever the write is loading, the read
 * of the same data is not.
 *
 * ## The answer, recorded here because the question was wrong
 *
 * A single-row BoardCards write cold-loads **nothing**. Measured per request on
 * the live primary: 76 clean single-row create/update/delete samples across
 * partition sizes 0 and 48, every one at `cold_shard_loads=0`, plus 8
 * production `client=kanban` writes in the same window, also zero.
 *
 * The 3.9 is a lifetime total over lifetime traffic. Cold loads are cache
 * MISSES: they cluster at daemon start and after a sweep across a wide, cold
 * key range, and dividing that burst by every call that came afterwards yields
 * a per-call figure describing no operation the product performs. Measured over
 * a 36-minute window on the same key: **137 mutations, 1 cold load**.
 *
 * Two things this probe ruled out along the way, both worth keeping:
 *
 *   - **It is not the write mix.** Batch writes go to `POST
 *     /api/mutations/batch` and are booked under `kind=mutation_batch`, a
 *     DIFFERENT bucket. Nothing batch does can contaminate `kind=mutation`.
 *   - **It is not partition size.** Zero at 0 rows, zero at 48, zero at 192.
 *
 * The instrument fix is in `probe-ops-delta.ts`, which computed this delta since
 * the day it was written and printed every column except this one. What remains
 * below is the per-request evidence.
 *
 * ## What this probe does NOT assume
 *
 * The obvious story is "the write scans the partition to place the row", which
 * predicts loads/call rising with partition size. That is a hypothesis, not the
 * finding, and there is a second one with the same symptom: kanban's write mix
 * is not uniform. Every `move` is a write to the destination sk AND a delete of
 * the source sk (`upsertBoardCard` -> `retireSupersededRows`), so `count=3734`
 * pools creates, in-place updates, and deletes. If deletes alone cold-load and
 * the other two do not, the pooled 3.9 is an artifact of the mix and partition
 * size explains nothing.
 *
 * So this varies BOTH, independently:
 *
 *   - partition size: 0, 48, 192 rows already present (the live default board
 *     carries ~181, so 192 brackets production)
 *   - verb: create / update-in-place / delete, issued as SINGLE node calls
 *
 * It calls `node.createRecord` / `updateRecord` / `deleteRecord` directly
 * rather than `upsertBoardCard`, because the upsert's `update-then-create-on-
 * failure` fallback can issue TWO mutations for one logical write and would
 * put a 2x in the denominator that has nothing to do with shard loads.
 *
 * A Hash-schema control (`card`) runs the same three verbs. `card` is the
 * schema whose queries cost 0.04 loads/call; if its WRITES also cost ~4, the
 * effect is about writing, not about HashRange partitions.
 *
 * ## Attribution is by construction, not by arithmetic
 *
 * `request_ops` is a node-wide counter shared with every other kanban process
 * on this machine. Previous runs guarded this by comparing count deltas and
 * hoping; run (d) still mistook a routine's 686-write repair sweep for user
 * traffic because both sent `client=kanban`.
 *
 * This probe instead uses the `opsLabel` mechanism runs (s) and (d) added, and
 * uses it as an ISOLATION primitive: two clients, one labelled
 * `kanban-probe-coldloads` for the measured calls and one labelled
 * `kanban-probe-setup` for every seed, witness and cleanup call. Setup traffic
 * therefore cannot land in the measured bucket, and no other process on this
 * host has ever sent either name, so the measured key starts at zero.
 *
 * ## Why this reads `recent` and not `top_by_cold_shard_loads`
 *
 * The obvious instrument is the aggregate table, sampled before and after. The
 * first version of this probe did that and could not be trusted, for a reason
 * worth keeping written down: **`top_by_cold_shard_loads` is top-32 across all
 * clients**, so a key below the cutoff (55 loads when this was written) is
 * ABSENT — and absent is indistinguishable from zero. A probe measuring
 * whether some writes cost zero loads cannot use an instrument that reports
 * "cheap" and "not ranked" as the same thing. Checkpoint (d) recorded this trap
 * from the other side ("absence from `lastdb ops` is not evidence a label is
 * unwired"); here it would have silently become the finding.
 *
 * `request_ops.recent` is a 256-entry ring of INDIVIDUAL requests, each
 * carrying `client`, `schema`, `kind` and its own `cold_shard_loads`. It is not
 * ranked and not truncated by cost, so a zero-load request is recorded as a
 * zero rather than dropped. Measured on the live primary the ring spans ~48s at
 * ~3.8 req/s node-wide, so this probe re-reads it every {@link CHUNK} calls —
 * well inside the window — and tracks a high-water timestamp so no request is
 * counted twice.
 *
 * The guard that remains is asymmetric, deliberately. Finding MORE
 * measured-label requests than this probe issued means another process is
 * sending the label, which would put someone else's work over this probe's
 * denominator — that aborts. Finding FEWER just means the ring rolled: the
 * survivors are still exact per-request counts, so they are kept and the
 * shortfall is reported as `missed`.
 *
 * ## Wall time is deliberately not reported
 *
 * The primary is running `0.23.3-canary.20260801`, which two `situations
 * notices` name as the cause of multi-second board writes. Absolute
 * milliseconds measured today do not transfer to a healthy binary. Cold shard
 * loads are a COUNT of work the node did, not a duration, so they survive the
 * rollback — which is why this probe reports only counts.
 *
 * Writes only to synthetic `zzcoldload-*` partitions, and deletes everything
 * it writes.
 *
 * Run: bun scripts/probe-boardcards-write-cold-loads.ts [opsPerCell] [reps]
 */
import { readConfig, schemaHashFor } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import {
  boardCardSk,
  boardCardsHash,
  listBoardCardsPartition,
  upsertBoardCardsBatch,
} from "../src/board-cards.ts";
import type { Card } from "../src/record.ts";

const OPS_PER_CELL = Number(process.argv[2] ?? 16);
const REPS = Number(process.argv[3] ?? 1);
const PARTITION_SIZES = [0, 192];
/**
 * Calls issued between `recent`-ring reads.
 *
 * Four, not eight: the node-wide rate is not steady — a routine burst can push
 * 256 entries through in well under the ~48s the ring spans at idle — and an
 * eight-call chunk lost three whole cells to rollover on the first run.
 */
const CHUNK = 4;
/** Rows per `/api/mutations/batch` request; matches BOARD_CARDS_BATCH_SIZE. */
const BATCH_SIZE = 48;
const BATCH_REQUESTS = 4;

const MEASURE_LABEL = "kanban-probe-coldloads";
const SETUP_LABEL = "kanban-probe-setup";

const cfg = readConfig();
const measure = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
  opsLabel: MEASURE_LABEL,
});
const setup = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
  opsLabel: SETUP_LABEL,
});

const boardCards = boardCardsHash(cfg);
if (!boardCards) throw new Error("no board_cards schema hash in config");
const cardSchema = schemaHashFor("card", cfg);
if (!cardSchema) throw new Error("no card schema hash in config");

const STAMP = Date.now();
const iso = new Date(STAMP).toISOString();

type RecentRow = {
  client?: string;
  kind?: string;
  schema?: string;
  cold_shard_loads?: number;
  duration_ms?: number;
  ts_ms?: number;
};

/** High-water mark so a request is never counted by two chunks. */
let seenThroughTs = 0;

/**
 * Every request the measured client has made since {@link seenThroughTs},
 * newest last, with the high-water mark advanced past them.
 *
 * Sampled through the SETUP client: a status read is `kind=status` and could
 * never land in a `kind=mutation` bucket, but keeping it off the measured label
 * keeps that client's ledger to exactly the calls being measured.
 */
async function drainRecent(schema: string, kind: string): Promise<RecentRow[]> {
  const res = await setup.rawCall("GET", "/api/status");
  const payload = ((res as { json?: unknown }).json ?? {}) as Record<string, unknown>;
  const report = (payload.status ?? payload) as Record<string, unknown>;
  const ops = report.request_ops as Record<string, unknown> | undefined;
  if (!ops) throw new Error("no request_ops on /api/status — node too old?");
  const rows = (ops.recent as RecentRow[] | undefined) ?? [];
  const mine = rows
    .filter(
      (r) =>
        r.client === MEASURE_LABEL &&
        r.kind === kind &&
        r.schema === schema &&
        (r.ts_ms ?? 0) > seenThroughTs,
    )
    .sort((a, b) => (a.ts_ms ?? 0) - (b.ts_ms ?? 0));
  for (const r of mine) seenThroughTs = Math.max(seenThroughTs, r.ts_ms ?? 0);
  return mine;
}

function makeCards(board: string, n: number, offset = 0): Card[] {
  return Array.from({ length: n }, (_, i) => ({
    slug: `${board}-r${offset + i}`,
    title: `coldload row ${offset + i}`,
    column: "todo",
    position: String(1000 + offset + i),
    board,
    body: "",
    created_at: iso,
    updated_at: iso,
  } as Card));
}

const skOf = (c: Card) => boardCardSk(c.column, c.position, c.slug);

async function seedPartition(board: string, n: number): Promise<Card[]> {
  const cards = makeCards(board, n);
  if (n > 0) {
    const failed: string[] = [];
    await upsertBoardCardsBatch(setup, cfg, cards, (c) => failed.push(c.slug));
    if (failed.length) throw new Error(`seed failed for ${failed.length} rows on ${board}`);
  }
  const rows = await listBoardCardsPartition(setup, cfg, board);
  if (rows.length !== n) {
    throw new Error(`seed witness FAILED on ${board}: wanted ${n}, read back ${rows.length}`);
  }
  return cards;
}

async function dropPartition(board: string, cards: Card[]): Promise<void> {
  for (const c of cards) {
    try {
      await setup.deleteRecord({ schemaHash: boardCards!, keyHash: board, rangeKey: skOf(c) });
    } catch {
      // best effort; synthetic partition
    }
  }
}

type Cell = {
  label: string;
  size: number | null;
  verb: string;
  calls: number;
  /** One entry per measured request, in issue order. */
  loads: number[];
  lost: number;
};

const cells: Cell[] = [];

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/**
 * Run `calls` measured node calls and record the node's own per-request
 * cold-load count for each, draining the `recent` ring every {@link CHUNK}
 * calls so none is lost to ring rollover.
 *
 * `run(i)` must issue EXACTLY ONE node mutation for index `i`. That is why the
 * callers below use `createRecord`/`updateRecord`/`deleteRecord` directly
 * rather than `upsertBoardCard`, whose update-then-create-on-failure fallback
 * can issue two mutations for one logical write.
 */
async function block(
  label: string,
  size: number | null,
  verb: string,
  schema: string,
  calls: number,
  run: (i: number) => Promise<void>,
  // `POST /api/mutations/batch` is booked under its own kind, NOT `mutation`.
  // The first version of this probe filtered on `mutation` alone and reported
  // every batch cell as LOST — the arm it was added to measure was the one arm
  // it could not see. `lastdb ops` keeps the same split, so a batch write is
  // absent from the `kind=mutation` bucket entirely: whatever that bucket's
  // loads are, they are not batch traffic.
  kind: string = "mutation",
): Promise<void> {
  const loads: number[] = [];
  let lost = 0;
  for (let start = 0; start < calls; start += CHUNK) {
    const n = Math.min(CHUNK, calls - start);
    for (let i = start; i < start + n; i++) await run(i);
    const seen = await drainRecent(schema, kind);
    if (seen.length > n) {
      // MORE requests than this probe issued means another process is sending
      // the measured label, and every number below would be someone else's work
      // divided by this probe's denominator. That is the failure this label
      // exists to make impossible, so it aborts rather than reports.
      throw new Error(
        `ATTRIBUTION FAILED for ${label}/${verb}: issued ${n} calls in this chunk, ` +
          `found ${seen.length} under client=${MEASURE_LABEL}. Another process is ` +
          `sending this label.`,
      );
    }
    // FEWER is a different thing, and not an error: the ring rolled past some
    // requests before they were read. What survives is still one exact
    // per-request measurement each — the node's own count, not an average — so
    // the honest handling is to keep them and report the shortfall, rather than
    // discard good samples. Rollover evicts OLDEST-first, which carries no
    // relationship to a request's load count, so the surviving sample is not
    // biased with respect to the thing being measured.
    //
    // The first version required exact equality and threw away whole cells on a
    // busy node — including, on one run, both batch cells, which were the arms
    // it had been extended to measure.
    lost += n - seen.length;
    for (const r of seen) loads.push(r.cold_shard_loads ?? 0);
  }

  cells.push({ label, size, verb, calls, loads, lost });
  const n = loads.length;
  const per = n > 0 ? (sum(loads) / n).toFixed(2) : "LOST";
  const nonzero = loads.filter((x) => x > 0).length;
  console.log(
    `  ${label.padEnd(14)} size=${String(size ?? "-").padStart(3)} ` +
      `${verb.padEnd(6)} sampled=${String(n).padStart(3)}/${calls} ` +
      `loads=${String(sum(loads)).padStart(5)} per_call=${per.padStart(6)} ` +
      `nonzero=${nonzero}/${n}${lost ? `  missed=${lost}` : ""}`,
  );
}

console.log(
  `probe: BoardCards write cold-shard-loads — ${OPS_PER_CELL} ops/cell, ${REPS} rep(s)\n` +
    `measured client=${MEASURE_LABEL}  setup client=${SETUP_LABEL}\n`,
);

for (let rep = 0; rep < REPS; rep++) {
  for (const size of PARTITION_SIZES) {
    const board = `zzcoldload-${STAMP}-s${size}-r${rep}`;
    console.log(`\nBoardCards (HashRange) partition of ${size} existing rows  [${board}]`);
    const seeded = await seedPartition(board, size);

    // Distinct sks, so nothing pays the same-slot deferred-put gate measured in
    // checkpoint (s) (~2.2s, delete-only, and a wall-clock effect rather than a
    // load one — but keeping the arms clean costs nothing).
    const fresh = makeCards(board, OPS_PER_CELL, 100_000);

    await block(`boardcards`, size, "create", boardCards!, fresh.length, async (i) => {
      const c = fresh[i]!;
      await measure.createRecord({
        schemaHash: boardCards!,
        keyHash: board,
        rangeKey: skOf(c),
        fields: {
          slug: c.slug,
          board,
          sk: skOf(c),
          title: c.title,
          column: c.column,
          position: c.position,
          updated_at: iso,
        },
      });
    });

    await block(`boardcards`, size, "update", boardCards!, fresh.length, async (i) => {
      const c = fresh[i]!;
      await measure.updateRecord({
        schemaHash: boardCards!,
        keyHash: board,
        rangeKey: skOf(c),
        fields: { title: `${c.title} (touched)` },
      });
    });

    await block(`boardcards`, size, "delete", boardCards!, fresh.length, async (i) => {
      const c = fresh[i]!;
      await measure.deleteRecord({ schemaHash: boardCards!, keyHash: board, rangeKey: skOf(c) });
    });

    // The batch arm, which is the whole reason the single-row numbers above are
    // not the answer on their own.
    //
    // `/api/mutations/batch` is ONE request that writes many rows, and the node
    // counts it as ONE `kind=mutation`. So a handful of batch requests can
    // contribute thousands of cold shard loads to a bucket whose denominator is
    // dominated by single-row writes — and the pooled `loads/call` that results
    // describes no operation the product actually performs.
    const batchRows = BATCH_REQUESTS * BATCH_SIZE;
    const batched = makeCards(board, batchRows, 300_000);
    await block(
      `boardcards`,
      size,
      `batch${BATCH_SIZE}`,
      boardCards!,
      BATCH_REQUESTS,
      async (i) => {
        const chunk = batched.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
        await measure.updateRecords!(
          chunk.map((c) => ({
            schemaHash: boardCards!,
            keyHash: board,
            rangeKey: skOf(c),
            fields: {
              slug: c.slug,
              board,
              sk: skOf(c),
              title: c.title,
              column: c.column,
              position: c.position,
              updated_at: iso,
            },
          })),
        );
      },
      "mutation_batch",
    );

    await block(
      `boardcards`,
      size,
      `bdel${BATCH_SIZE}`,
      boardCards!,
      BATCH_REQUESTS,
      async (i) => {
        const chunk = batched.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
        await measure.deleteRecords!(
          chunk.map((c) => ({ schemaHash: boardCards!, keyHash: board, rangeKey: skOf(c) })),
        );
      },
      "mutation_batch",
    );

    const left = await listBoardCardsPartition(setup, cfg, board);
    if (left.length !== size) {
      console.log(`  !! witness: partition holds ${left.length} rows, expected ${size}`);
    }
    await dropPartition(board, seeded);
  }

  // Hash-schema control. `card` has no range component, so there is no
  // partition to scan — if its writes cost the same, HashRange is not the
  // variable.
  console.log(`\ncard (Hash) control — no partition`);
  const ctl = makeCards(`zzcoldload-${STAMP}-ctl-r${rep}`, OPS_PER_CELL, 200_000);
  const ctlFields = (c: Card) => ({
    slug: c.slug,
    title: c.title,
    column: c.column,
    position: c.position,
    board: c.board,
    body: "",
    created_at: iso,
    updated_at: iso,
  });

  await block(`card`, null, "create", cardSchema, ctl.length, async (i) => {
    const c = ctl[i]!;
    await measure.createRecord({ schemaHash: cardSchema, keyHash: c.slug, fields: ctlFields(c) });
  });

  await block(`card`, null, "update", cardSchema, ctl.length, async (i) => {
    const c = ctl[i]!;
    await measure.updateRecord({
      schemaHash: cardSchema,
      keyHash: c.slug,
      fields: { title: `${c.title} (touched)` },
    });
  });

  await block(`card`, null, "delete", cardSchema, ctl.length, async (i) => {
    const c = ctl[i]!;
    await measure.deleteRecord({ schemaHash: cardSchema, keyHash: c.slug });
  });
}

console.log(`\n=== cold shard loads PER NODE REQUEST ===`);
const VERBS = ["create", "update", "delete", `batch${BATCH_SIZE}`, `bdel${BATCH_SIZE}`];
console.log(
  `schema       partition  ` + VERBS.map((v) => v.padStart(8)).join("  "),
);
const shown = new Set<string>();
for (const c of cells) {
  const rowKey = `${c.label}\0${c.size}`;
  if (shown.has(rowKey)) continue;
  shown.add(rowKey);
  const at = (verb: string) => {
    const hits = cells.filter((x) => x.label === c.label && x.size === c.size && x.verb === verb);
    const all = hits.flatMap((h) => h.loads);
    if (hits.length === 0) return "       -";
    if (all.length === 0) return "    LOST";
    return (sum(all) / all.length).toFixed(2).padStart(8);
  };
  console.log(
    `${c.label.padEnd(12)} ${String(c.size ?? "-").padStart(9)}  ` +
      VERBS.map(at).join("  "),
  );
}
console.log(
  `\nA batch request writes ${BATCH_SIZE} rows and the node counts it as ONE mutation, so its ` +
    `\nloads land in the same bucket as a single-row write and are divided by the same ` +
    `\ndenominator. Per ROW, divide the batch columns by ${BATCH_SIZE}.`,
);
const lostTotal = cells.reduce((a, c) => a + c.lost, 0);
if (lostTotal > 0) {
  console.log(
    `\n${lostTotal} call(s) missed: the recent ring rolled past them before they were ` +
      `read.\nThe samples that survived are exact per-request counts, not estimates.`,
  );
}
console.log(
  `\nEvery number is the node's own per-request cold_shard_loads, one sample per ` +
    `mutation, from request_ops.recent. Wall time is deliberately not reported: the ` +
    `primary is on 0.23.3-canary.20260801, which two situations notices name as the ` +
    `cause of multi-second board writes.`,
);
