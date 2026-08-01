#!/usr/bin/env bun
/**
 * How many rows can each PRODUCTION BoardCards projection actually see?
 *
 * The rule, measured on the live primary by the three probes that precede this
 * one (`probe-projection-order-dependence`, `-first-field-witness`,
 * `-width-scan`, `-pair-matrix`):
 *
 *   1. **Leading field gates.** A row is returned only if the FIRST projected
 *      field has an atom on it. Every one of the other 23 BoardCards fields
 *      could be absent from the row without denying it.
 *   2. **`milestone` gates from any position.** Adding `milestone` anywhere in
 *      the projection denies every row that has no `milestone` atom. It is the
 *      hash field of the sibling MilestoneCards index, added to BoardCards by
 *      the 2026-07-23 multi-key catalog expand.
 *
 * Neither is intersection and neither is union, so no projection is complete
 * and no single projection is a lower bound on another. The only complete
 * enumeration available to a client is the UNION over single-field reads —
 * a row is visible iff SOME field leads it, so probing each field as the lead
 * reaches every row that has any atom at all.
 *
 * This probe measures the gap that rule opens between the true partition and
 * what each shipped projection returns.
 *
 * Read-only: queries only. Writes nothing, deletes nothing.
 *
 *   bun scripts/probe-projection-production-reach.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { BOARD_CARDS_FIELDS } from "../src/schemas.ts";
import {
  BOARD_CARDS_ADDRESS_FIELDS,
  BOARD_CARDS_SPINE_FIELDS,
  BOARD_CARDS_DEP_SEED_FIELDS,
  BOARD_CARDS_FOOTER_FIELDS,
  BOARD_CARDS_DISPLAY_FIELDS,
  BOARD_CARDS_LIST_FIELDS,
} from "../src/board-cards.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const BOARD = process.env.PROBE_BOARD || "default";
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
  for (const r of res.results ?? []) out.add(String(r.key?.range ?? "?"));
  return out;
}

// ------------------------------------------------- ground truth: union of leads
const union = new Set<string>();
const perLead = new Map<string, number>();
for (const f of BOARD_CARDS_FIELDS) {
  const k = await keysFor([f]);
  perLead.set(f, k.size);
  for (const key of k) union.add(key);
}

console.log(`== BoardCards HashKey=${BOARD} ==\n`);
console.log(`  union over all ${BOARD_CARDS_FIELDS.length} single-field reads (complete): ${union.size} rows\n`);

const PROJECTIONS: Array<[string, readonly string[]]> = [
  ["BOARD_CARDS_ADDRESS_FIELDS (heal / parity)", BOARD_CARDS_ADDRESS_FIELDS],
  ["BOARD_CARDS_SPINE_FIELDS", BOARD_CARDS_SPINE_FIELDS],
  ["BOARD_CARDS_DEP_SEED_FIELDS", BOARD_CARDS_DEP_SEED_FIELDS],
  ["BOARD_CARDS_FOOTER_FIELDS", BOARD_CARDS_FOOTER_FIELDS],
  ["BOARD_CARDS_DISPLAY_FIELDS", BOARD_CARDS_DISPLAY_FIELDS],
  ["BOARD_CARDS_LIST_FIELDS (list / pickup / MCP)", BOARD_CARDS_LIST_FIELDS],
  ["BOARD_CARDS_FIELDS (full write shape)", BOARD_CARDS_FIELDS],
];

console.log(`  ${"projection".padEnd(46)} ${"lead".padEnd(12)} ms  rows  unseen`);
for (const [label, fields] of PROJECTIONS) {
  const t0 = performance.now();
  const seen = await keysFor(fields);
  const ms = Math.round(performance.now() - t0);
  const missing = [...union].filter((k) => !seen.has(k));
  const hasMilestone = fields.includes("milestone");
  console.log(
    `  ${label.padEnd(46)} ${String(fields[0]).padEnd(12)} ${String(ms).padStart(4)} ${
      String(seen.size).padStart(5)
    } ${String(missing.length).padStart(6)}${hasMilestone ? "   (projects milestone)" : ""}`,
  );
  if (missing.length > 0 && missing.length <= 5) {
    for (const m of missing) console.log(`  ${" ".repeat(46)}   unseen: ${m}`);
  }
}

// Which fields lead to a short read? Those are the sparse atoms.
console.log(`\n== Rows reachable per leading field (sparse atoms lead to short reads) ==\n`);
const sorted = [...perLead.entries()].sort((a, b) => a[1] - b[1]);
for (const [f, n] of sorted) {
  if (n === union.size) continue;
  console.log(`  ${f.padEnd(17)} ${String(n).padStart(5)}   (${union.size - n} rows lack this atom)`);
}
if (sorted.every(([, n]) => n === union.size)) {
  console.log("  (every field is present on every row — no sparse atoms today)");
}

console.log("\nRead-only. Nothing was written.");
