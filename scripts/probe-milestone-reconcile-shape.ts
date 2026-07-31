#!/usr/bin/env bun
/**
 * What does `milestone reconcile` actually spend its time on?
 *
 * `milestone reconcile lastdb-0231-read-regression-fixes` did not finish inside
 * a 10-minute timeout, and the obvious diagnosis — "its read loop is serial" —
 * is only half the story. A point read is ~200ms; a mutation on this node is
 * 2.4-8.3s. Sixty serial reads is twelve seconds. Forty serial *writes* is the
 * ten minutes.
 *
 * This probe separates the two WITHOUT issuing any write, so the fix can be
 * aimed at whichever half is actually load-bearing:
 *
 *   bun scripts/probe-milestone-reconcile-shape.ts <milestone-slug>
 *
 * It reproduces reconcile's classification exactly (same union, same truth
 * projection) and reports what reconcile WOULD write, then times the read
 * phase serial vs fanned-out at POINT_READ_CONCURRENCY. Read-only: it never
 * calls upsertMilestoneCard or removeMilestoneCard.
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { findCardSummaryForReconcile, findMilestone, listCardsOnBoard } from "../src/record.ts";
import { listMilestoneCardsPartition } from "../src/milestone-cards.ts";
import { mapWithConcurrency, POINT_READ_CONCURRENCY } from "../src/concurrency.ts";
import type { Card } from "../src/record.ts";

const slug = process.argv[2];
if (!slug) {
  console.error("usage: bun scripts/probe-milestone-reconcile-shape.ts <milestone-slug>");
  process.exit(2);
}

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const milestone = await findMilestone(node, cfg, slug);
if (!milestone) {
  console.error(`no such milestone: ${slug}`);
  process.exit(1);
}

const t0 = Date.now();
const fromIndex = await listMilestoneCardsPartition(node, cfg, milestone.slug);
const tIndex = Date.now() - t0;

const t1 = Date.now();
const fromBoard = (await listCardsOnBoard(node, cfg, milestone.board)).filter((c) => c.milestone === milestone.slug);
const tBoard = Date.now() - t1;

// Index rows are the only MilestoneCards rows and the only evidence of drift.
// Board rows are unioned in to DISCOVER slugs the index missed — a board row is
// not an index row, and treating the two as interchangeable is the defect this
// probe was written to measure.
const indexRows: Card[] = fromIndex ?? [];
const rowsBySlug = new Map<string, Card[]>();
for (const row of indexRows) {
  const rows = rowsBySlug.get(row.slug) ?? [];
  rows.push(row);
  rowsBySlug.set(row.slug, rows);
}
const slugs = [...new Set([...indexRows.map((r) => r.slug), ...fromBoard.map((r) => r.slug)])];

const boardSlugs = new Set(fromBoard.map((c) => c.slug));
let realIndexDupes = 0; // >1 MilestoneCards row for a slug — genuine drift
let unionDupes = 0; // in index AND board — a union artifact, not drift
for (const s of slugs) {
  const inIndex = rowsBySlug.get(s)?.length ?? 0;
  if (inIndex > 1) realIndexDupes++;
  else if (inIndex === 1 && boardSlugs.has(s)) unionDupes++;
}

console.log(`milestone ${milestone.slug} (board ${milestone.board})`);
console.log(`  MilestoneCards partition : ${fromIndex === null ? "unmapped" : `${indexRows.length} rows`}  (${tIndex}ms)`);
console.log(`  board membership         : ${fromBoard.length} rows  (${tBoard}ms)`);
console.log(`  distinct slugs to verify : ${slugs.length}`);
console.log(`  slugs with >1 index row  : ${realIndexDupes}  <-- genuine index drift`);
console.log(`  slugs in index AND board : ${unionDupes}  <-- union artifact, NOT drift`);
console.log("");

// --- read phase, fanned out (the shape the fix should have) ---
const t2 = Date.now();
const truths = await mapWithConcurrency(slugs, (s) => findCardSummaryForReconcile(node, cfg, s), POINT_READ_CONCURRENCY);
const tConcurrent = Date.now() - t2;

// --- read phase, serial, on a bounded sample (the shape it has today) ---
const sample = slugs.slice(0, Math.min(6, slugs.length));
const t3 = Date.now();
for (const s of sample) await findCardSummaryForReconcile(node, cfg, s);
const tSerialSample = Date.now() - t3;
const perRead = sample.length ? tSerialSample / sample.length : 0;

// --- classify: what does reconcile WRITE? (shipped logic, mirrored) ---
let orphan = 0; // truth missing -> retire the index rows
let foreign = 0; // truth points elsewhere -> retire the index rows
let missing = 0; // no index row at all -> upsert (the repair that was skipped)
let duplicate = 0; // >1 index row -> upsert (purges the rest)
let clean = 0;
let removeWrites = 0;
let upsertWrites = 0;

slugs.forEach((s, i) => {
  const rows = rowsBySlug.get(s) ?? [];
  const truth = truths[i];
  if (!truth) {
    orphan++;
    if (rows.length) removeWrites += 1; // one call per slug; it purges the rest
    return;
  }
  if ((truth.milestone ?? "") !== milestone.slug || (truth.board || "default") !== milestone.board) {
    foreign++;
    if (rows.length) removeWrites += 1;
    return;
  }
  if (rows.length === 0) {
    missing++;
    upsertWrites += 1;
    return;
  }
  if (rows.length > 1) {
    duplicate++;
    upsertWrites += 1;
    return;
  }
  clean++;
});

// What the pre-fix classification would have written: it merged index and board
// rows and called any slug without exactly one row stale, so every slug present
// in both was rewritten and every slug present only on the board was skipped.
const legacyWrites = realIndexDupes + unionDupes;

const writes = removeWrites + upsertWrites;
console.log("READ PHASE");
console.log(`  serial, measured on ${sample.length} slugs : ${tSerialSample}ms  (${perRead.toFixed(0)}ms/read)`);
console.log(`  serial, projected over ${slugs.length}     : ${(perRead * slugs.length / 1000).toFixed(1)}s`);
console.log(`  fanned out at width ${POINT_READ_CONCURRENCY}          : ${(tConcurrent / 1000).toFixed(1)}s   <-- all ${slugs.length}, actually run`);
console.log("");
console.log("WRITE PHASE (classified, NOT issued)");
console.log(`  orphan slugs (no such card)   : ${orphan}`);
console.log(`  foreign slugs (moved away)    : ${foreign}`);
console.log(`  missing-index slugs           : ${missing}  <-- repair the pre-fix code skipped`);
console.log(`  duplicate-index slugs         : ${duplicate}`);
console.log(`  clean slugs                   : ${clean}`);
console.log(`  => removeMilestoneCard calls  : ${removeWrites}`);
console.log(`  => upsertMilestoneCard calls  : ${upsertWrites}`);
console.log(`  => TOTAL serial mutations     : ${writes}`);
console.log(`     at 2.4s/write (best seen)  : ${(writes * 2.4 / 60).toFixed(1)} min`);
console.log(`     at 8.3s/write (idle floor) : ${(writes * 8.3 / 60).toFixed(1)} min`);
console.log("");
console.log(`  pre-fix classification would write : ${legacyWrites}  (${unionDupes} of them pure waste)`);
console.log(`  and would leave un-repaired        : ${missing} missing index rows`);
console.log("");
console.log(
  writes * 2.4 > tConcurrent / 1000
    ? "VERDICT: the write phase dominates. Fanning out the reads alone will not make this command terminate."
    : "VERDICT: the read phase dominates for this milestone.",
);
