#!/usr/bin/env bun
/**
 * READ-ONLY probe: what does a board list read actually cost, per ROW and per
 * FIELD — and is the BoardCards projection index still cheaper per row than the
 * Card point reads it replaced?
 *
 * ## Why re-measure something already concluded
 *
 * Run (o) concluded "the index is 10x cheaper per row than a Card point read"
 * and that retired per-call list cost as a target. That conclusion was derived
 * BEFORE the 2026-08-04 floor collapse, which did not hit the two read classes
 * evenly — `src/concurrency.ts` records point reads falling ~400x and partition
 * reads ~5x over the same upgrade. A ratio whose two sides moved by 80x
 * relative to each other does not survive unre-derived, and nothing has
 * re-derived it.
 *
 * ## Arms
 *
 *   - partition read at several PROJECTION WIDTHS, same rows — isolates cost
 *     per field from cost per row.
 *   - N Card point reads for the SAME slugs the partition returned, pooled at
 *     the production width — the honest comparison, because it is the work the
 *     index exists to avoid.
 *
 * Both run in ONE process against the same warm socket, interleaved, so the
 * per-process connection cost that produced the retired ~190ms floor is
 * amortized away from both arms alike rather than landing on whichever runs
 * first.
 *
 * Writes nothing.
 *
 * Run: bun scripts/probe-list-read-cost-axes.ts [reps] [board]
 */
import { readConfig, schemaHashFor } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import {
  BOARD_CARDS_ADDRESS_FIELDS,
  BOARD_CARDS_LIST_FIELDS,
  boardCardsWireProjection,
  cardFromBoardCardRow,
} from "../src/board-cards.ts";
import { POINT_READ_CONCURRENCY, mapWithConcurrency } from "../src/concurrency.ts";
import { fieldsFor } from "../src/schemas.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
  opsLabel: "kanban-parity",
});

const REPS = Number(process.argv[2] ?? "5");
const BOARD = process.argv[3] ?? "default";
const bcHash = schemaHashFor("board_cards", cfg);
const cardHash = schemaHashFor("card", cfg);

const partitionFilter = { HashKey: BOARD } as never;

const widths: Array<[string, string[]]> = [
  ["address only", boardCardsWireProjection([...BOARD_CARDS_ADDRESS_FIELDS])],
  ["list fields", boardCardsWireProjection([...BOARD_CARDS_LIST_FIELDS])],
];

const readPartition = async (fields: string[]): Promise<{ ms: number; rows: number; slugs: string[] }> => {
  const t0 = performance.now();
  const res = await node.queryAll({ schemaHash: bcHash, fields, filter: partitionFilter });
  const ms = performance.now() - t0;
  // `boardCardsWireProjection` strips the key-derived fields, so the slug lives
  // on the row KEY, not in `fields` — decode it the way the product does.
  const slugs = res.results
    .map((r) => cardFromBoardCardRow(r, BOARD).slug)
    .filter((s) => s.length > 0);
  return { ms, rows: res.results.length, slugs };
};

// Establish the row set once, and warm the socket for BOTH arms.
const seed = await readPartition(widths[1]![1]);
if (seed.slugs.length === 0) {
  console.log(`\n  INCONCLUSIVE — board ${BOARD} returned no rows with a slug; nothing to compare.\n`);
  process.exit(0);
}
const slugs = seed.slugs;
const cardFields = fieldsFor("card").filter((f) => f !== "body");

const readPoints = async (): Promise<{ ms: number; rows: number }> => {
  const t0 = performance.now();
  const out = await mapWithConcurrency(
    slugs,
    async (slug) => {
      const res = await node.queryAll({
        schemaHash: cardHash,
        fields: cardFields,
        filter: { HashKey: slug } as never,
      });
      return res.results.length;
    },
    POINT_READ_CONCURRENCY,
  );
  return { ms: performance.now() - t0, rows: out.reduce((a, b) => a + b, 0) };
};

// Warm every arm before timing any of them.
for (const [, f] of widths) await readPartition(f);
await readPoints();

const partAcc = new Map<string, number[]>();
for (const [label] of widths) partAcc.set(label, []);
const pointAcc: number[] = [];
let pointRows = 0;

for (let r = 0; r < REPS; r++) {
  for (const [label, f] of widths) partAcc.get(label)!.push((await readPartition(f)).ms);
  const p = await readPoints();
  pointAcc.push(p.ms);
  pointRows = p.rows;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const rows = seed.rows;

console.log(`\n  board=${BOARD} rows=${rows} reps=${REPS} point-read width=${POINT_READ_CONCURRENCY}\n`);
console.log(
  `  ${"arm".padEnd(34)}${"fields".padStart(7)}${"median ms".padStart(11)}${"ms/row".padStart(9)}`,
);
console.log(`  ${"-".repeat(34)}${"-".repeat(7)}${"-".repeat(11)}${"-".repeat(9)}`);
for (const [label, f] of widths) {
  const m = median(partAcc.get(label)!);
  console.log(
    `  ${`BoardCards partition, ${label}`.padEnd(34)}${String(f.length).padStart(7)}${
      m.toFixed(1).padStart(11)
    }${(m / rows).toFixed(2).padStart(9)}`,
  );
}
const pm = median(pointAcc);
console.log(
  `  ${`${slugs.length} Card point reads (pooled)`.padEnd(34)}${String(cardFields.length).padStart(7)}${
    pm.toFixed(1).padStart(11)
  }${(pm / Math.max(1, slugs.length)).toFixed(2).padStart(9)}`,
);

const narrow = median(partAcc.get(widths[0]![0])!);
const wide = median(partAcc.get(widths[1]![0])!);
const nf = widths[0]![1].length;
const wf = widths[1]![1].length;

console.log("");
console.log(
  `  Per-field slope: ${(wide - narrow).toFixed(1)}ms for ${wf - nf} extra fields ` +
    `= ${((wide - narrow) / Math.max(1, wf - nf)).toFixed(2)}ms/field over ${rows} rows ` +
    `(${(((wide - narrow) / Math.max(1, wf - nf)) / rows).toFixed(4)}ms per row-field).`,
);

const ratio = pm / wide;
console.log("");
if (pointRows === 0) {
  console.log(`  INCONCLUSIVE — the point-read arm returned 0 rows; the comparison has no witness.`);
} else if (ratio > 1.5) {
  console.log(
    `  VERDICT: the index still WINS. ${slugs.length} point reads cost ${pm.toFixed(1)}ms vs ` +
      `${wide.toFixed(1)}ms for the one partition read (${ratio.toFixed(1)}x). Run (o)'s ` +
      `conclusion survives the floor collapse.`,
  );
} else if (ratio < 0.67) {
  console.log(
    `  VERDICT: the ratio has INVERTED. ${slugs.length} pooled point reads cost ` +
      `${pm.toFixed(1)}ms against ${wide.toFixed(1)}ms for the single partition read ` +
      `(${ratio.toFixed(2)}x) — the projection index is now the MORE expensive way to ` +
      `read a board. Run (o)'s "10x cheaper per row" no longer holds.`,
  );
} else {
  console.log(
    `  VERDICT: too close to call — ${pm.toFixed(1)}ms vs ${wide.toFixed(1)}ms ` +
      `(${ratio.toFixed(2)}x). Neither arm is clearly cheaper on this partition today.`,
  );
}
