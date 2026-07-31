#!/usr/bin/env bun
/**
 * Is the BoardMilestones index actually answering, or is `milestone list`
 * quietly full-scanning `Milestone` every time?
 *
 * `BOARD_MILESTONES_FIELDS` (the projection every partition read sends)
 * includes `completed_at`, but `boardMilestoneFieldsFromMilestone` omits it on
 * purpose. LastDB drops a row when a PROJECTED field has no atom on it, so if
 * the live rows were written by the current writer, the wide read returns
 * nothing — and `listAllBoardMilestones` reports a successful, authoritative
 * empty partition.
 *
 * Read-only. Counts rows at three widths against the real primary.
 *
 *   bun scripts/probe-board-milestones-projection.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { BOARD_MILESTONES_FIELDS, BOARD_MILESTONES_LAYOUT } from "../src/schemas.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});
const schemaHash = cfg.schemaHashes.board_milestones;
if (!schemaHash) {
  console.log("board_milestones not bound in config — nothing to probe");
  process.exit(0);
}

const boards = ["default", "agent-dogfood-scratch"];

const widths: Array<{ label: string; fields: readonly string[] }> = [
  { label: `full BOARD_MILESTONES_FIELDS (${BOARD_MILESTONES_FIELDS.length})`, fields: BOARD_MILESTONES_FIELDS },
  { label: "without completed_at", fields: BOARD_MILESTONES_FIELDS.filter((f) => f !== "completed_at") },
  { label: "slug + layout only", fields: ["slug", "layout"] },
  { label: "slug only", fields: ["slug"] },
];

for (const board of boards) {
  console.log(`\n=== board: ${board} ===`);
  for (const w of widths) {
    const t0 = performance.now();
    try {
      const res = await node.queryAll({
        schemaHash,
        fields: [...w.fields],
        filter: { HashKey: board },
      });
      const rows = res.results ?? [];
      const withLayout = rows.filter(
        (r) => String(((r.fields ?? {}) as Record<string, unknown>).layout ?? "") === BOARD_MILESTONES_LAYOUT,
      ).length;
      const ms = Math.round(performance.now() - t0);
      const layoutNote = w.fields.includes("layout") ? `, layout-ok=${withLayout}` : "";
      console.log(`  ${w.label.padEnd(42)} rows=${String(rows.length).padStart(4)}${layoutNote}  ${ms}ms`);
    } catch (err) {
      console.log(`  ${w.label.padEnd(42)} THREW: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// Which fields do the live rows actually carry?
const probe = await node.queryAll({ schemaHash, fields: ["slug"], filter: { HashKey: "default" } });
console.log(`\nlive rows on default (slug-only read): ${probe.results?.length ?? 0}`);
const sample = (probe.results ?? [])[0];
if (sample) {
  const wide = await node.queryAll({
    schemaHash,
    fields: [...BOARD_MILESTONES_FIELDS],
    filter: { HashRangeKey: { hash: "default", range: String(sample.key?.range ?? "") } },
  });
  console.log(`same row re-read at full width: ${wide.results?.length ?? 0} row(s)`);
  if ((wide.results ?? []).length === 0) {
    console.log("  -> the full-width projection DROPS this row: a field it asks for has no atom.");
  }
}
