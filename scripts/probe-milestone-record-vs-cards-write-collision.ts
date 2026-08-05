#!/usr/bin/env bun
/**
 * Probe: can a Milestone RECORD and a MilestoneCards MEMBERSHIP row destroy
 * each other, given that the multi-key expand puts both on one product?
 *
 * ## Why this exists — the two legs already measured, and the one that was not
 *
 * `Milestone` is `Hash(slug)`; `MilestoneCards` is `HashRange(milestone, sk)`.
 * A milestone's own record therefore lives at the SAME hash as its cards
 * partition, and on this config `milestone_cards` resolves to a schema the node
 * registered under `descriptive_name: "Milestone"`, so the expand puts entity
 * and index on one product. Two consequences of that were already measured:
 *
 *   READ    the Milestone record appears IN the cards partition query with its
 *           absent range coerced to `""` — the "phantom row", measured
 *           2026-08-04, `probe-milestone-cards-keyless-row.ts`. Dropped by
 *           `milestoneCardRowFromQueryRow`'s empty-sk guard.
 *   DELETE  `purgeOtherMilestoneCardRows` cannot reach it: a delete at
 *           `(hash=<milestone>, range="")` is rejected 400 by the node, and the
 *           Milestone record came back byte-identical
 *           (`probe-milestone-keyless-row-delete-blast-radius.ts`).
 *
 * Both of those ask what a CARDS operation does to the RECORD, and both are
 * about the keyless row. Neither asks the reverse, and neither asks about an
 * ordinary, valid, non-keyless write. Those are the reachable production paths:
 * `milestone add` / `milestone state` UPDATE the record, `milestone rm` DELETES
 * it, and every card move UPSERTS membership rows in that same partition. If
 * one product backs both, a valid write on either side is not obviously
 * confined to its own address, and nothing observed so far says it is.
 *
 * ## Hypotheses
 *
 *   H_isolated  `(m, "")` and `(m, sk)` are distinct addresses on the shared
 *               product. Every cross-write is confined: the other side stays
 *               byte-identical, and deleting the record leaves the membership
 *               rows standing. The phantom is a READ-time artifact only.
 *   H_shared    the expand merges on the hash, so a write on either side
 *               reaches the other: a cards upsert stamps atoms on the record,
 *               a record update disturbs the membership rows, or — the one
 *               that would be data loss — `milestone rm` takes the partition
 *               with it.
 *
 * ## Predictions, recorded BEFORE the run
 *
 *   H_isolated  A3 record byte-identical; A5 both membership rows
 *               byte-identical; A6 both membership rows still present after
 *               the record is deleted.
 *   H_shared    at least one of A3 / A5 / A6 shows a changed field or a
 *               vanished row.
 *
 * They differ on three cells, any one of which decides it.
 *
 * ## Safety
 *
 * Every slug is `zz-`-prefixed and unique per run; no real milestone or card is
 * read, written or deleted. The probe deletes everything it creates and
 * verifies the partition is empty before exiting. Labelled `kanban-probe`.
 *
 * Run: bun scripts/probe-milestone-record-vs-cards-write-collision.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient, type QueryFilter } from "../src/client.ts";
import { MILESTONE_FIELDS, MILESTONE_CARDS_FIELDS, MILESTONE_CARDS_LAYOUT } from "../src/schemas.ts";
import { milestoneCardsHash } from "../src/milestone-cards.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
  opsLabel: "kanban-probe",
});

const cardsHash = milestoneCardsHash(cfg);
const recordHash = cfg.schemaHashes?.["milestone"] ?? "";
if (!cardsHash || !recordHash) {
  console.error("milestone / milestone_cards schema hashes not both pinned — is kanban initialised?");
  process.exit(2);
}

const SETTLE_MS = 3500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MS = `zz-collide-ms-${Date.now()}`;
const SK1 = `todo#00000001#zz-collide-card-a`;
const SK2 = `doing#00000002#zz-collide-card-b`;

/** The 15-field Milestone RECORD, every field carrying a recognisable value. */
function milestoneRecord(gen: number): Record<string, unknown> {
  const v = (name: string) => `zzrec-${name}-g${gen}`;
  return {
    slug: MS,
    title: v("title"),
    body: v("body"),
    board: v("board"),
    state: "planned",
    position: String(gen),
    north_star: v("northstar"),
    driver: v("driver"),
    deps: [v("deps")],
    proof_card: v("proofcard"),
    proof_status: "pending",
    block_reason: v("blockreason"),
    created_at: new Date(1785000000000).toISOString(),
    updated_at: new Date(1785000000000 + gen * 1000).toISOString(),
    completed_at: "",
  };
}

