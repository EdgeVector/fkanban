#!/usr/bin/env bun
/**
 * The full ordered-pair matrix for one row that carries exactly one atom.
 *
 * Three probes have narrowed the projection rule to something that is neither
 * intersection nor union nor "the first field decides". Witness row
 * `todo#00007777#debug-protein` on the live `default` BoardCards partition
 * carries only `title`, and:
 *
 *   [title]             visible      [title,board]      visible
 *   [title,…+19]        visible      [board,title]      DROPPED
 *   [title,milestone]   DROPPED      [title,…+20]       DROPPED
 *
 * The width scan showed the flip is not width — a 21-field projection with
 * `milestone` removed keeps the row, and the 2-field `[title,milestone]` loses
 * it. So SOME fields drop a row when absent and others do not, and separately
 * the leading position matters.
 *
 * Rather than guess which property of `milestone` matters, ask every field
 * both ways. `[title,X]` isolates "does an absent X deny the row?";
 * `[X,title]` isolates "does an absent X in the lead deny it?". The two
 * columns together classify all 24 fields, and the shape of the classification
 * is the rule.
 *
 * Read-only: queries only. Writes nothing, deletes nothing.
 *
 *   bun scripts/probe-projection-pair-matrix.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { BOARD_CARDS_FIELDS } from "../src/schemas.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const BOARD = process.env.PROBE_BOARD || "default";
const LEAD = process.env.PROBE_LEAD || "title";
const bcHash = cfg.schemaHashes?.board_cards;
if (!bcHash) {
  console.log("board_cards unbound — nothing to measure.");
  process.exit(0);
}

async function keysFor(fields: readonly string[]): Promise<Set<string>> {
  const res = await node.queryAll({
    schemaHash: bcHash!,
    fields: [...fields],
    filter: { HashKey: BOARD },
  });
  const out = new Set<string>();
  for (const r of res.results ?? []) out.add(`${r.key?.hash ?? "?"}${r.key?.range ?? "?"}`);
  return out;
}

const leadKeys = await keysFor([LEAD]);
const baseline = await keysFor(["board"]);
const witnesses = [...leadKeys].filter((k) => !baseline.has(k));
if (witnesses.length === 0) {
  console.log(`No asymmetric row on ${BOARD} right now — nothing to classify.`);
  process.exit(0);
}
const witness = witnesses[0]!;

console.log(`== BoardCards HashKey=${BOARD}, witness ${witness.slice(BOARD.length)} ==`);
console.log(`   carries \`${LEAD}\` only. Every projection below is 2 fields.\n`);
console.log(`  X                 [${LEAD},X]        rows   [X,${LEAD}]        rows`);

const denyWhenSecond: string[] = [];
const admitWhenFirst: string[] = [];

for (const x of BOARD_CARDS_FIELDS) {
  if (x === LEAD) continue;
  const ab = await keysFor([LEAD, x]);
  const ba = await keysFor([x, LEAD]);
  const abSeen = ab.has(witness);
  const baSeen = ba.has(witness);
  if (!abSeen) denyWhenSecond.push(x);
  if (baSeen) admitWhenFirst.push(x);
  console.log(
    `  ${x.padEnd(17)} ${(abSeen ? "visible" : "DROPPED").padEnd(15)} ${
      String(ab.size).padEnd(6)
    } ${(baSeen ? "visible" : "DROPPED").padEnd(15)} ${ba.size}`,
  );
}

console.log(`\n== Classification ==\n`);
console.log(`  absent-and-DENIES when second (${denyWhenSecond.length}): ${denyWhenSecond.join(", ") || "(none)"}`);
console.log(`  absent-and-ADMITS when first  (${admitWhenFirst.length}): ${admitWhenFirst.join(", ") || "(none)"}`);
console.log(
  `\n  If those two sets are complements, the rule is positional.\n  If \`denies\` is a small named set, the rule is about those fields.`,
);
console.log("\nRead-only. Nothing was written.");
