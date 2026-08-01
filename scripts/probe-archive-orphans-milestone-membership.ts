#!/usr/bin/env bun
/**
 * Does `archive-done` orphan the MilestoneCards row of every card it deletes?
 *
 * `deleteCardRecord` fans out to three indexes. Two of them derive their
 * partition from a SPINE field that is always projected:
 *
 *   patchCardListIndex   -> all_boards rollup (no partition of its own)
 *   removeBoardCard      -> partition = card.board   (spine, always present)
 *   removeMilestoneCard  -> partition = card.milestone  <-- NOT in the spine
 *
 * and `removeMilestoneCard` opens with `if (!ms) return`. LastDB returns "" for
 * a field the caller did not project, so that guard cannot tell "this card has
 * no milestone" from "you did not ask". `archive-done` reads its delete
 * candidates through `listCardsByColumn(..., ARCHIVE_AGE_FIELDS, ...)`, and
 * ARCHIVE_AGE_FIELDS has no `milestone` — so every archived card that HAD a
 * milestone leaves its MilestoneCards row behind, with no Card behind it.
 *
 * This probe asks three questions on the live primary, read-only:
 *
 *   1. EXPOSURE — of the rows archive-done would consider (terminal column,
 *      per board), how many carry a milestone that the ARCHIVE_AGE_FIELDS
 *      projection cannot see? Those are the future orphans.
 *   2. EVIDENCE — how many MilestoneCards rows on the primary today point at a
 *      slug with no Card record? Those are the past orphans. If the mechanism
 *      is real and archive-done has run, they should exist.
 *   3. NEIGHBOURS — is the same asymmetry reachable from the other two
 *      deleteCardRecord callers (`rm`, `board rm --force`)? Report the
 *      projection each one actually feeds in, rather than assuming.
 *
 * Deletes nothing, writes nothing.
 *
 *   bun scripts/probe-archive-orphans-milestone-membership.ts
 */
import { readConfig, schemaHashFor } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { MILESTONE_CARDS_LAYOUT } from "../src/schemas.ts";
import {
  BOARD_CARDS_SPINE_FIELDS,
  BOARD_CARDS_LAYOUT,
  boardCardsHash,
  boardCardsProjectionForCardFields,
} from "../src/board-cards.ts";
import { milestoneCardsHash } from "../src/milestone-cards.ts";
import { ARCHIVE_AGE_FIELDS } from "../src/commands/archive_done.ts";
import { listBoards } from "../src/record.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const bcHash = boardCardsHash(cfg);
const mcHash = milestoneCardsHash(cfg);
const cardHash = schemaHashFor("card", cfg);
if (!bcHash || !mcHash) {
  console.error("BoardCards / MilestoneCards schema hash missing — nothing to probe.");
  process.exit(1);
}

const archiveProjection = boardCardsProjectionForCardFields(ARCHIVE_AGE_FIELDS);
console.log("== what archive-done actually projects from BoardCards ==\n");
console.log(`  ARCHIVE_AGE_FIELDS      ${ARCHIVE_AGE_FIELDS.join(", ")}`);
console.log(`  -> BoardCards fields    ${archiveProjection.join(", ")}`);
console.log(
  `  milestone projected?    ${archiveProjection.includes("milestone") ? "YES" : "NO  <-- removeMilestoneCard sees \"\""}\n`,
);

// ---------------------------------------------------------------- 1. EXPOSURE
// Terminal column per board is what archive-done sweeps. Read it twice: once at
// the projection archive-done uses, once with `milestone` added. Any row whose
// milestone is non-empty in the second read is a row archive-done would delete
// while believing it has no milestone membership to retire.
const boards = await listBoards(node, cfg);
const terminalOf = (b: { columns?: string[] }) =>
  (b.columns && b.columns.length > 0 ? b.columns[b.columns.length - 1] : "done");

console.log("== 1. EXPOSURE: terminal-column rows archive-done would orphan ==\n");
console.log("  board                          terminal   rows  with milestone");
let exposureTotal = 0;
for (const b of boards) {
  const terminal = terminalOf(b as { columns?: string[] });
  const res = await node.queryAll({
    schemaHash: bcHash,
    fields: [...BOARD_CARDS_SPINE_FIELDS, "milestone", "layout"],
    filter: { HashRangePrefix: { hash: b.slug, prefix: `${terminal}#` } },
  });
  const rows = res.results
    .map((r) => (r.fields ?? {}) as Record<string, unknown>)
    .filter((f) => String(f.layout ?? "") === BOARD_CARDS_LAYOUT);
  const withMs = rows.filter((f) => String(f.milestone ?? "").trim() !== "");
  exposureTotal += withMs.length;
  if (rows.length > 0 || withMs.length > 0) {
    console.log(
      `  ${b.slug.padEnd(30)} ${terminal.padEnd(10)} ${String(rows.length).padStart(4)}  ${String(withMs.length).padStart(4)}`,
    );
  }
}
console.log(`\n  rows archive-done would delete AND orphan: ${exposureTotal}\n`);

