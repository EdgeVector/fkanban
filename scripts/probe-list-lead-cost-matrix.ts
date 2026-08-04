#!/usr/bin/env bun
/**
 * READ-ONLY probe: for ONE fixed field set, what does the LEADING field cost?
 *
 * `probe-list-projection-completeness.ts` showed that dropping `milestone` from
 * the product list projection is ~114ms cheaper, and that re-leading the same
 * set with `slug` gives the saving back. Both arms changed two things at once
 * (the set AND the lead), so neither isolates the lead.
 *
 * This holds the field set constant at `LIST − milestone` and rotates only
 * which field leads. Under HASH-ELSE-LEAD the lead is the row GATE whenever the
 * hash field is unprojected, so this is simultaneously a cost table and a
 * density table — the two axes the choice has to trade.
 *
 * Interleaved reps, because the node's cold/warm shard state moves more than
 * the effect being measured.
 *
 * Run: bun scripts/probe-list-lead-cost-matrix.ts [reps]
 */
import { readConfig, schemaHashFor } from "../src/config.ts";
import { newNodeClient, type QueryFilter } from "../src/client.ts";
import { listBoards } from "../src/record.ts";
import { BOARD_CARDS_LIST_FIELDS, sweepBoardCardsPartition } from "../src/board-cards.ts";

const REPS = Number(process.argv[2] ?? 3);
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

const BASE = BOARD_CARDS_LIST_FIELDS.filter((f) => f !== "milestone");
// Every field in the set is a candidate lead, plus `milestone` as the control
// (it is the hash field, so it gates from any position — leading with it should
// look exactly like projecting it anywhere).
const LEADS = [...BASE, "milestone"];

async function run(board: string, lead: string) {
  const fields = lead === "milestone"
    ? ["milestone", ...BASE]
    : [lead, ...BASE.filter((f) => f !== lead)];
  const filter = { HashKey: board } as QueryFilter;
  const t0 = performance.now();
  const res = await node.queryAll({ schemaHash: schemaHash!, fields, filter });
  const ms = performance.now() - t0;
  const keys = new Set<string>();
  for (const r of res.results) {
    const k = (r as { key?: { range?: string | null } }).key?.range;
    if (typeof k === "string" && k.length > 0) keys.add(k);
  }
  return { ms, keys };
}

const boards = await listBoards(node, cfg);
for (const b of boards) {
  const sweep = await sweepBoardCardsPartition(node, cfg, b.slug);
  if (!sweep || sweep.rows.length === 0) continue;
  const complete = new Set(sweep.rows.map((r) => r.sk));
  console.log(`\n── board ${b.slug} — ${complete.size} rows (sweep), field set = LIST − milestone (${BASE.length} fields)`);

  const times = new Map<string, number[]>();
  const lost = new Map<string, number>();
  for (let i = 0; i < REPS; i++) {
    for (const lead of LEADS) {
      const { ms, keys } = await run(b.slug, lead);
      if (!times.has(lead)) times.set(lead, []);
      times.get(lead)!.push(ms);
      lost.set(lead, [...complete].filter((k) => !keys.has(k)).length);
    }
  }

  const rows = LEADS.map((lead) => {
    const ts = times.get(lead)!.slice().sort((a, b) => a - b);
    return { lead, med: ts[Math.floor(ts.length / 2)], min: ts[0], max: ts[ts.length - 1], lost: lost.get(lead)! };
  }).sort((a, b) => a.med - b.med);

  console.log(`   ${"lead".padEnd(14)} ${"median".padStart(7)} ${"min".padStart(6)} ${"max".padStart(6)} ${"lost".padStart(5)}`);
  for (const r of rows) {
    console.log(`   ${r.lead.padEnd(14)} ${r.med.toFixed(0).padStart(6)}ms ${r.min.toFixed(0).padStart(5)}m ${r.max.toFixed(0).padStart(5)}m ${String(r.lost).padStart(5)}`);
  }
}
