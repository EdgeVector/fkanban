#!/usr/bin/env bun
/**
 * READ-ONLY probe: is `probe-boardcards-per-field-cost.ts`'s baseline a
 * measurement of the SPINE, or a measurement of its POSITION in the rep?
 *
 * That probe reports every one of the 19 fields as NEGATIVE against its
 * spine baseline — adding a field makes the read faster than not adding it.
 * That ordering is impossible if the number it prints is per-field work, so
 * one of the two operands is wrong.
 *
 * Its `cases` array is built once and iterated in the SAME order every rep:
 *
 *     [ (address only), (spine only), ...19 extras ]
 *
 * so `(spine only)` — the divisor for all 19 deltas — is measured at slot 2 of
 * 21 on every single rep, and all 19 fields are measured at slots 3..21. The
 * comment says "interleaved so node warmth cannot favour whichever field ran
 * first", but interleaving repetitions of a fixed order does not randomize
 * position; it repeats it.
 *
 * This probe changes ONE variable: it sends the IDENTICAL spine projection at
 * several positions in the rep and at nothing else. Every sample is the same
 * query, so any spread across slots is position, not fields.
 *
 * Read this against the ONE alternative that would exonerate the baseline: if
 * every slot measures the same, the negative deltas are real and the spine is
 * genuinely slower than spine+1 (which would be its own finding).
 *
 * Run: bun scripts/probe-per-field-baseline-position-bias.ts [reps] [board]
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { BOARD_CARDS_SPINE_FIELDS, boardCardsHash } from "../src/board-cards.ts";
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
const extras = BOARD_CARDS_FIELDS.filter((f) => !spine.includes(f));

// Rebuild the SHAPE of the real probe's rep: 21 slots. The difference is that
// the slots we measure are all the same query. Filler slots keep the rep the
// same length and the same mix of work, so a slot index here means what the
// same slot index means there.
const PROBE_SLOTS = 2 + extras.length;
const MEASURED_SLOTS = [1, 2, 3, 6, 11, 16, PROBE_SLOTS].filter(
  (s, i, a) => s <= PROBE_SLOTS && a.indexOf(s) === i,
);

async function timeOnce(fields: string[]): Promise<number> {
  const t0 = performance.now();
  await node.queryAll({ schemaHash: hash!, fields, filter: { HashKey: board } });
  return performance.now() - t0;
}

const samples = new Map<number, number[]>();
for (const s of MEASURED_SLOTS) samples.set(s, []);

// Same discarded warm-up the real probe does.
for (let i = 0; i < PROBE_SLOTS; i++) await timeOnce(spine);

for (let r = 0; r < reps; r++) {
  for (let slot = 1; slot <= PROBE_SLOTS; slot++) {
    // Filler slots run a spine+1 read so the rep does the same amount and kind
    // of work as the real probe's rep; only measured slots are recorded.
    const measured = samples.has(slot);
    const fields = measured ? spine : [...spine, extras[slot % extras.length]!];
    const ms = await timeOnce(fields);
    if (measured) samples.get(slot)!.push(ms);
  }
  process.stderr.write(`  rep ${r + 1}/${reps}\n`);
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

console.log(
  `\n== IDENTICAL spine projection at ${MEASURED_SLOTS.length} slots, median of ${reps} reps, HashKey(${board}) ==`,
);
console.log(`   every row below sent the same ${spine.length} fields: ${spine.join(",")}\n`);
console.log(`   ${"slot".padStart(5)}  ${"median ms".padStart(9)}   note`);

const slot2 = median(samples.get(2) ?? []);
for (const s of MEASURED_SLOTS) {
  const ms = median(samples.get(s)!);
  const note = s === 2 ? "<- the real probe's baseline slot" : "";
  console.log(`   ${String(s).padStart(5)}  ${Math.round(ms).toString().padStart(7)}ms   ${note}`);
}

const all = MEASURED_SLOTS.map((s) => median(samples.get(s)!));
const lo = Math.min(...all);
const hi = Math.max(...all);
const late = MEASURED_SLOTS.filter((s) => s > 2).map((s) => median(samples.get(s)!));
const lateMed = median(late);

console.log(`\n   spread across slots: ${Math.round(lo)}ms .. ${Math.round(hi)}ms  (${Math.round(hi - lo)}ms)`);
console.log(`   slot 2 (baseline): ${Math.round(slot2)}ms   median of later slots: ${Math.round(lateMed)}ms`);
console.log(
  `   position bias at the baseline slot: ${slot2 - lateMed >= 0 ? "+" : ""}${Math.round(slot2 - lateMed)}ms`,
);
console.log(
  `\n   Same query everywhere. Any spread above is POSITION, not fields —\n` +
    `   and it is subtracted from all 19 field deltas as if it were the spine.`,
);
