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
 * This measures the only thing that can: spine+1, once per field, in an order
 * SHUFFLED per rep so no case owns a fixed slot.
 *
 * ## Why the shuffle, and why this probe used to print every field as negative
 *
 * Until 2026-08-04 the case list was built once and iterated in the same order
 * every rep — `[(address only), (spine only), ...19 extras]` — so `(spine
 * only)`, the divisor for all 19 deltas, was measured at slot 2 on every rep
 * and the 19 fields only ever at slots 3..21. The old comment here claimed the
 * repetition "interleaved" them; repeating a fixed order does not randomize
 * position, it repeats it.
 *
 * That mattered because slot 2 is the slot immediately after the ADDRESS-ONLY
 * read, and a spine read measures ~37ms slower there than anywhere else
 * (`probe-spine-slower-than-spine-plus-one.ts`, A/B, 15 reps: spine 176ms with
 * no address read in the loop, 213ms when an address-only read precedes it).
 * Only the baseline ever paid that penalty, so it was subtracted from all 19
 * fields:
 *
 *     reported Δ  ≈  true per-field cost (+10ms)  −  baseline penalty (+37ms)
 *                 ≈  −27ms
 *
 * which is the middle of the −14ms..−67ms band this probe printed across two
 * consecutive runs, under a legend that read "Δ is what one field adds" while
 * every one of the 19 numbers said a field SUBTRACTS. The true per-field cost
 * measured by fair A/B is +10ms, and it agrees with the independent wide-vs-
 * narrow number recorded in `board-cards.ts` (1299ms@24 fields vs 416ms@7 on
 * 567 rows = +52ms/field, which is +9.2ms/field scaled to this 101-row
 * partition).
 *
 * ## Why the noise floor is printed, and why ranking is gated on it
 *
 * The per-field RANKING never reproduced even before the sign was fixed: `kind`
 * measured −17ms (4th most expensive of 19) on one run and −67ms (cheapest, by
 * a wide margin) on the very next. It could not reproduce, because an IDENTICAL
 * repeated query on this partition spans 33ms run to run
 * (`probe-per-field-baseline-position-bias.ts`) while the whole field-to-field
 * spread was 31ms. A rank ordered by a signal smaller than its own noise is an
 * ordering of noise, and this probe used to print it as a confident table.
 *
 * So the floor is now measured in-run, from replicate baseline samples, and any
 * field whose Δ does not clear it is marked `~noise` instead of ranked. Raise
 * `reps` until the floor drops below the difference you care about; do not read
 * an order out of fields that are all inside it.
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

// Replicate baseline slots. These are the SAME spine query as "(spine only)";
// their spread across a run is this probe's noise floor, measured under the
// exact conditions the field cases are measured under rather than assumed.
const BASELINE_REPLICAS = 3;
const replicaLabel = (i: number) => `(spine replica ${i + 1})`;

const cases: Case[] = [
  { label: "(address only)", fields: address },
  { label: "(spine only)", fields: spine },
  ...Array.from({ length: BASELINE_REPLICAS }, (_, i) => ({
    label: replicaLabel(i),
    fields: spine,
  })),
  ...extras.map((f) => ({ label: f, fields: [...spine, f] })),
];

