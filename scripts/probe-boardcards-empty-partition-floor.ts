#!/usr/bin/env bun
/**
 * READ-ONLY probe: what does a BoardCards read cost when it matches NOTHING?
 *
 * Every cost model in this repo so far has been built on the `default`
 * partition, and every one of them has had to fight the same instrument
 * problem: an identical repeated query there spans ~33ms run to run
 * (`probe-per-field-baseline-position-bias.ts`) while the whole field-to-field
 * spread being measured was ~31ms. Four runs of per-field advice were derived
 * from a signal smaller than its own noise, and run (n) had to downgrade
 * `probe-boardcards-per-field-cost.ts` to "cannot rank, only bound".
 *
 * The fix is not more replicates. It is a better bench.
 *
 * ## Why an empty partition is the clean bench
 *
 * On a 101-row partition, `hydrate` is 99.3% of the request and its variance is
 * the noise floor. On a partition with ZERO rows there is nothing to hydrate,
 * so whatever time remains is by construction the part of the cost that does
 * not depend on rows — the floor. Measuring the floor directly removes the
 * dominant noise term instead of averaging over it.
 *
 * This matters because the floor is not a rounding error. `probe-command-reads`
 * (2026-08-04) recorded, against a genuinely empty board:
 *
 *     board_cards HashKey(agent-dogfood-scratch) fields= 3 rows=0    35ms
 *     board_cards HashKey(agent-dogfood-scratch) fields=11 rows=0   128ms
 *     board_cards HashKey(agent-dogfood-scratch) fields=19 rows=0   204ms
 *
 * Three points, ~10.6ms per field, on a query that returned no rows at all.
 * If that holds, the per-field cost is NOT paid per row — it is paid per
 * REQUEST, and a projection is expensive before it has matched anything.
 *
 * ## What this probe can and cannot conclude
 *
 * It measures a synthetic partition that has never been written, so it isolates
 * the floor and nothing else. It deliberately does NOT claim the field cost on
 * a populated partition is the same number — a per-row-per-field term can exist
 * on top of this and would not show up here. What it establishes is a LOWER
 * BOUND that every board_cards read pays, including the ones that match zero
 * rows, which the fan-out across boards issues constantly.
 *
 * Anti-bias measures, carried over from the run-(n) repair of the per-field
 * probe — they are what makes this readable at all:
 *   - order SHUFFLED per rep, seeded, so no field count owns a time slot;
 *   - replicate slots of one identical case, so the noise floor is measured
 *     in-run under the same conditions rather than assumed;
 *   - a slope reported with its own noise floor beside it, and refused out loud
 *     if the span it is fitted over does not clear that floor.
 *
 * Run: bun scripts/probe-boardcards-empty-partition-floor.ts [reps] [board]
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { boardCardsHash } from "../src/board-cards.ts";
import { BOARD_CARDS_FIELDS } from "../src/schemas.ts";

const reps = Number(process.argv[2] ?? 9);
// A board slug that has never been written. Nothing here writes; an absent
// partition answers every projection with zero rows, which is the point.
const board = process.argv[3] ?? "zzfloorprobe-does-not-exist";
const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const hash = boardCardsHash(cfg);
if (!hash) {
  console.error("no board_cards schema hash in config");
  process.exit(1);
}

const all = [...BOARD_CARDS_FIELDS];
// Field COUNTS to sweep, as prefixes of the declared field list. Which specific
// fields land in a prefix is irrelevant on an empty partition — no row is
// hydrated, so no field can contribute row-dependent work. Count is the whole
// independent variable here, which is exactly why this bench can measure it and
// the populated one could not.
const COUNTS = [1, 2, 3, 5, 8, 11, 15, 19, all.length].filter(
  (n, i, a) => n <= all.length && a.indexOf(n) === i,
);

type Case = { label: string; fields: string[]; n: number };

// Replicate slots of ONE identical case. Their spread is this probe's noise
// floor, measured in-run. Placed at a mid-range count so the floor is not
// sampled at an extreme of the sweep.
const REPLICAS = 3;
const REPLICA_N = COUNTS[Math.floor(COUNTS.length / 2)]!;

const cases: Case[] = [
  ...COUNTS.map((n) => ({ label: `${n} fields`, fields: all.slice(0, n), n })),
  ...Array.from({ length: REPLICAS }, (_, i) => ({
    label: `(replica ${i + 1} @ ${REPLICA_N})`,
    fields: all.slice(0, REPLICA_N),
    n: REPLICA_N,
  })),
];

function shuffledForRep(rep: number): Case[] {
  const out = [...cases];
  let seed = (rep + 1) * 0x9e3779b1;
  const next = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

async function timeOnce(fields: string[]): Promise<{ ms: number; rows: number }> {
  const t0 = performance.now();
  const res = await node.queryAll({
    schemaHash: hash!,
    fields,
    filter: { HashKey: board },
  });
  return { ms: performance.now() - t0, rows: res.results.length };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

const samples = new Map<string, number[]>();
const rowsSeen = new Set<number>();
for (const c of cases) samples.set(c.label, []);

// Warm-up sweep, discarded: the first touch of a cold shard is a different
// measurement and would land entirely on whichever case ran first.
for (const c of cases) await timeOnce(c.fields);

for (let r = 0; r < reps; r++) {
  for (const c of shuffledForRep(r)) {
    const { ms, rows } = await timeOnce(c.fields);
    samples.get(c.label)!.push(ms);
    rowsSeen.add(rows);
  }
}

console.log(`\nBoardCards EMPTY-partition floor — hash=${hash.slice(0, 8)} board=${board} reps=${reps}`);

// The load-bearing precondition. If this partition ever returns a row the whole
// premise is void, so it is asserted rather than assumed.
if (rowsSeen.size !== 1 || !rowsSeen.has(0)) {
  console.log(`\n  ABORT — partition is not empty (rows seen: ${[...rowsSeen].join(",")}).`);
  console.log(`  This probe measures the zero-row floor; a populated partition`);
  console.log(`  makes every number below a mix of floor and hydrate. Pick an`);
  console.log(`  unused board slug.`);
  process.exit(1);
}
console.log(`  every query returned 0 rows — measuring floor only\n`);

const replicaMedians = Array.from({ length: REPLICAS }, (_, i) =>
  median(samples.get(`(replica ${i + 1} @ ${REPLICA_N})`)!),
);
const sweptAtReplicaN = median(samples.get(`${REPLICA_N} fields`)!);
const allAtReplicaN = [...replicaMedians, sweptAtReplicaN];
const floor = Math.max(...allAtReplicaN) - Math.min(...allAtReplicaN);

console.log("  fields   median    min    max   n");
for (const n of COUNTS) {
  const xs = samples.get(`${n} fields`)!;
  console.log(
    `  ${String(n).padStart(6)}   ${median(xs).toFixed(0).padStart(6)}ms ` +
      `${Math.min(...xs).toFixed(0).padStart(6)} ${Math.max(...xs).toFixed(0).padStart(6)}   ${xs.length}`,
  );
}

console.log(
  `\n  noise floor (spread of ${allAtReplicaN.length} identical ${REPLICA_N}-field cases): ${floor.toFixed(0)}ms`,
);

// Least-squares slope over the swept counts.
const pts = COUNTS.map((n) => ({ x: n, y: median(samples.get(`${n} fields`)!) }));
const mx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
const my = pts.reduce((a, p) => a + p.y, 0) / pts.length;
const slope =
  pts.reduce((a, p) => a + (p.x - mx) * (p.y - my), 0) /
  pts.reduce((a, p) => a + (p.x - mx) ** 2, 0);
const intercept = my - slope * mx;
const span = Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y));

console.log(`  fit: ${intercept.toFixed(0)}ms + ${slope.toFixed(1)}ms/field   (span ${span.toFixed(0)}ms)`);

// How many times the FITTED EFFECT must clear the noise floor before a slope is
// claimed. Two things this deliberately does not do, both of which this probe
// did in an earlier draft of this same run:
//
//   - It does not test max-minus-min. That span is jitter when there is no
//     trend, so a quiet node (small floor) and a couple of stray samples clear
//     any ratio you pick while the fitted slope is ~0. This probe printed
//     "RESOLVED ... 3.2x" over a slope of -0.1ms/field that way.
//   - It does not report a NEGATIVE slope as a cost. A projected field cannot
//     make a query cheaper; a downward fit is proof the effect is unresolved,
//     not a discovery. `probe-boardcards-per-field-cost.ts` printed negative
//     per-field costs as data for four runs, and the rule earned there is
//     applied here rather than re-learned.
const RESOLVE_MULTIPLE = 3;
const range = COUNTS[COUNTS.length - 1]! - COUNTS[0]!;
const effect = slope * range;

console.log("");
if (slope <= 0) {
  console.log(
    `  WARNING — the fit slopes DOWN (${slope.toFixed(2)}ms/field). A projected field cannot make`,
  );
  console.log(
    `  a query cheaper, so this is noise around a zero effect, not a measurement.`,
  );
  console.log(
    `  Per-field cost on an empty partition is below this bench's resolution:`,
  );
  console.log(
    `  < ~${(Math.max(floor, Math.abs(effect)) / range).toFixed(2)}ms/field, i.e. indistinguishable from zero.`,
  );
} else if (effect >= floor * RESOLVE_MULTIPLE) {
  console.log(
    `  RESOLVED — fitted effect ${effect.toFixed(0)}ms over ${COUNTS[0]}..${COUNTS[COUNTS.length - 1]} fields clears the`,
  );
  console.log(
    `  ${floor.toFixed(0)}ms noise floor by ${(effect / floor).toFixed(1)}x (>= ${RESOLVE_MULTIPLE}x).`,
  );
  console.log(
    `  A board_cards read that matches NOTHING costs ~${intercept.toFixed(0)}ms + ~${slope.toFixed(2)}ms per projected field.`,
  );
} else {
  // The useful answer here is an UPPER BOUND, not "unknown". Whatever per-field
  // cost could hide inside one noise floor across the swept range bounds it,
  // which is a stronger and more honest statement than a slope nobody should
  // trust.
  console.log(
    `  NO PER-FIELD COST RESOLVED — fitted effect ${effect.toFixed(0)}ms over ${COUNTS[0]}..${COUNTS[COUNTS.length - 1]} fields does`,
  );
  console.log(
    `  not clear ${RESOLVE_MULTIPLE}x the ${floor.toFixed(0)}ms noise floor. Do not read ${slope.toFixed(2)}ms/field as a cost.`,
  );
  console.log(
    `  What IS established: per-field cost on an empty partition is < ~${(Math.max(floor * RESOLVE_MULTIPLE, effect) / range).toFixed(2)}ms/field,`,
  );
  console.log(`  i.e. indistinguishable from zero at this bench's resolution.`);
}
console.log(
  `\n  Floor for ANY board_cards read that matches nothing: ~${median(samples.get(`${COUNTS[COUNTS.length - 1]} fields`)!).toFixed(0)}ms client-side,`,
);
console.log(
  `  of which ~183ms is the node-wide per-request transport latency that every`,
);
console.log(
  `  client pays (papercut-lastdb-183ms-fixed-latency-per-socket-request-on-an-idle-node).`,
);
