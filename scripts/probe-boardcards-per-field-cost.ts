#!/usr/bin/env bun
/**
 * READ-ONLY probe: what does ONE projected field cost on a BoardCards
 * whole-partition read, field by field?
 *
 * Every projection-narrowing decision in this repo so far has been argued from
 * field COUNT — "22 fields against 7". `probe-pickup-projection-width.ts`
 * breaks that model on the current board: the 7-field dep seed measures SLOWER
 * than the 14-field display set. If count were the driver that ordering is
 * impossible, so the per-field cost is not uniform and the aggregate probes
 * cannot say which field to drop.
 *
 * This measures the only thing that can: spine+1, once per field, interleaved
 * so node warmth cannot favour whichever field ran first.
 *
 * Reports rows as well as ms, because on this index the two hazards are
 * independent and a narrowing that is right for cost can be wrong for
 * correctness: a field missing from a ROW silently drops that row from the
 * result (see BOARD_CARDS_ADDRESS_FIELDS). A field that is both expensive and
 * row-dropping is a field to design away from; a field that is cheap and
 * row-dropping is only a correctness question.
 *
 * Run: bun scripts/probe-boardcards-per-field-cost.ts [reps] [board]
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { BOARD_CARDS_SPINE_FIELDS, BOARD_CARDS_ADDRESS_FIELDS, boardCardsHash } from "../src/board-cards.ts";
import { BOARD_CARDS_FIELDS } from "../src/schemas.ts";

const reps = Number(process.argv[2] ?? 7);
const board = process.argv[3] ?? "default";
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

const spine = [...BOARD_CARDS_SPINE_FIELDS];
const address = [...BOARD_CARDS_ADDRESS_FIELDS];
const extras = BOARD_CARDS_FIELDS.filter((f) => !spine.includes(f));

type Case = { label: string; fields: string[] };
const cases: Case[] = [
  { label: "(address only)", fields: address },
  { label: "(spine only)", fields: spine },
  ...extras.map((f) => ({ label: f, fields: [...spine, f] })),
];

async function timeOnce(fields: string[]): Promise<{ ms: number; rows: number }> {
  const t0 = performance.now();
  const res = await node.queryAll({
    schemaHash: hash!,
    fields,
    filter: { HashKey: board },
  });
  return { ms: performance.now() - t0, rows: res.results.length };
}

const samples = new Map<string, number[]>();
const rowsSeen = new Map<string, Set<number>>();
for (const c of cases) {
  samples.set(c.label, []);
  rowsSeen.set(c.label, new Set());
}

// One warm-up sweep, discarded: the first touch of a cold shard is a different
// measurement (~18x, per the 2026-08-02 cold-cache finding) and it would land
// entirely on whichever case happens to run first.
for (const c of cases) await timeOnce(c.fields);

for (let r = 0; r < reps; r++) {
  for (const c of cases) {
    const { ms, rows } = await timeOnce(c.fields);
    samples.get(c.label)!.push(ms);
    rowsSeen.get(c.label)!.add(rows);
  }
  process.stderr.write(`  rep ${r + 1}/${reps}\n`);
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

const spineMs = median(samples.get("(spine only)")!);
const rows = (label: string): string => {
  const set = [...rowsSeen.get(label)!].sort((a, b) => a - b);
  return set.length === 1 ? String(set[0]) : `${set[0]}-${set[set.length - 1]}`;
};

console.log(`\n== median of ${reps} reps, HashKey(${board}), spine+1 per field ==`);
console.log(`   ${"field".padEnd(16)} ${"ms".padStart(7)} ${"Δ vs spine".padStart(11)}  rows`);
const ranked = [
  ...cases.filter((c) => c.label.startsWith("(")),
  ...cases.filter((c) => !c.label.startsWith("(")).sort(
    (a, b) => median(samples.get(b.label)!) - median(samples.get(a.label)!),
  ),
];
for (const c of ranked) {
  const ms = median(samples.get(c.label)!);
  const delta = c.label.startsWith("(") ? "" : `${ms - spineMs >= 0 ? "+" : ""}${Math.round(ms - spineMs)}ms`;
  console.log(`   ${c.label.padEnd(16)} ${Math.round(ms).toString().padStart(5)}ms ${delta.padStart(11)}  ${rows(c.label)}`);
}

const addressRows = [...rowsSeen.get("(address only)")!][0] ?? 0;
console.log(`\n   address-only read saw ${addressRows} rows — any field below that DROPS rows.`);
console.log(`   spine median ${Math.round(spineMs)}ms is the fixed floor; Δ is what one field adds.`);
