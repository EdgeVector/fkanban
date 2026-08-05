#!/usr/bin/env bun
/**
 * READ-ONLY probe: does `HashRangePrefix` actually narrow NODE work on a
 * BoardCards partition, or only the wire payload?
 *
 * `listBoardCardsPartition` turns `--column todo` into
 * `HashRangePrefix { hash: board, prefix: "todo#" }` — a range-scoped read that
 * SHOULD touch only that column's rows. `listCards` with no column issues
 * `HashKey { board }` and reads the whole partition.
 *
 * If the prefix is doing real work, cost tracks ROWS RETURNED. If the node
 * scans the partition and filters afterwards, every arm costs about the same
 * and the only thing the prefix buys is a smaller response body.
 *
 * The empty-prefix arm is the discriminator, and it is the reason this probe
 * can fail rather than merely report: a filter that matches ZERO rows must be
 * ~free if the range bound is real. If it costs the same as the whole
 * partition, the scan is unconditional.
 *
 * Writes nothing.
 *
 * Run: bun scripts/probe-column-prefix-selectivity.ts [reps] [board]
 */
import { readConfig, schemaHashFor } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { BOARD_CARDS_LIST_FIELDS, boardCardsWireProjection } from "../src/board-cards.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
  opsLabel: "kanban-parity",
});

const REPS = Number(process.argv[2] ?? "5");
const BOARD = process.argv[3] ?? "default";
const schemaHash = schemaHashFor("board_cards", cfg);
const fields = boardCardsWireProjection([...BOARD_CARDS_LIST_FIELDS]);

const arms: Array<[string, unknown]> = [
  ["HashKey (whole partition)", { HashKey: BOARD }],
  ["prefix backlog#", { HashRangePrefix: { hash: BOARD, prefix: "backlog#" } }],
  ["prefix todo#", { HashRangePrefix: { hash: BOARD, prefix: "todo#" } }],
  ["prefix doing#", { HashRangePrefix: { hash: BOARD, prefix: "doing#" } }],
  ["prefix done#", { HashRangePrefix: { hash: BOARD, prefix: "done#" } }],
  ["prefix zzzznone# (0 rows)", { HashRangePrefix: { hash: BOARD, prefix: "zzzznone#" } }],
];

const read = async (filter: unknown): Promise<{ ms: number; rows: number }> => {
  const t0 = performance.now();
  const res = await node.queryAll({ schemaHash, fields, filter: filter as never });
  return { ms: performance.now() - t0, rows: res.results.length };
};

const acc = new Map<string, { ms: number[]; rows: number }>();
for (const [label] of arms) acc.set(label, { ms: [], rows: 0 });

// Warm every arm first — a first-call handshake would otherwise land entirely
// on whichever arm happens to run first and read as that arm's cost.
for (const [, f] of arms) await read(f);

// Interleaved: one rep of every arm per round, so node drift hits all arms alike.
for (let r = 0; r < REPS; r++) {
  for (const [label, f] of arms) {
    const { ms, rows } = await read(f);
    const a = acc.get(label)!;
    a.ms.push(ms);
    a.rows = rows;
  }
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

console.log(
  `\n  board=${BOARD} reps=${REPS} projection=${fields.length} fields  (label: kanban-parity)\n`,
);
console.log(
  `  ${"filter".padEnd(28)}${"rows".padStart(6)}${"median ms".padStart(11)}${"ms/row".padStart(9)}`,
);
console.log(`  ${"-".repeat(28)}${"-".repeat(6)}${"-".repeat(11)}${"-".repeat(9)}`);
for (const [label] of arms) {
  const a = acc.get(label)!;
  const m = median(a.ms);
  console.log(
    `  ${label.padEnd(28)}${String(a.rows).padStart(6)}${m.toFixed(1).padStart(11)}${
      (a.rows > 0 ? (m / a.rows).toFixed(2) : "-").padStart(9)
    }`,
  );
}

const whole = acc.get("HashKey (whole partition)")!;
const empty = acc.get("prefix zzzznone# (0 rows)")!;
const wholeMs = median(whole.ms);
const emptyMs = median(empty.ms);
const ratio = emptyMs / wholeMs;

console.log("");
if (whole.rows === 0) {
  console.log(`  INCONCLUSIVE — partition ${BOARD} is empty, so no arm can discriminate.`);
} else if (ratio < 0.25) {
  console.log(
    `  VERDICT: the range bound is REAL. A 0-row prefix costs ${emptyMs.toFixed(1)}ms vs ` +
      `${wholeMs.toFixed(1)}ms for ${whole.rows} rows (${(ratio * 100).toFixed(0)}%) — ` +
      `cost tracks rows matched, not partition size.`,
  );
} else {
  console.log(
    `  VERDICT: the prefix does NOT narrow node work. A prefix matching ZERO rows still ` +
      `costs ${emptyMs.toFixed(1)}ms against ${wholeMs.toFixed(1)}ms for the whole ` +
      `${whole.rows}-row partition (${(ratio * 100).toFixed(0)}%). The node is reading the ` +
      `partition and filtering after; the prefix buys a smaller response body only.`,
  );
}
