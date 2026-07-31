#!/usr/bin/env bun
/**
 * READ-ONLY probe: do `kanban search` results actually carry their bodies?
 *
 * The default path matches most results against a BODY-FREE display read, and
 * only the (<=50) native-index candidates get a body-bearing point read. If the
 * display-matched cards are returned as-is, every one of them reaches the caller
 * with body="" — while the `fkanban_search` MCP tool's own contract says "every
 * match carries its full body".
 *
 * Also measures the cost of a minimal slug+body scan, the candidate replacement
 * for the 50 point reads.
 *
 * Run: bun scripts/probe-search-body-fidelity.ts [query]
 */
import { readConfig, schemaHashFor } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { searchResult } from "../src/commands/search.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const q = process.argv[2] ?? "lastdb";

const fast = await searchResult({ cfg, node, query: q });
const empty = fast.cards.filter((c) => !c.body || c.body.length === 0);
console.log(`=== default search "${q}": ${fast.cards.length} matches`);
console.log(`  matches with an EMPTY body: ${empty.length}`);
console.log(`  matches carrying a body   : ${fast.cards.length - empty.length}`);
if (empty.length > 0) console.log(`  sample empty-body slugs: ${empty.slice(0, 5).map((c) => c.slug).join(", ")}`);

const full = await searchResult({ cfg, node, query: q, complete: true });
const fullEmpty = full.cards.filter((c) => !c.body || c.body.length === 0);
console.log(`\n=== --complete "${q}": ${full.cards.length} matches`);
console.log(`  matches with an EMPTY body: ${fullEmpty.length}`);

// Cost of the minimal body-bearing scan that could replace the 50 point reads.
const hash = schemaHashFor("card", cfg);
const widths: Array<{ name: string; fields: string[] }> = [
  { name: "slug+body", fields: ["slug", "body"] },
  { name: "match-fields", fields: ["slug", "title", "body", "assignee", "tags", "deps"] },
];
console.log("\n=== candidate replacement scan cost (interleaved, 3 rounds, median)");
const samples = new Map<string, number[]>(widths.map((w) => [w.name, []]));
const rowsSeen = new Map<string, number>();
for (let r = 0; r < 3; r++) {
  for (const w of widths) {
    const t0 = performance.now();
    const res = await node.queryAll({ schemaHash: hash, fields: w.fields, allowFullScan: true });
    samples.get(w.name)!.push(performance.now() - t0);
    rowsSeen.set(w.name, res.results.length);
  }
}
for (const w of widths) {
  const s = [...samples.get(w.name)!].sort((a, b) => a - b);
  console.log(`  ${w.name.padEnd(14)} f=${w.fields.length}  rows=${rowsSeen.get(w.name)}  ${(s[1] ?? 0).toFixed(0)}ms`);
}