/** A 24-field MilestoneCards MEMBERSHIP row in the same partition. */
function cardsRow(sk: string, column: string, position: string, slug: string): Record<string, unknown> {
  const v = (name: string) => `zzcard-${name}-${slug}`;
  return {
    milestone: MS, sk, slug, column, position, layout: MILESTONE_CARDS_LAYOUT,
    title: v("title"), assignee: v("assignee"), created_by: v("createdby"),
    db: v("db"), repo: v("repo"), base: v("base"), kind: v("kind"),
    block_status: v("blockstatus"), block_reason: v("blockreason"),
    north_star: v("northstar"), board: v("board"),
    pr_url: v("prurl"), branch: v("branch"),
    tags: [v("tags")], deps: [v("deps")], surfaces: [v("surfaces")],
    created_at: new Date(1785000000000).toISOString(),
    updated_at: new Date(1785000000000).toISOString(),
  };
}

/** Read the Milestone RECORD's own row, off its own schema, by its own key. */
async function readRecord(): Promise<Record<string, unknown> | null> {
  const res = await node.queryAll({
    schemaHash: recordHash,
    fields: [...MILESTONE_FIELDS],
    filter: { HashKey: MS } as QueryFilter,
  });
  for (const r of res.results) {
    const f = (r.fields ?? {}) as Record<string, unknown>;
    if (f.slug === MS) return f;
  }
  return null;
}

/** Read one MEMBERSHIP row by its real (hash, range) address. */
async function readCardsRow(sk: string): Promise<Record<string, unknown> | null> {
  const res = await node.queryAll({
    schemaHash: cardsHash,
    fields: [...MILESTONE_CARDS_FIELDS],
    filter: { HashRangePrefix: { hash: MS, prefix: sk } } as unknown as QueryFilter,
  });
  for (const r of res.results) if (r.key?.range === sk) return (r.fields ?? {}) as Record<string, unknown>;
  return null;
}

/** Every row the cards partition returns, by address, led by `slug`. */
async function partitionRows(): Promise<Array<{ range: string; slug: string }>> {
  const res = await node.queryAll({
    schemaHash: cardsHash,
    fields: ["slug"],
    filter: { HashKey: MS } as QueryFilter,
  });
  return res.results.map((r) => ({
    range: typeof r.key?.range === "string" ? r.key.range : "<absent>",
    slug: typeof (r.fields as Record<string, unknown>)?.slug === "string"
      ? ((r.fields as Record<string, unknown>).slug as string)
      : "<none>",
  }));
}

function diff(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  fields: readonly string[],
): string[] {
  if (before === null) return ["<absent BEFORE>"];
  if (after === null) return ["<VANISHED>"];
  const out: string[] = [];
  for (const f of fields) {
    const a = JSON.stringify(before[f] ?? null);
    const b = JSON.stringify(after[f] ?? null);
    if (a !== b) out.push(`${f}: ${a} -> ${b}`);
  }
  return out;
}

function verdict(label: string, changes: string[]): boolean {
  const clean = changes.length === 0;
  console.log(`  ${clean ? "SAME  " : "CHANGED"} ${label}${clean ? "" : ` — ${changes.join("; ")}`}`);
  return clean;
}

console.log(`milestone       ${recordHash.slice(0, 12)}…  Hash(slug)`);
console.log(`milestone_cards ${cardsHash.slice(0, 12)}…  HashRange(milestone, sk)`);
console.log(`partition       ${MS}\n`);

let isolated = true;

