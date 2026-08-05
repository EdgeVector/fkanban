#!/usr/bin/env bun
/**
 * Does `milestone list`'s own read drop BoardMilestones rows that ARE in the
 * index?
 *
 * `kanban doctor` reports the BoardCards partition has a projection GATE: the
 * catalog hash_field is an atom-optional field, and "any read that projects it
 * drops every row with no such atom, from any position in the field list."
 *
 * `listBoardMilestonesPartition` — the read behind `milestone list`,
 * `milestone portfolio` and `gap-report` — projects all 15
 * `BOARD_MILESTONES_FIELDS`. Its sibling `listBoardMilestonesPartitionSpine`
 * projects only `slug`. If the wide read returns FEWER rows than the spine,
 * the index is fine and the READ is losing milestones, which is a different
 * bug from the one the heal was built to fix — and one no amount of healing
 * can repair.
 *
 * Read-only: two partition queries per board plus a point-read per discrepancy.
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import {
  listBoardMilestonesPartition,
  listBoardMilestonesPartitionSpine,
  sweepBoardMilestonesPartition,
} from "../src/board-milestones.ts";
import { findMilestone, listBoards } from "../src/record.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const boards = await listBoards(node, cfg);
console.log("== BoardMilestones: wide display read vs narrow spine vs full sweep ==\n");

const missingEverywhere: string[] = [];

for (const b of boards) {
  const tW = performance.now();
  const wide = await listBoardMilestonesPartition(node, cfg, b.slug);
  const wideMs = Math.round(performance.now() - tW);

  const tS = performance.now();
  const spine = await listBoardMilestonesPartitionSpine(node, cfg, b.slug);
  const spineMs = Math.round(performance.now() - tS);

  const tA = performance.now();
  const sweep = await sweepBoardMilestonesPartition(node, cfg, b.slug);
  const sweepMs = Math.round(performance.now() - tA);

  const wideSlugs = new Set((wide ?? []).map((m) => m.slug));
  const spineSlugs = new Set((spine ?? []).map((r) => r.slug));
  const sweepSlugs = new Set((sweep?.rows ?? []).map((r) => r.slug));

  console.log(`board=${b.slug}`);
  console.log(`  wide display read (15 fields)  -> ${wideSlugs.size} rows   ${wideMs}ms   <- what \`milestone list\` serves`);
  console.log(`  narrow spine     (1 field)     -> ${spineSlugs.size} rows   ${spineMs}ms`);
  console.log(`  full sweep       (15 leads)    -> ${sweepSlugs.size} rows   ${sweepMs}ms   failedLeads=${sweep?.failedLeads.length ?? "n/a"}`);

  const spineOnly = [...spineSlugs].filter((s) => !wideSlugs.has(s));
  const sweepOnly = [...sweepSlugs].filter((s) => !wideSlugs.has(s));
  console.log(`  in spine but NOT served by list -> ${spineOnly.length}${spineOnly.length ? ": " + spineOnly.join(", ") : ""}`);
  console.log(`  in sweep but NOT served by list -> ${sweepOnly.length}${sweepOnly.length ? ": " + sweepOnly.join(", ") : ""}`);

  for (const s of new Set([...spineOnly, ...sweepOnly])) {
    const m = await findMilestone(node, cfg, s);
    console.log(`      ${s} -> point-read ${m ? `LIVE state=${m.state}` : "husk (gone)"}`);
    if (m) missingEverywhere.push(`${b.slug}/${s} (${m.state})`);
  }
  console.log("");
}

console.log("== Verdict ==\n");
if (missingEverywhere.length > 0) {
  console.log(`  RED: ${missingEverywhere.length} live milestone(s) have a BoardMilestones row that the`);
  console.log(`  wide display read refuses to return. The index is NOT the problem; the read is.`);
  for (const m of missingEverywhere) console.log(`    ${m}`);
} else {
  console.log("  GREEN: the wide display read returns every row the spine and sweep can reach.");
  console.log("  Any invisible milestone is missing from the index itself, not gated by the read.");
}
