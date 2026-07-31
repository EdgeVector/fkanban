#!/usr/bin/env bun
/**
 * READ-ONLY probe: how many cards does a Card scan LOSE as the projection widens?
 *
 * LastDB returns a row only when EVERY projected field has an atom on that row.
 * `listCardBodies` already documents this ("each extra projected field is
 * another way for a live card to vanish"), but `listCardsWithBodies` — the read
 * behind `search --complete` and the three body-judging sweeps — projects the
 * FULL `fieldsFor("card")` set. This measures what that costs.
 *
 * Run: bun scripts/probe-scan-projection-width.ts
 */
import { readConfig, schemaHashFor } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { fieldsFor } from "../src/schemas.ts";
import { CARD_LIST_FIELDS } from "../src/record.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});
const hash = schemaHashFor("card", cfg);

async function slugsFor(label: string, fields: string[]): Promise<Set<string>> {
  const t0 = performance.now();
  const res = await node.queryAll({ schemaHash: hash, fields, allowFullScan: true });
  const ms = Math.round(performance.now() - t0);
  const slugs = new Set<string>();
  for (const row of res.results) {
    const f = (row as { fields?: Record<string, unknown> }).fields ?? {};
    if (typeof f.slug === "string" && f.slug.length > 0) slugs.add(f.slug);
  }
  console.log(
    `${label.padEnd(34)} fields=${String(fields.length).padStart(2)}  rows=${String(res.results.length).padStart(4)}  slugs=${String(slugs.size).padStart(4)}  ${ms}ms`,
  );
  return slugs;
}

const baseline = await slugsFor("slug only", ["slug"]);
const narrow = await slugsFor("slug+body (listCardBodies)", ["slug", "body"]);
const list = await slugsFor("CARD_LIST_FIELDS (listCards)", CARD_LIST_FIELDS);
const wide = await slugsFor("fieldsFor(card) (…WithBodies)", fieldsFor("card"));

console.log("");
const lost = [...baseline].filter((s) => !wide.has(s));
console.log(`slugs the WIDE scan loses vs slug-only : ${lost.length} of ${baseline.size}`);
const lostByList = [...baseline].filter((s) => !list.has(s));
console.log(`slugs CARD_LIST_FIELDS loses           : ${lostByList.length}`);
const lostByNarrow = [...baseline].filter((s) => !narrow.has(s));
console.log(`slugs slug+body loses                  : ${lostByNarrow.length}`);

if (lost.length > 0) {
  console.log("\nper-field attribution over the lost slugs (which field's atom is missing):");
  const tally = new Map<string, number>();
  for (const field of fieldsFor("card")) {
    if (field === "slug") continue;
    const seen = await node.queryAll({
      schemaHash: hash,
      fields: ["slug", field],
      allowFullScan: true,
    });
    const have = new Set<string>();
    for (const row of seen.results) {
      const f = (row as { fields?: Record<string, unknown> }).fields ?? {};
      if (typeof f.slug === "string") have.add(f.slug);
    }
    const missing = lost.filter((s) => !have.has(s)).length;
    if (missing > 0) tally.set(field, missing);
  }
  for (const [field, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${field.padEnd(16)} missing on ${n} of the ${lost.length} lost slugs`);
  }
  console.log(`\nsample lost slugs: ${lost.slice(0, 10).join(", ")}`);
}