// --- A1/A2: create the record, then two membership rows in its partition ----
console.log("A1  create Milestone RECORD");
await node.createRecord({ schemaHash: recordHash, fields: milestoneRecord(1), keyHash: MS });
await sleep(SETTLE_MS);
const recAfterCreate = await readRecord();
console.log(`    record readable: ${recAfterCreate !== null}`);
if (recAfterCreate === null) {
  console.error("record not readable after create — cannot run the experiment");
  process.exit(2);
}

console.log("A2  create 2 MilestoneCards MEMBERSHIP rows in the SAME partition");
await node.createRecord({
  schemaHash: cardsHash, keyHash: MS, rangeKey: SK1,
  fields: cardsRow(SK1, "todo", "00000001", "zz-collide-card-a"),
});
await node.createRecord({
  schemaHash: cardsHash, keyHash: MS, rangeKey: SK2,
  fields: cardsRow(SK2, "doing", "00000002", "zz-collide-card-b"),
});
await sleep(SETTLE_MS);

// --- A3: did the cards writes reach the record? -----------------------------
console.log("\nA3  does a MEMBERSHIP write clobber the RECORD?");
isolated = verdict("Milestone record after 2 cards writes", diff(recAfterCreate, await readRecord(), MILESTONE_FIELDS)) && isolated;

// --- A4: what does the partition actually contain? --------------------------
console.log("\nA4  cards partition contents (lead=slug)");
for (const r of await partitionRows()) console.log(`    range="${r.range}"  slug=${r.slug}`);

const c1Before = await readCardsRow(SK1);
const c2Before = await readCardsRow(SK2);
console.log(`    membership rows readable by address: SK1=${c1Before !== null} SK2=${c2Before !== null}`);

// --- A5: does a RECORD update disturb the MEMBERSHIP rows? ------------------
console.log("\nA5  does a RECORD update clobber the MEMBERSHIP rows?");
await node.updateRecord({ schemaHash: recordHash, fields: milestoneRecord(2), keyHash: MS });
await sleep(SETTLE_MS);
isolated = verdict("membership SK1 after record update", diff(c1Before, await readCardsRow(SK1), MILESTONE_CARDS_FIELDS)) && isolated;
isolated = verdict("membership SK2 after record update", diff(c2Before, await readCardsRow(SK2), MILESTONE_CARDS_FIELDS)) && isolated;

// --- A6: the money arm — does `milestone rm` take the partition with it? ----
console.log("\nA6  does deleting the RECORD wipe the cards partition?  <-- data-loss arm");
await node.deleteRecord({ schemaHash: recordHash, keyHash: MS });
await sleep(SETTLE_MS);
const recGone = (await readRecord()) === null;
console.log(`    record deleted: ${recGone}`);
const after = await partitionRows();
for (const r of after) console.log(`    range="${r.range}"  slug=${r.slug}`);
isolated = verdict("membership SK1 after record DELETE", diff(c1Before, await readCardsRow(SK1), MILESTONE_CARDS_FIELDS)) && isolated;
isolated = verdict("membership SK2 after record DELETE", diff(c2Before, await readCardsRow(SK2), MILESTONE_CARDS_FIELDS)) && isolated;

// --- A7: cleanup ------------------------------------------------------------
console.log("\nA7  cleanup");
for (const sk of [SK1, SK2]) {
  try { await node.deleteRecord({ schemaHash: cardsHash, keyHash: MS, rangeKey: sk }); } catch (e) {
    console.log(`    delete ${sk} FAILED: ${(e as Error).message}`);
  }
}
try { await node.deleteRecord({ schemaHash: recordHash, keyHash: MS }); } catch { /* already gone */ }
await sleep(SETTLE_MS);
const leftovers = await partitionRows();
console.log(`    partition after cleanup: ${leftovers.length} row(s)`);
for (const r of leftovers) console.log(`      LEFTOVER range="${r.range}" slug=${r.slug}`);

console.log(`\nVERDICT: ${isolated ? "H_isolated — every cross-write confined" : "H_shared — a cross-write reached the other side"}`);
