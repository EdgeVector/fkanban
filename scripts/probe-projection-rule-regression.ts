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

const sparse = withMilestone.rows - withMilestone.withAtom;
console.log(
  `\n  VERDICT: ${
    slugOnly.rows === withMilestone.rows
      ? `the node NO LONGER DROPS. ${sparse} row(s) came back WITHOUT the projected atom — ` +
        `they would have been invisible on 07-30. The rule regressed between 07-30 and today.`
      : `the node still drops ${slugOnly.rows - withMilestone.rows} row(s) — the rule holds here.`
  }`,
);
console.log("\nRead-only. Nothing was written.");
