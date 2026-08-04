#!/usr/bin/env bun
/**
 * READ-ONLY probe: how complete is the DEFAULT product list read, and which
 * candidate projection fixes it?
 *
 * Context: `papercut-kanban-boardcards-product-list-is-gated-on-milestone`
 * wrote up two candidate fixes and asked for a cost measurement before either
 * was chosen. Both candidates as written assume that dropping `milestone`
 * makes the default list complete. Under HASH-ELSE-LEAD that is only half the
 * story — with `milestone` gone the LEADING field gates instead, and
 * `BOARD_CARDS_LIST_FIELDS` leads with `board`, which the 2026-08-01 spine
 * measurement showed is itself sparse (19 rows carry no `board` atom).
 *
 * So this probe measures the leads as well as the field set, against a
 * baseline that can actually see its own failure.
 *
 * Identity is `key.range` — the row's REAL address, which the wire carries on
 * every row regardless of projection. `scripts/probe-boardcards-projection-drop.ts`
 * keys on the PAYLOAD copy `f.sk` instead, so a row missing an `sk` atom is
 * invisible to it in every arm INCLUDING its baseline, and it reports "zero
 * lost" by construction. Do not copy that pattern.
 *
 * Run: bun scripts/probe-list-projection-completeness.ts
 */
import { readConfig, schemaHashFor } from "../src/config.ts";
import { newNodeClient, type QueryFilter } from "../src/client.ts";
import { listBoards } from "../src/record.ts";
import {
  BOARD_CARDS_SPINE_FIELDS,
  BOARD_CARDS_DISPLAY_FIELDS,
  BOARD_CARDS_LIST_FIELDS,
  sweepBoardCardsPartition,
} from "../src/board-cards.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});
const schemaHash = schemaHashFor("board_cards", cfg);
if (!schemaHash) {
  console.error("no board_cards schema hash in config — nothing to probe");
  process.exit(1);
}

/** Row addresses returned by one projection, plus wall time. */
async function probe(
  board: string,
  fields: readonly string[],
): Promise<{ keys: Set<string>; ms: number }> {
  const filter = { HashKey: board } as QueryFilter;
  const t0 = performance.now();
  const res = await node.queryAll({ schemaHash: schemaHash!, fields: [...fields], filter });
  const ms = performance.now() - t0;
  const keys = new Set<string>();
  for (const r of res.results) {
    // The REAL address. Never the payload copy — see the header.
    const k = (r as { key?: { range?: string | null } }).key?.range;
    if (typeof k === "string" && k.length > 0) keys.add(k);
  }
  return { keys, ms };
}

const withoutMilestone = BOARD_CARDS_LIST_FIELDS.filter((f) => f !== "milestone");
const leadSlug = (fs: readonly string[]) => ["slug", ...fs.filter((f) => f !== "slug")];

const CANDIDATES: Array<[string, readonly string[]]> = [
  ["LIST (shipped today)", BOARD_CARDS_LIST_FIELDS],
  ["DISPLAY (shipped today)", BOARD_CARDS_DISPLAY_FIELDS],
  ["A: LIST − milestone (papercut option 1)", withoutMilestone],
  ["B: A, led by slug", leadSlug(withoutMilestone)],
  ["C: B − board (drop-and-stamp)", leadSlug(withoutMilestone.filter((f) => f !== "board"))],
  ["spine (for reference)", BOARD_CARDS_SPINE_FIELDS],
  ["[slug] (narrowest known)", ["slug"]],
];

const boards = await listBoards(node, cfg);

for (const b of boards) {
  const sweep = await sweepBoardCardsPartition(node, cfg, b.slug);
  if (!sweep) continue;
  const complete = new Set(sweep.rows.map((r) => r.sk));
  if (complete.size === 0) continue;
  console.log(`\n── board ${b.slug} — sweep sees ${complete.size} rows` +
    (sweep.failedLeads.length ? ` (⚠ ${sweep.failedLeads.length} failed leads — LOWER BOUND)` : ""));
  console.log(`   ${"projection".padEnd(40)} ${"rows".padStart(5)} ${"lost".padStart(5)}  ms`);
  for (const [label, fields] of CANDIDATES) {
    const { keys, ms } = await probe(b.slug, fields);
    const lost = [...complete].filter((k) => !keys.has(k));
    const extra = [...keys].filter((k) => !complete.has(k));
    console.log(
      `   ${label.padEnd(40)} ${String(keys.size).padStart(5)} ${String(lost.length).padStart(5)}  ${ms.toFixed(0)}ms` +
      (extra.length ? `  (+${extra.length} the sweep missed!)` : ""),
    );
    if (lost.length > 0 && lost.length <= 8) {
      for (const k of lost) console.log(`        lost: ${k}`);
    }
  }
}
