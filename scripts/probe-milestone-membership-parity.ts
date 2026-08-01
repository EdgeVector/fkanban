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
 * This asks the fat `Milestone` schema (the truth) and the index (the view)
 * the same question and diffs them, addressing index rows by their RANGE KEY
 * rather than through the display read — the display read can deny a partial
 * row and would under-report the index, inventing drift that is not there.
 *
 * Read-only: queries only, no mutations.
 *
 *   bun scripts/probe-milestone-membership-parity.ts
 *
 * ## READ THIS BEFORE BELIEVING ITS "TRUTH" COLUMN (measured 2026-08-01)
 *
 * The fat-`Milestone` `allowFullScan` below is NOT a reliable enumeration, and
 * the run that wrote this probe nearly reported its diff as drift.
 *
 * On the live primary it returned 64 key-hashes where the index holds 33 and
 * `kanban milestone list` reports 33. Both halves of the gap are artefacts:
 *
 *   - 45 of the 64 came back with NO atoms at all — no `slug`, `board`,
 *     `state` or `position`, only a key hash, which the code below then falls
 *     back to reading as the slug. Spot-checking three of them
 *     (`feature-fkanban-milestones`, `operation-trinity-proof-charter-terminal`,
 *     `routines-target-fleet-proof`) against `kanban milestone show` returns
 *     `Milestone not found`. They are husks of DELETED milestones, not
 *     invisible live ones.
 *   - 14 index rows had no counterpart in the scan at all, including
 *     `lastdb-0231-read-regression-fixes`, which is demonstrably live. So the
 *     scan also MISSES real rows.
 *
 * A scan that returns deleted husks and omits live rows cannot establish
 * truth, so this probe cannot establish drift against it. What it CAN do is
 * report the index side (`view`) and the duplicate/stale-sk checks, which are
 * addressed by range key and are sound. The `INVISIBLE`/`ORPHAN` columns need
 * a real enumeration — a per-slug point read via `findMilestone`, or the fat
 * scan cross-checked against `milestone list` — before they mean anything.
 *
 * Left in place because knowing the scan lies is worth more than deleting the
 * evidence. Filed as
 * `papercut-kanban-milestone-full-scan-returns-husks-and-misses-live-rows`.
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { parseBoardMilestoneSk } from "../src/board-milestones.ts";

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

// ---- truth: the fat Milestone schema, one HashKey per milestone ------------
const truth = new Map<string, { board: string; state: string; position: string }>();
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
    if (!slug) continue;
    truth.set(slug, {
      board: (typeof f.board === "string" && f.board) || "default",
      state: typeof f.state === "string" ? f.state : "",
      position: typeof f.position === "string" ? f.position : "",
    });
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

console.log(`fat Milestone rows : ${truth.size}`);
console.log(`BoardMilestones slugs: ${view.size} (${[...view.values()].reduce((n, r) => n + r.length, 0)} rows)`);
console.log("");

const missing = [...truth.keys()].filter((s) => !view.has(s)).sort();
const orphan = [...view.keys()].filter((s) => !truth.has(s)).sort();
const dup = [...view.entries()].filter(([, rows]) => rows.length > 1).sort();

console.log(`INVISIBLE  (in truth, no index row) : ${missing.length}`);
for (const s of missing) {
  const t = truth.get(s)!;
  console.log(`    ${s}  board=${t.board} state=${t.state} pos=${t.position}`);
}
console.log(`ORPHAN     (index row, no truth)    : ${orphan.length}`);
for (const s of orphan) {
  for (const r of view.get(s)!) console.log(`    ${s}  board=${r.board} sk=${r.sk}`);
}
console.log(`DUPLICATE  (>1 index row for slug)  : ${dup.length}`);
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
