#!/usr/bin/env bun
/**
 * Can a multi-lead sweep of the fat `Milestone` schema reach live milestones
 * that the single-lead full scan misses?
 *
 * `groom milestone-indexes-heal` enumerates repair candidates from ONE scan
 * (`fields: fieldsFor("milestone")`, `allowFullScan: true`), unions that with
 * the BoardMilestones index rows, and repairs the union. A live milestone in
 * NEITHER set is unreachable by every repair path the product has — and the
 * command still prints `upserts=0` and exits 0, which reads as "converged".
 *
 * `sweepBoardMilestonesPartition` already solves the same shape on the index
 * side: query once per leading field, dedupe by key, and report leads the node
 * refused so a short answer can never be labelled complete. This probe measures
 * whether that technique buys real recall on the fat schema too, and what it
 * costs. Read-only — it point-reads to classify, and writes nothing.
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { fieldsFor } from "../src/schemas.ts";
import { listBoardMilestonesPartition } from "../src/board-milestones.ts";
import { findMilestone, listBoards } from "../src/record.ts";
import { mapWithConcurrency, PARTITION_READ_CONCURRENCY } from "../src/concurrency.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});
const hash = cfg.schemaHashes.milestone!;
const LEADS = [...fieldsFor("milestone")];

/** Slugs reachable when `lead` is the projected field. */
async function scanUnderLead(lead: string): Promise<{ slugs: Set<string>; error: string | null }> {
  try {
    const res = await node.queryAll({ schemaHash: hash, fields: [lead], allowFullScan: true });
    const out = new Set<string>();
    for (const r of res.results ?? []) {
      // The HashKey IS the slug on the fat schema; the payload copy is a copy.
      const keyed = typeof r.key?.hash === "string" ? r.key.hash : "";
      const copied = String((r.fields as Record<string, unknown>)?.slug ?? "");
      const slug = keyed || copied;
      if (slug) out.add(slug);
    }
    return { slugs: out, error: null };
  } catch (err) {
    return { slugs: new Set(), error: err instanceof Error ? err.message : String(err) };
  }
}

// What heal actually does today: one scan at the widest projection.
const healScan = await (async () => {
  const t = performance.now();
  const res = await node.queryAll({ schemaHash: hash, fields: LEADS, allowFullScan: true });
  const out = new Set<string>();
  for (const r of res.results ?? []) {
    const keyed = typeof r.key?.hash === "string" ? r.key.hash : "";
    const copied = String((r.fields as Record<string, unknown>)?.slug ?? "");
    const slug = keyed || copied;
    if (slug) out.add(slug);
  }
  return { slugs: out, ms: Math.round(performance.now() - t) };
})();

const sweepStart = performance.now();
const perLead = await mapWithConcurrency(LEADS, scanUnderLead, PARTITION_READ_CONCURRENCY);
const sweepMs = Math.round(performance.now() - sweepStart);

const union = new Set<string>();
const failedLeads: string[] = [];
LEADS.forEach((lead, i) => {
  const r = perLead[i]!;
  if (r.error) failedLeads.push(`${lead}: ${r.error}`);
  for (const s of r.slugs) union.add(s);
});

console.log("== Fat Milestone enumeration: one lead vs every lead ==\n");
console.log(`  heal's single wide scan (${LEADS.length} fields)  -> ${healScan.slugs.size} slugs   ${healScan.ms}ms`);
console.log(`  multi-lead sweep (${LEADS.length} leads)           -> ${union.size} slugs   ${sweepMs}ms`);
console.log(`  leads the node refused                  -> ${failedLeads.length}`);
for (const f of failedLeads) console.log(`      ${f}`);

const perLeadCounts = LEADS.map((lead, i) => `${lead}=${perLead[i]!.slugs.size}`).join(" ");
console.log(`\n  per-lead recall: ${perLeadCounts}`);

const sweepOnly = [...union].filter((s) => !healScan.slugs.has(s));
console.log(`\n  slugs the sweep found and the wide scan MISSED -> ${sweepOnly.length}`);

// The BoardMilestones index is heal's other candidate source. A live milestone
// in neither is the unreachable set this probe exists to size.
const boards = await listBoards(node, cfg);
const indexed = new Set<string>();
for (const b of boards) {
  const rows = await listBoardMilestonesPartition(node, cfg, b.slug);
  for (const r of rows ?? []) indexed.add(r.slug);
}

const candidates = new Set([...healScan.slugs, ...indexed]);
const outsideCandidates = [...union].filter((s) => !candidates.has(s));

console.log("\n== The unreachable set (live, but in neither candidate source) ==\n");
console.log(`  BoardMilestones index rows                    ${indexed.size}`);
console.log(`  heal candidate set (wide scan ∪ index)         ${candidates.size}`);
console.log(`  sweep-only slugs outside that candidate set    ${outsideCandidates.length}`);

const live: string[] = [];
const husks: string[] = [];
for (const slug of outsideCandidates) {
  const m = await findMilestone(node, cfg, slug);
  if (m) live.push(`${slug} (state=${m.state})`);
  else husks.push(slug);
}
console.log(`      point-read LIVE  ${live.length}`);
for (const l of live) console.log(`        ${l}`);
console.log(`      point-read husk  ${husks.length}`);

console.log("\n== Verdict ==\n");
if (live.length > 0) {
  console.log(`  RED: ${live.length} live milestone(s) are invisible to \`milestone list\`/\`portfolio\``);
  console.log(`  AND unreachable by \`groom milestone-indexes-heal\`, which reports upserts=0 and exits 0.`);
  console.log(`  A multi-lead sweep reaches them for +${sweepMs - healScan.ms}ms on the heal path.`);
} else if (sweepOnly.length > 0) {
  console.log(`  AMBER: the sweep out-recalls the wide scan by ${sweepOnly.length} slug(s), but the index`);
  console.log(`  currently covers them, so nothing is invisible right now.`);
} else {
  console.log(`  GREEN: the wide scan and the multi-lead sweep agree on this data.`);
}
