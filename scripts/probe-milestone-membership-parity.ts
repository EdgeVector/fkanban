#!/usr/bin/env bun
/**
 * Has the BoardMilestones delete-before-write window already dropped a
 * milestone on the live primary?
 *
 * `upsertBoardMilestone` retires the source sk BEFORE the destination row is
 * durable, so a failed destination write leaves the milestone with no
 * BoardMilestones row at all. Unlike the BoardCards case, the index read does
 * NOT fall back: `listAllBoardMilestones` only returns null when a partition
 * query THREW. A partition that answers, minus one row, is authoritative — so
 * a milestone that lost its row is simply absent from `milestone list`,
 * `milestone portfolio` and `groom`.
 *
 * Read-only: queries only, no mutations.
 *
 *   bun scripts/probe-milestone-membership-parity.ts
 *
 * ## Truth is established by POINT READ, not by the fat scan
 *
 * The index side (`view`) is read by RANGE KEY, which is sound — the display
 * read can deny a partial row and would under-report the index, inventing
 * drift that is not there.
 *
 * The truth side may NOT be read by `allowFullScan` over the fat `Milestone`
 * schema. That scan lies in both directions
 * (`papercut-kanban-milestone-full-scan-returns-husks-and-misses-live-rows`):
 * it returns key-hash HUSKS of deleted milestones that `milestone show` cannot
 * open, and it MISSES live rows the keyed partition query returns. A probe that
 * diffs the index against it reports drift that does not exist.
 *
 * That is not hypothetical, and it is why this probe now point-reads. Run
 * against the live primary on 2026-08-03 the scan-based version reported 35
 * ORPHAN + 12 INVISIBLE + 2 STALE SK — **49 discrepancies, every one a
 * phantom.** Each of the 35 "orphans" point-read fine, at exactly the state its
 * index sk encoded; each of the 12 "invisible" milestones point-read as
 * `Milestone not found`. The index was clean. The hazard the papercut names is
 * a repair sweep deleting live index rows to match a phantom truth set, and the
 * distance between this probe's old output and that sweep was one person
 * believing the numbers.
 *
 * The previous version carried all of that as a 30-line header warning above
 * output that still printed 49 confident lines of drift. A caveat a reader must
 * remember to apply is not a guard. So truth is now enumerated the way the
 * papercut prescribes — a per-slug `findMilestone` point read, the same read
 * `milestone show` trusts — over the UNION of the scan's slugs and the index's
 * slugs, so neither source's blind spot can hide a milestone from the diff.
 *
 * The scan is still issued, purely to keep measuring how badly it lies: the
 * `scan fidelity` block below reports its husks and its misses. That evidence
 * was worth keeping. It is no longer allowed to contaminate the verdicts.
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { parseBoardMilestoneSk } from "../src/board-milestones.ts";
import { findMilestone } from "../src/record.ts";
import { mapWithConcurrency } from "../src/concurrency.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const bmHash = cfg.schemaHashes.board_milestones;
const msHash = cfg.schemaHashes.milestone;
if (!bmHash || !msHash) {
  console.log("board_milestones or milestone not bound in config — nothing to probe");
  process.exit(0);
}

const boards = ["default", "agent-dogfood-scratch"];

// ---- candidate slugs, source 1: the fat Milestone scan ---------------------
// Not truth — a candidate list. A husk still names a slug worth point-reading,
// and a point read is what decides whether anything is actually there.
const scanned = new Set<string>();
{
  const res = await node.queryAll({
    schemaHash: msHash,
    fields: ["slug", "board", "state", "position"],
    allowFullScan: true,
  });
  for (const r of res.results) {
    const f = (r.fields ?? {}) as Record<string, unknown>;
    const slug = typeof f.slug === "string" && f.slug.length > 0
      ? f.slug
      : typeof r.key?.hash === "string"
        ? r.key.hash
        : "";
    if (slug) scanned.add(slug);
  }
}

// ---- view: BoardMilestones, addressed by range key ------------------------
const view = new Map<string, Array<{ board: string; sk: string }>>();
for (const board of boards) {
  let res;
  try {
    res = await node.queryAll({ schemaHash: bmHash, fields: ["slug"], filter: { HashKey: board } });
  } catch (err) {
    console.log(`  partition ${board}: QUERY FAILED (${err instanceof Error ? err.message : err})`);
    console.log("  a partition that could not be read proves nothing — aborting");
    process.exit(1);
  }
  for (const r of res.results) {
    const sk = typeof r.key?.range === "string" ? r.key.range : "";
    if (!sk) continue;
    const parsed = parseBoardMilestoneSk(sk);
    const f = (r.fields ?? {}) as Record<string, unknown>;
    const slug = parsed?.slug ?? (typeof f.slug === "string" ? f.slug : "");
    if (!slug) continue;
    const rows = view.get(slug) ?? [];
    rows.push({ board, sk });
    view.set(slug, rows);
  }
}

// ---- truth: one point read per candidate ----------------------------------
// The union matters. Reading only the scan's slugs would miss a live milestone
// the scan omits; reading only the index's slugs could never find a milestone
// whose index row was dropped — which is the exact failure this probe exists to
// detect. A milestone absent from BOTH is unreachable by any read kanban has,
// so it is out of scope by construction, not by choice.
const candidates = [...new Set([...scanned, ...view.keys()])].sort();
const truth = new Map<string, { board: string; state: string; position: string }>();
{
  const found = await mapWithConcurrency(candidates, async (slug) => {
    const m = await findMilestone(node, cfg, slug);
    return m ? ([slug, m] as const) : null;
  });
  for (const hit of found) {
    if (!hit) continue;
    const [slug, m] = hit;
    truth.set(slug, {
      board: m.board || "default",
      state: m.state ?? "",
      position: String(m.position ?? ""),
    });
  }
}

console.log(`candidates point-read : ${candidates.length}  (scan ${scanned.size} ∪ index ${view.size})`);
console.log(`live Milestone rows   : ${truth.size}`);
console.log(`BoardMilestones slugs : ${view.size} (${[...view.values()].reduce((n, r) => n + r.length, 0)} rows)`);
console.log("");

const missing = [...truth.keys()].filter((s) => !view.has(s)).sort();
const orphan = [...view.keys()].filter((s) => !truth.has(s)).sort();
const dup = [...view.entries()].filter(([, rows]) => rows.length > 1).sort();

console.log(`INVISIBLE  (live, no index row)  : ${missing.length}`);
for (const s of missing) {
  const t = truth.get(s)!;
  console.log(`    ${s}  board=${t.board} state=${t.state} pos=${t.position}`);
}
console.log(`ORPHAN     (index row, not live) : ${orphan.length}`);
for (const s of orphan) {
  for (const r of view.get(s)!) console.log(`    ${s}  board=${r.board} sk=${r.sk}`);
}
console.log(`DUPLICATE  (>1 index row/slug)   : ${dup.length}`);
for (const [s, rows] of dup) {
  console.log(`    ${s}  ${rows.map((r) => `${r.board}/${r.sk}`).join("  ")}`);
}
console.log("");

// A milestone whose index sk disagrees with truth is not invisible, but it is
// a row the next upsert will retire — worth separating from a clean match.
let stale = 0;
for (const [slug, t] of truth) {
  const rows = view.get(slug);
  if (!rows) continue;
  const want = `${t.state}#${String(t.position).padStart(8, "0")}#${slug}`;
  if (!rows.some((r) => r.board === t.board && r.sk === want)) {
    stale += 1;
    console.log(`STALE SK   ${slug}  want ${t.board}/${want}  have ${rows.map((r) => `${r.board}/${r.sk}`).join(" ")}`);
  }
}
console.log(`stale-sk rows: ${stale}`);
console.log("");

// ---- scan fidelity: how badly did the full scan lie this run? --------------
// Kept as MEASUREMENT, not as a verdict input. If husks and misses ever both
// reach 0 the papercut's premise has changed on the node side and is worth
// re-testing; until then this is the standing evidence that milestone
// enumeration must not go through the scan.
const husks = [...scanned].filter((s) => !truth.has(s)).sort();
const missedByScan = [...truth.keys()].filter((s) => !scanned.has(s)).sort();
console.log(
  `scan fidelity: ${scanned.size} scanned, ${husks.length} husks (scanned but not live), ` +
    `${missedByScan.length} live rows the scan missed`,
);
if (husks.length > 0 || missedByScan.length > 0) {
  console.log(
    "  → the fat Milestone allowFullScan is still unsound as an enumeration " +
      "(papercut-kanban-milestone-full-scan-returns-husks-and-misses-live-rows).",
  );
}