// Deterministic per-rep shuffle. Seeded so a run is reproducible, rotated by
// rep so no case keeps a slot — the fixed order this probe used to iterate is
// what poisoned the baseline (see the header).
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
  for (const c of shuffledForRep(r)) {
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

// Baseline = median over the spine case AND its replicas pooled. Pooling is the
// point: one slot's draw is what used to be the divisor.
const baselineLabels = [
  "(spine only)",
  ...Array.from({ length: BASELINE_REPLICAS }, (_, i) => replicaLabel(i)),
];
const baselineMedians = baselineLabels.map((l) => median(samples.get(l)!));
const spineMs = median(baselineMedians);

// Noise floor: the spread across replicate medians of the IDENTICAL query. Any
// field Δ smaller than this is indistinguishable from re-running the baseline.
const noiseFloor = Math.max(...baselineMedians) - Math.min(...baselineMedians);

const rows = (label: string): string => {
  const set = [...rowsSeen.get(label)!].sort((a, b) => a - b);
  return set.length === 1 ? String(set[0]) : `${set[0]}-${set[set.length - 1]}`;
};

console.log(`\n== median of ${reps} reps, HashKey(${board}), spine+1 per field ==`);
console.log(`   ${"field".padEnd(16)} ${"ms".padStart(7)} ${"Δ vs spine".padStart(11)}  rows`);

const fieldCases = cases.filter((c) => !c.label.startsWith("("));
const resolved = fieldCases.filter(
  (c) => Math.abs(median(samples.get(c.label)!) - spineMs) >= noiseFloor,
);
const underFloor = fieldCases.filter(
  (c) => Math.abs(median(samples.get(c.label)!) - spineMs) < noiseFloor,
);
const byCost = (a: Case, b: Case) => median(samples.get(b.label)!) - median(samples.get(a.label)!);

// Cases that clear the floor are ranked. Cases inside it are listed but NOT
// ordered against each other — the order would be an order of noise.
const listed = [
  ...cases.filter((c) => c.label.startsWith("(")),
  ...resolved.sort(byCost),
  ...underFloor.sort((a, b) => a.label.localeCompare(b.label)),
];
for (const c of listed) {
  const ms = median(samples.get(c.label)!);
  const isField = !c.label.startsWith("(");
  const d = ms - spineMs;
  const delta = !isField
    ? ""
    : Math.abs(d) < noiseFloor
      ? "~noise"
      : `${d >= 0 ? "+" : ""}${Math.round(d)}ms`;
  console.log(`   ${c.label.padEnd(16)} ${Math.round(ms).toString().padStart(5)}ms ${delta.padStart(11)}  ${rows(c.label)}`);
}

const addressRows = [...rowsSeen.get("(address only)")!][0] ?? 0;
console.log(`\n   address-only read saw ${addressRows} rows — any field below that DROPS rows.`);
console.log(
  `   baseline ${Math.round(spineMs)}ms = median of ${baselineLabels.length} replicate spine medians ` +
    `(${baselineMedians.map((m) => Math.round(m)).join("/")}ms).`,
);
console.log(`   noise floor ${Math.round(noiseFloor)}ms = spread of those replicates — the SAME query.`);

if (resolved.length === 0) {
  console.log(
    `\n   NO field cleared the noise floor. This run cannot rank fields; it can\n` +
      `   only say every field's cost is under ${Math.round(noiseFloor)}ms. Raise reps to resolve more.`,
  );
} else {
  console.log(
    `\n   ${resolved.length}/${fieldCases.length} fields cleared the floor and are ranked; ` +
      `${underFloor.length} are marked ~noise\n   and listed alphabetically, NOT by cost.`,
  );
}
if (resolved.some((c) => median(samples.get(c.label)!) - spineMs < 0)) {
  console.log(
    `\n   WARNING: a field resolved BELOW the baseline. Adding a field cannot make\n` +
      `   a read cheaper — suspect the baseline, not the field (see header).`,
  );
}

// The floor gates individual fields, but it also judges the RUN. Fair A/B puts
// the true per-field cost near +10ms on this index; a floor above that cannot
// resolve a real effect, so anything that clears it is a tail draw, not signal.
const KNOWN_PER_FIELD_MS = 10;
if (noiseFloor > KNOWN_PER_FIELD_MS && resolved.length > 0) {
  console.log(
    `\n   CAUTION: the ${Math.round(noiseFloor)}ms floor is above the ~${KNOWN_PER_FIELD_MS}ms per-field cost measured by fair\n` +
      `   A/B (probe-spine-slower-than-spine-plus-one.ts). At this rep count a real\n` +
      `   effect CANNOT clear the floor, so the ${resolved.length} ranked above are high draws, not\n` +
      `   signal. Treat this run as "no field resolved" and raise reps until the floor\n` +
      `   is under ${KNOWN_PER_FIELD_MS}ms before believing any per-field ordering.`,
  );
}
