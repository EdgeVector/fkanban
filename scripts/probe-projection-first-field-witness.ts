#!/usr/bin/env bun
/**
 * Pin the projection rule to ONE named row, so counting cannot lie.
 *
 * `probe-projection-order-dependence.ts` found that on the live `default`
 * BoardCards partition `[title,board]` returns 264 rows and `[board,title]`
 * returns 263 — the same field SET, both orders, different answers. That is
 * fatal to both set hypotheses (intersection and union are commutative), but
 * the whole margin is ONE row, and a single-row gap between two sequential
 * queries is exactly what a concurrent write also looks like.
 *
 * So stop counting. Find the row by ENVELOPE KEY, then ask whether that key
 * specifically is present under each ordering, alternating the orders so a
 * write landing mid-probe cannot line up with the hypothesis. A rule that
 * survives per-row, repeated, alternating interrogation is a rule.
 *
 * Read-only: queries only. Writes nothing, deletes nothing.
 *
 *   bun scripts/probe-projection-first-field-witness.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";

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

type Row = { key: string; fields: Record<string, unknown> };

async function rowsFor(fields: readonly string[]): Promise<Row[]> {
  const res = await node.queryAll({
    schemaHash: bcHash!,
    fields: [...fields],
    filter: { HashKey: BOARD },
  });
  return (res.results ?? []).map((r) => ({
    key: `${r.key?.hash ?? "?"}${r.key?.range ?? "?"}`,
    fields: (r.fields ?? {}) as Record<string, unknown>,
  }));
}

const keysOf = (rows: Row[]) => new Set(rows.map((r) => r.key));

// ------------------------------------------------------- find the witness row
const titleRows = await rowsFor(["title"]);
const boardRows = await rowsFor(["board"]);
const boardKeys = keysOf(boardRows);
const witnesses = titleRows.filter((r) => !boardKeys.has(r.key));

console.log(`== BoardCards HashKey=${BOARD} ==\n`);
console.log(`  rows projecting [title]:  ${titleRows.length}`);
console.log(`  rows projecting [board]:  ${boardRows.length}`);
console.log(`  in [title] but not [board]: ${witnesses.length}`);

if (witnesses.length === 0) {
  console.log("\n  No asymmetric row on this partition right now — nothing to witness.");
  console.log("  (The rule can only be pinned where two fields disagree.)");
  process.exit(0);
}

const witness = witnesses[0]!;
const range = witness.key.split("")[1] ?? "";
console.log(`\n  witness row range key: ${range}`);
console.log(`  its [title] value:     ${JSON.stringify(witness.fields.title ?? null)}`);

// What DOES it carry? One field at a time — a wide read would drop it and tell
// us nothing about which atoms exist.
const PROBE_FIELDS = [
  "board", "sk", "slug", "title", "column", "position", "assignee", "tags",
  "deps", "surfaces", "created_at", "created_by", "updated_at", "db", "repo",
  "base", "kind", "block_status", "block_reason", "north_star", "milestone",
  "pr_url", "branch", "layout",
];
const carries: string[] = [];
for (const f of PROBE_FIELDS) {
  const rows = await rowsFor([f]);
  if (keysOf(rows).has(witness.key)) carries.push(f);
}
console.log(`  atoms it has (${carries.length}/${PROBE_FIELDS.length}): ${carries.join(", ") || "(none)"}`);
console.log(`  atoms it lacks: ${PROBE_FIELDS.filter((f) => !carries.includes(f)).join(", ")}`);

// ------------------------------------------------- alternate the orderings
// `have` = a field the witness carries; `lack` = one it does not.
const have = carries[0];
const lack = PROBE_FIELDS.find((f) => !carries.includes(f));
if (!have || !lack) {
  console.log("\n  Witness carries all or no fields — no ordered pair to build.");
  process.exit(0);
}

console.log(`\n== Is the witness visible? [have=${have}] vs [lack=${lack}], alternating ==\n`);
console.log(`  trial  [${have},${lack}]   [${lack},${have}]`);

const TRIALS = 4;
let firstFieldHolds = true;
for (let i = 0; i < TRIALS; i += 1) {
  // Alternate which order goes first, so a mid-probe write cannot correlate
  // with the hypothesis.
  const orderA = i % 2 === 0 ? [have, lack] : [lack, have];
  const orderB = i % 2 === 0 ? [lack, have] : [have, lack];
  const a = keysOf(await rowsFor(orderA)).has(witness.key);
  const b = keysOf(await rowsFor(orderB)).has(witness.key);
  const haveFirst = i % 2 === 0 ? a : b;
  const lackFirst = i % 2 === 0 ? b : a;
  console.log(
    `  ${String(i + 1).padEnd(6)} ${haveFirst ? "visible" : "DROPPED"}      ${
      lackFirst ? "visible" : "DROPPED"
    }`,
  );
  if (!(haveFirst && !lackFirst)) firstFieldHolds = false;
}

// Cross-check: does a LONG projection led by a field it carries still see it?
const ledByHave = keysOf(await rowsFor([have, ...PROBE_FIELDS.filter((f) => f !== have)]));
const ledByLack = keysOf(await rowsFor([lack, ...PROBE_FIELDS.filter((f) => f !== lack)]));
console.log(`\n  all 24 fields led by \`${have}\` (carried):    ${ledByHave.has(witness.key) ? "visible" : "DROPPED"}`);
console.log(`  all 24 fields led by \`${lack}\` (absent):     ${ledByLack.has(witness.key) ? "visible" : "DROPPED"}`);

console.log(
  `\nVERDICT: ${
    firstFieldHolds
      ? "FIRST PROJECTED FIELD DECIDES. Visibility tracked the leading field in every trial;\n         the remaining 23 projected fields changed nothing."
      : "NOT first-field — a trial disagreed. See the table above."
  }`,
);
console.log("Read-only. Nothing was written.");
