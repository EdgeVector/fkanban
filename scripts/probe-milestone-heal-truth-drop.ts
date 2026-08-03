#!/usr/bin/env bun
/**
 * Does `groom milestone-indexes-heal` enumerate milestone TRUTH completely?
 *
 * It full-scans `Milestone` with `fields: fieldsFor("milestone")` — the widest
 * possible projection — and then treats "slug absent from that scan" as
 * authority to DELETE the slug's BoardMilestones row. Read-only.
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { fieldsFor } from "../src/schemas.ts";
import { listBoardMilestonesPartition } from "../src/board-milestones.ts";
import { listBoards } from "../src/record.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});
const hash = cfg.schemaHashes.milestone!;

async function scan(fields: readonly string[]): Promise<Set<string>> {
  const res = await node.queryAll({ schemaHash: hash, fields: [...fields], allowFullScan: true });
  const out = new Set<string>();
  for (const r of res.results ?? []) {
    const s = String((r.fields as Record<string, unknown>)?.slug ?? "");
    if (s) out.add(s);
  }
  return out;
}

const wide = await scan(fieldsFor("milestone"));
const narrow = await scan(["slug"]);
const title = await scan(["title"]);

console.log("== Milestone truth enumeration, by projection width ==\n");
console.log(`  fieldsFor("milestone")  ${fieldsFor("milestone").length} fields   -> ${wide.size} slugs   <- what heal uses`);
console.log(`  ["slug"]                 1 field    -> ${narrow.size} slugs`);
console.log(`  ["title"]                1 field    -> ${title.size} slugs`);

const union = new Set([...narrow, ...title]);
console.log(`  union(slug,title)                   -> ${union.size} slugs\n`);

const boards = await listBoards(node, cfg);
let indexRows = 0;
const wouldRemove: string[] = [];
for (const b of boards) {
  const rows = await listBoardMilestonesPartition(node, cfg, b.slug);
  if (!rows) continue;
  indexRows += rows.length;
  for (const row of rows) if (!wide.has(row.slug)) wouldRemove.push(`${b.slug}/${row.slug}`);
}

console.log("== What heal would DELETE from BoardMilestones ==\n");
console.log(`  BoardMilestones rows            ${indexRows}`);
console.log(`  rows whose slug is absent from heal's truth scan -> REMOVE  ${wouldRemove.length}`);

console.log("");
const { findMilestone } = await import("../src/record.ts");
let live = 0, dead = 0;
const liveSlugs: string[] = [];
for (const k of wouldRemove) {
  const slug = k.split("/").slice(1).join("/");
  const m = await findMilestone(node, cfg, slug);
  if (m) { live++; liveSlugs.push(slug); } else dead++;
}
console.log(`  point-read (findMilestone) says LIVE  ${live}   <-- heal would destroy these`);
console.log(`  point-read says genuinely gone        ${dead}\n`);
for (const s of liveSlugs.slice(0, 15)) console.log(`    LIVE: ${s}`);
console.log("\nRead-only probe complete. Nothing was written or deleted.");
