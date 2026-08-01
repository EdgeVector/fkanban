#!/usr/bin/env bun
/**
 * Where does a row that carries ONE atom stop being visible?
 *
 * `probe-projection-first-field-witness.ts` established two facts that no
 * single rule yet explains. Witness row `todo#00007777#debug-protein` on the
 * live `default` BoardCards partition carries exactly one atom (`title`):
 *
 *   [title]              -> visible
 *   [title, board]       -> visible     \  same set, both orders,
 *   [board, title]       -> DROPPED     /  different answers
 *   [title, ...23 more]  -> DROPPED     <- led by the atom it HAS, still gone
 *
 * The first two rule out intersection and union (both commutative). The last
 * rules out "the first projected field decides" as stated. So visibility
 * depends on the leading field AND on something about width.
 *
 * This scan grows the projection one field at a time, always led by `title`,
 * and reports the width at which the witness disappears. It then re-runs the
 * boundary widths with the tail fields SHUFFLED, to separate "it is the count"
 * from "it is some particular field further down the list".
 *
 * Read-only: queries only. Writes nothing, deletes nothing.
 *
 *   bun scripts/probe-projection-width-scan.ts
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

// Re-derive the witness rather than hard-coding it.
const lead = await keysFor([LEAD]);
const other = await keysFor([BOARD_CARDS_FIELDS.find((f) => f !== LEAD)!]);
const witnesses = [...lead].filter((k) => !other.has(k));
if (witnesses.length === 0) {
  console.log(`No row carries \`${LEAD}\` and lacks the comparison field — nothing to scan.`);
  process.exit(0);
}
const witness = witnesses[0]!;
console.log(`== BoardCards HashKey=${BOARD}, witness ${witness.slice(BOARD.length)} ==\n`);
console.log(`   (carries \`${LEAD}\` only)\n`);

const tail = BOARD_CARDS_FIELDS.filter((f) => f !== LEAD);

console.log(`  width  projection (led by ${LEAD})                     rows   witness`);
let flipAt = -1;
for (let w = 0; w <= tail.length; w += 1) {
  const proj = [LEAD, ...tail.slice(0, w)];
  const keys = await keysFor(proj);
  const seen = keys.has(witness);
  if (!seen && flipAt < 0) flipAt = proj.length;
  const shown = proj.length <= 3 ? proj.join(",") : `${proj.slice(0, 2).join(",")},…+${proj.length - 2}`;
  console.log(
    `  ${String(proj.length).padEnd(6)} ${shown.padEnd(44)} ${String(keys.size).padEnd(6)} ${
      seen ? "visible" : "DROPPED"
    }`,
  );
  if (flipAt > 0 && proj.length >= flipAt + 2) break;
}

if (flipAt < 0) {
  console.log(`\n  Witness stayed visible at every width up to ${tail.length + 1}.`);
  process.exit(0);
}

// Is it the COUNT, or the identity of the field that width first admitted?
const culprit = tail[flipAt - 2];
console.log(`\n== Boundary: visible at ${flipAt - 1} fields, dropped at ${flipAt}. ==\n`);
console.log(`  the field width ${flipAt} first admitted: \`${culprit}\`\n`);

console.log(`  control                                              rows   witness`);
const controls: Array<[string, string[]]> = [
  [`[${LEAD},${culprit}] — the new field, alone`, [LEAD, culprit!]],
  [
    `${flipAt} fields, same count, ${culprit} REMOVED`,
    [LEAD, ...tail.filter((f) => f !== culprit).slice(0, flipAt - 1)],
  ],
  [
    `${flipAt - 1} fields (visible width) + ${culprit}`,
    [LEAD, ...tail.slice(0, flipAt - 2), culprit!],
  ],
];
for (const [label, proj] of controls) {
  const keys = await keysFor(proj);
  console.log(`  ${label.padEnd(52)} ${String(keys.size).padEnd(6)} ${keys.has(witness) ? "visible" : "DROPPED"}`);
}

console.log("\nRead-only. Nothing was written.");
