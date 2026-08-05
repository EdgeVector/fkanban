#!/usr/bin/env bun
/**
 * Re-run the 2026-07-30 experiment that established the projection rule.
 *
 * `test/projection-drops-rows.test.ts` opens with a measurement:
 *
 *   HashKey=default, project ["slug"]              -> 896 rows
 *   HashKey=default, project ["slug","milestone"]  -> 761 rows
 *
 * — taken after the multi-key catalog expand added `milestone` to BoardCards
 * without backfilling it. 135 rows lacked the atom and the node dropped them.
 * That number is why the suite's fake node drops by default.
 *
 * `probe-wire-projection-semantics.ts` measured the opposite on 2026-08-01: the
 * node returns partial rows. Both can be true across time, and which it is
 * decides whether the oracle is WRONG or merely STALE. So run the same two
 * queries again, today, and put the numbers side by side.
 *
 * ## This probe needs a WITNESS, and the live partition stopped supplying one
 *
 * The experiment only discriminates while some row on `default` LACKS a
 * `milestone` atom. On 07-30 there were 135 such rows and the two queries
 * differed by exactly that. Once the partition is fully backfilled, both
 * queries return every row under either rule, and the counts agree for a
 * reason that has nothing to do with the node's behaviour.
 *
 * Measured 2026-08-05: 115 / 115, and `withAtom == 115` — every row carries
 * the atom, so there is NO witness and this partition can no longer tell the
 * rules apart. The verdict here used to read equal counts as proof that "the
 * node NO LONGER DROPS … the rule regressed", printing it in the same breath
 * as "0 row(s) came back WITHOUT the projected atom" — zero witnesses reported
 * as a finding. That conclusion was false: `probe-boardcards-hash-gate-
 * constructed.ts`, run the same minute against rows built to lack specific
 * atoms, showed the node dropping hard —
 *
 *   [board,title]  -> 2 of 4   (rows with no `board` atom dropped)
 *   [title,board]  -> 4 of 4   (same two fields, other order, nothing dropped)
 *   [title,milestone] -> 2 of 4 (the hash field gates from ANY position)
 *
 * — i.e. the measured `hash_else_lead` rule the suite's fake models, intact.
 *
 * It matters because of what a false "the rule regressed" invites: retiring
 * the projection-parity check, which is the ONLY detector for a board row
 * silently dropped from every product read. A probe that cannot fail must say
 * so instead of picking the more alarming branch.
 *
 * So the verdict is now a trichotomy, and "no witness" is its own answer.
 * When it fires, the conclusive instrument is the constructed probe, which
 * supplies its own witnesses and does not depend on what the live board
 * happens to contain today.
 *
 * Read-only.
 *
 *   bun scripts/probe-projection-rule-regression.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const bcHash = cfg.schemaHashes?.board_cards;
if (!bcHash) {
  console.log("board_cards unbound — nothing to measure.");
  process.exit(0);
}

async function n(fields: string[]): Promise<{ rows: number; withAtom: number }> {
  const res = await node.queryAll({ schemaHash: bcHash!, fields, filter: { HashKey: "default" } });
  const rows = res.results ?? [];
  const probe = fields[fields.length - 1]!;
  const withAtom = rows.filter((r) => probe in ((r.fields ?? {}) as Record<string, unknown>)).length;
  return { rows: rows.length, withAtom };
}

const slugOnly = await n(["slug"]);
const withMilestone = await n(["slug", "milestone"]);

console.log("BoardCards / HashKey=default\n");
console.log(`  project ["slug"]                 -> ${slugOnly.rows} rows`);
console.log(
  `  project ["slug","milestone"]     -> ${withMilestone.rows} rows` +
    `  (${withMilestone.withAtom} of them carry a \`milestone\` key)`,
);
console.log(`\n  2026-07-30, same two queries:      896 / 761  (135 rows dropped)`);
console.log(`  2026-08-01, dropped by the node:   ${slugOnly.rows - withMilestone.rows}`);

// Rows returned by the two-field read that carry NO atom for the second field.
// These are the only positive evidence that the node stopped dropping: it
// returned a row it would have had to drop under the 07-30 rule.
const sparse = withMilestone.rows - withMilestone.withAtom;
const dropped = slugOnly.rows - withMilestone.rows;

// Three outcomes, not two. The old code folded the third into "regressed",
// which is how a partition with nothing to drop came to be reported as proof
// that the node had stopped dropping.
if (dropped > 0) {
  console.log(
    `\n  VERDICT: the node still drops ${dropped} row(s) — the rule HOLDS here.` +
      `\n  Witness: ${dropped} row(s) present at ["slug"] and absent at ["slug","milestone"].`,
  );
} else if (sparse > 0) {
  console.log(
    `\n  VERDICT: the node NO LONGER DROPS — the rule REGRESSED between 07-30 and today.` +
      `\n  Witness: ${sparse} row(s) came back WITHOUT a \`milestone\` atom; under the 07-30` +
      `\n  rule they would have been invisible.`,
  );
} else {
  console.log(
    `\n  VERDICT: INCONCLUSIVE — no witness on this partition.` +
      `\n  All ${withMilestone.rows} row(s) carry a \`milestone\` atom, so both rules predict` +
      `\n  the same counts and nothing here can tell them apart. Equal counts are NOT` +
      `\n  evidence that the node stopped dropping.` +
      `\n  Conclusive instrument: bun scripts/probe-boardcards-hash-gate-constructed.ts` +
      `\n  — it writes rows that lack specific atoms, so it supplies its own witnesses.`,
  );
}
console.log("\nRead-only. Nothing was written.");