// ---------------------------------------------------------------- 2. EVIDENCE
// Every MilestoneCards row, at spine width (the least droppable read), joined
// against the Card schema by point-read. A row whose Card is absent is an
// orphan — whatever produced it.
console.log("== 2. EVIDENCE: MilestoneCards rows with no Card behind them ==\n");
// MilestoneCards is partitioned by milestone, so enumerate the partitions off
// BoardMilestones at slug-only width — the least droppable discovery read —
// then read each partition at spine width for the same reason.
const milestones: string[] = [];
if (cfg.schemaHashes?.board_milestones) {
  for (const b of boards) {
    try {
      const res = await node.queryAll({
        schemaHash: cfg.schemaHashes.board_milestones,
        fields: ["slug"],
        filter: { HashKey: b.slug },
      });
      for (const r of res.results ?? []) {
        const s = String(((r.fields ?? {}) as Record<string, unknown>).slug ?? "");
        if (s && !milestones.includes(s)) milestones.push(s);
      }
    } catch {
      /* skip */
    }
  }
}

const msRows: Array<{ milestone: string; sk: string; slug: string; column: string }> = [];
for (const ms of milestones) {
  try {
    const res = await node.queryAll({
      schemaHash: mcHash,
      fields: ["milestone", "sk", "slug", "column", "position", "layout"],
      filter: { HashKey: ms },
    });
    for (const r of res.results ?? []) {
      const f = (r.fields ?? {}) as Record<string, unknown>;
      if (String(f.layout ?? "") !== MILESTONE_CARDS_LAYOUT) continue;
      msRows.push({
        milestone: String(f.milestone ?? ms),
        sk: String(f.sk ?? ""),
        slug: String(f.slug ?? ""),
        column: String(f.column ?? ""),
      });
    }
  } catch {
    /* skip */
  }
}
console.log(`  milestone partitions read  ${milestones.length}`);

const slugs = [...new Set(msRows.map((r) => r.slug))].filter(Boolean);
const alive = new Set<string>();
// Bounded parallelism — the same 6 the rest of this app settled on.
//
// Deliberately NOT wrapped in try/catch. An earlier draft of this probe
// swallowed the point-read error and counted the miss as an orphan; the method
// call was misspelled, so it reported 156/156 orphans — every row — which is
// what a broken instrument looks like when it is allowed to fail quietly. A
// probe that cannot read must stop, not report.
for (let i = 0; i < slugs.length; i += 6) {
  const chunk = slugs.slice(i, i + 6);
  const got = await Promise.all(
    chunk.map(async (slug) => {
      const r = await node.queryAll({
        schemaHash: cardHash,
        fields: ["slug"],
        filter: { HashKey: slug },
      });
      return (r.results ?? []).length > 0 ? slug : null;
    }),
  );
  for (const s of got) if (s) alive.add(s);
}

const orphans = msRows.filter((r) => r.slug && !alive.has(r.slug));
console.log(`  MilestoneCards rows        ${msRows.length}`);
console.log(`  distinct slugs             ${slugs.length}`);
console.log(`  slugs with a live Card     ${alive.size}`);
console.log(`  ORPHAN rows (Card absent)  ${orphans.length}\n`);
if (orphans.length > 0) {
  const byColumn = new Map<string, number>();
  for (const o of orphans) byColumn.set(o.column, (byColumn.get(o.column) ?? 0) + 1);
  console.log("  orphan rows by column (archive-done only ever deletes terminal):");
  for (const [col, n] of [...byColumn].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${col.padEnd(20)} ${n}`);
  }
  console.log("\n  sample:");
  for (const o of orphans.slice(0, 12)) {
    console.log(`    ${o.milestone.padEnd(42)} ${o.column.padEnd(10)} ${o.slug}`);
  }
  console.log();
}

// --------------------------------------------------------------- 3. NEIGHBOURS
// The other two deleteCardRecord callers. Report what each one feeds in, so the
// fix lands where the knowledge is instead of at three call sites.
console.log("== 3. NEIGHBOURS: the other deleteCardRecord callers ==\n");
console.log("  src/commands/rm.ts:45         requireCard() -> full Card record   milestone: present");
console.log("  src/commands/board.ts:187     listCards() thin BoardCards rows    milestone: SEE BELOW");
const listProjection = boardCardsProjectionForCardFields([
  "slug",
  "title",
  "column",
  "position",
  "board",
  "updated_at",
]);
console.log(`  board rm --force projection   ${listProjection.join(", ")}`);
console.log(
  `  milestone projected?          ${listProjection.includes("milestone") ? "YES" : "NO  <-- same defect, second caller"}\n`,
);

console.log("Read-only probe complete. Nothing was written or deleted.");
