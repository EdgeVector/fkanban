#!/usr/bin/env bun
/**
 * Does deleting the keyless MilestoneCards row destroy the Milestone record?
 *
 * `probe-milestone-cards-keyless-row.ts` established WHAT the row is: the
 * milestone's own `Milestone` record (`Hash(slug)`) appearing in the
 * `MilestoneCards` (`HashRange(milestone, sk)`) partition, range coerced to `""`.
 * `probe-extra-schema-resolution-blindspot.ts` established WHY: on the primary,
 * `milestone_cards` is pinned to a schema registered under `descriptive_name =
 * "Milestone"` — the entity's own identity — so Mini's multi-key expand puts the
 * entity and its cards index on ONE product. A node pinned to the catalog's
 * declared `MilestoneCards_hashrange_v1_children_20260723` has no phantom at all.
 *
 * What was never established is the CONSEQUENCE. `purgeOtherMilestoneCardRows`
 * does exactly one thing with a spine row — delete it by
 * `(milestone_cards, hash, range)` — and a guard in `milestoneCardRowFromQueryRow`
 * drops the keyless row before it gets there. Whether that guard prevents data
 * loss or prevents a harmless no-op decides whether it is load-bearing.
 *
 * This probe BUILDS the primary's mispinned shape on a throwaway node — declares
 * the MilestoneCards field/key set under `descriptive_name: "Milestone"` — then
 * issues the delete under test and reports what survived.
 *
 * DESTRUCTIVE BY CONSTRUCTION, and it registers a schema. Isolated node ONLY:
 *
 *   lastdbd --data-dir ~/.cache/kiso &
 *   LASTDB_HOME=~/.cache/kiso KANBAN_CONFIG=~/.cache/kiso/kanban-config.json \
 *     bun scripts/probe-milestone-keyless-row-delete-blast-radius.ts <milestone>
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readConfig, resolveSocketPath } from "../src/config.ts";
import { newNodeClient, type QueryFilter } from "../src/client.ts";
import { MILESTONE_CARDS_FIELDS, MILESTONE_FIELDS, EXTRA_SCHEMAS, OWNER_APP_ID } from "../src/schemas.ts";

const milestone = process.argv[2] ?? "ms-phantom-probe";

const cfg = readConfig();
const socket = resolveSocketPath(cfg);

// Refuse the primary. Both known primary homes, by resolved socket path.
for (const primary of [".lastdb", ".folddb"]) {
  if (socket === join(homedir(), primary, "data", "folddb.sock")) {
    console.error(`REFUSING: socket ${socket} is the primary brain.`);
    console.error("This probe DELETES and REGISTERS A SCHEMA. Use an isolated node.");
    process.exit(2);
  }
}
console.log(`socket: ${socket}`);

const node = newNodeClient({ baseUrl: cfg.nodeUrl, userHash: cfg.userHash, socketPath: socket });

const msHash = cfg.schemaHashes?.milestone;
if (!msHash) {
  console.error("milestone not bound in this config");
  process.exit(1);
}

// --- Build the primary's shape: MilestoneCards declared as "Milestone" -------
const mcEntry = EXTRA_SCHEMAS.find((e) => e.key === "milestone_cards");
if (!mcEntry || !node.declareAppSchema) {
  console.error("milestone_cards not in catalog, or node has no declareAppSchema");
  process.exit(1);
}
const shaped = JSON.parse(JSON.stringify(mcEntry.schema.schema)) as Record<string, unknown>;
shaped.descriptive_name = "Milestone";
const declared = await node.declareAppSchema(OWNER_APP_ID, shaped);
const mcHash = declared.canonical;
console.log(`declared MilestoneCards-under-"Milestone" → ${mcHash.slice(0, 16)} (${declared.resolution})`);

const partition = { HashKey: milestone } as QueryFilter;

async function readMilestoneRecord(): Promise<Record<string, unknown> | null> {
  const res = await node.queryAll({
    schemaHash: msHash!,
    fields: [...MILESTONE_FIELDS],
    filter: partition,
  });
  for (const r of res.results) {
    const f = (r.fields ?? {}) as Record<string, unknown>;
    if (f.slug === milestone) return f;
  }
  return null;
}

async function keylessRows(): Promise<Array<{ lead: string; key: unknown; fields: unknown }>> {
  const out: Array<{ lead: string; key: unknown; fields: unknown }> = [];
  for (const lead of MILESTONE_CARDS_FIELDS) {
    try {
      const res = await node.queryAll({ schemaHash: mcHash, fields: [lead], filter: partition });
      for (const r of res.results) {
        const range = r.key?.range;
        if (typeof range === "string" && range.length > 0) continue;
        out.push({ lead, key: r.key, fields: r.fields });
      }
    } catch { /* lead refused; reported by row count only */ }
  }
  return out;
}

console.log(`\n=== BEFORE ===`);
const before = await readMilestoneRecord();
console.log(`Milestone record: ${before ? JSON.stringify(before).slice(0, 200) : "NOT FOUND"}`);
const beforeKeyless = await keylessRows();
console.log(
  `keyless rows in cards partition: ${beforeKeyless.length} ` +
    `(leads: ${[...new Set(beforeKeyless.map((r) => r.lead))].join(", ") || "none"})`,
);
if (beforeKeyless.length > 0) {
  console.log(`  sample: key=${JSON.stringify(beforeKeyless[0]!.key)} fields=${JSON.stringify(beforeKeyless[0]!.fields)}`);
}

if (beforeKeyless.length === 0) {
  console.log("\nNo keyless row even under the shared identity — the mechanism claim is WRONG.");
  process.exit(0);
}

console.log(`\n=== DELETE (the exact call purgeOtherMilestoneCardRows would issue) ===`);
console.log(`  deleteRecord{schema=<milestone_cards>, keyHash=${milestone}, rangeKey=""}`);
try {
  await node.deleteRecord({ schemaHash: mcHash, keyHash: milestone, rangeKey: "" });
  console.log("  delete returned OK");
} catch (err) {
  console.log(`  delete THREW: ${err instanceof Error ? err.message.slice(0, 200) : err}`);
}

// Memory-first write path with a background flush — do not read back instantly.
await new Promise((r) => setTimeout(r, 2000));

console.log(`\n=== AFTER ===`);
const after = await readMilestoneRecord();
console.log(`Milestone record: ${after ? JSON.stringify(after).slice(0, 200) : "NOT FOUND"}`);
const afterKeyless = await keylessRows();
console.log(`keyless rows in cards partition: ${afterKeyless.length}`);

console.log(`\n=== VERDICT ===`);
if (before !== null && after === null) {
  console.log("DATA LOSS — the delete destroyed the Milestone record.");
  console.log("The guard in milestoneCardRowFromQueryRow is LOAD-BEARING.");
} else if (before !== null && after !== null && JSON.stringify(before) !== JSON.stringify(after)) {
  console.log("DATA DAMAGE — the Milestone record survived but changed.");
  console.log(`  before: ${JSON.stringify(before).slice(0, 300)}`);
  console.log(`  after:  ${JSON.stringify(after).slice(0, 300)}`);
} else if (afterKeyless.length < beforeKeyless.length) {
  console.log("PARTIAL — Milestone record intact on its own index, but the row");
  console.log("disappeared from the cards partition. Something was deleted.");
} else {
  console.log("NO-OP — Milestone record intact, keyless row still present.");
  console.log("The delete addressed nothing; the guard prevents a harmless call.");
}
