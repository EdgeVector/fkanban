#!/usr/bin/env bun
/**
 * Which projection rule does the node actually apply — LEAD-gates, or
 * ANY-missing-drops?
 *
 * The whole repo is built on the LEAD model. `sweepMilestoneCardsPartition`
 * states it outright ("a row is returned iff the field LEADING the projection
 * has an atom on it") and derives its all-leads union from it;
 * `boardCardsWireProjection` preserves `fields[0]` verbatim because of it; and
 * `test/fake-node.ts` calls the ANY-missing model "STRICTER than the node,
 * deliberately".
 *
 * `probe-milestone-charter-row-reach.ts` found a live row that the two models
 * disagree about. In `operation-trinity-m0-charter`, sk
 * `done#1785302647745#…-terminal` carries atoms for exactly four fields —
 * `slug`, `title`, `column`, `position` — and:
 *
 *   ["slug"]                        -> returned
 *   ["slug", …23 other fields]      -> NOT returned      (slug still leads)
 *
 * Under LEAD, both return. Under ANY-missing, only the first does.
 *
 * The decisive pair below holds the SET fixed at two fields — one the row has,
 * one it does not — and varies only the ORDER. LEAD predicts the two orders
 * disagree; ANY-missing predicts both drop.
 *
 * Read-only.
 *
 *   bun scripts/probe-projection-lead-vs-any-missing.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";

const MS = "operation-trinity-m0-charter";
const SK = "done#1785302647745#operation-trinity-proof-charter-terminal";
/** Measured present on this row. */
const HAVE = ["slug", "title", "column", "position"];
/** Measured absent on this row. */
const LACK = ["milestone", "sk", "board", "kind", "layout"];

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});
const mcHash = cfg.schemaHashes!.milestone_cards!;

/** Is the witness row in the result set, and which projected keys came back? */
async function probe(fields: string[]): Promise<string> {
  try {
    const res = await node.queryAll({
      schemaHash: mcHash,
      fields,
      filter: { HashKey: MS },
    });
    const hit = (res.results ?? []).find((r) => r.key?.range === SK);
    const n = (res.results ?? []).length;
    if (!hit) return `DROPPED           (partition returned ${n} rows)`;
    const keys = Object.keys(hit.fields ?? {});
    return `returned, keys=[${keys.join(",")}]  (partition returned ${n} rows)`;
  } catch (err) {
    return `THREW ${String(err).slice(0, 70)}`;
  }
}

const cases: Array<[string, string[]]> = [
  // Baselines: every field the row HAS, alone.
  ...HAVE.map((f) => [`have alone        [${f}]`, [f]] as [string, string[]]),
  // …and one it lacks, alone.
  ...LACK.slice(0, 2).map((f) => [`lack alone        [${f}]`, [f]] as [string, string[]]),
  // All-present set: both models predict RETURNED.
  ["all-present       [slug,title,column,position]", [...HAVE]],
  //
  // THE DECISIVE PAIR — same set, two orders, one field the row lacks.
  //   LEAD model:        present-first returns, absent-first drops.
  //   ANY-missing model: both drop.
  ["present-led       [slug,milestone]", ["slug", "milestone"]],
  ["absent-led        [milestone,slug]", ["milestone", "slug"]],
  // Repeat with a different absent field, so the answer is not about
  // `milestone` being the partition key specifically.
  ["present-led       [title,kind]", ["title", "kind"]],
  ["absent-led        [kind,title]", ["kind", "title"]],
  // One present field followed by many absent ones — the shape of the
  // slug-led wide read that motivated this probe.
  ["present-led wide  [slug,+5 absent]", ["slug", ...LACK]],
];

console.log(`witness: ${MS} / ${SK}`);
console.log(`row carries: ${HAVE.join(", ")}\n`);
for (const [label, fields] of cases) {
  console.log(`${label.padEnd(46)} -> ${await probe(fields)}`);
}

console.log(`
Reading the decisive pair:
  present-led RETURNED and absent-led DROPPED -> LEAD model holds.
  BOTH DROPPED                                -> ANY-missing model holds,
                                                 and the repo's stated rule,
                                                 the all-leads sweep and
                                                 boardCardsWireProjection's
                                                 lead-preservation are built on
                                                 a model the node does not use.`);
