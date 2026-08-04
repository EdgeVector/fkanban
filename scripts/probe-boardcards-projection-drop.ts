#!/usr/bin/env bun
/**
 * READ-ONLY probe: which BoardCards rows do the PRODUCT read paths lose?
 *
 * LastDB returns a row only when EVERY projected field has an atom on it, so a
 * partition read at N fields is a filter, not just a cost. `listCardBodies`
 * and `scripts/probe-scan-projection-width.ts` already measure this for the
 * Card SCAN. Nothing measures it for the BoardCards PARTITION — which is the
 * read behind `list`, `pickup`, the nav footer and the dep seed.
 *
 * The baseline is the all-leads SWEEP, not the spine. The spine was used here
 * for months on the claim that it is "drop-free — a row that lacked a spine
 * field could not have been keyed into the partition". That claim is false and
 * was retired by measurement: the spine leads with `board`, and 19 of 357 rows
 * on the live `default` partition carried no `board` atom. A baseline that
 * shares the blind spot under test cannot report a failure — both sides of the
 * subtraction dropped the same rows and the answer was always zero. See
 * `BOARD_CARDS_ADDRESS_FIELDS` and
 * `sweepBoardCardsPartition` for why the union over leading fields is the only
 * enumeration that is not itself a projection.
 *
 * Measured on the primary 2026-08-01: CLEAN — 335 rows on `default`, 1 on
 * `agent-dogfood-scratch`, zero lost at every projection from 5 to 24 fields.
 * The 2026-07-23 drift this guards against (a `milestone` column added to the
 * index and never backfilled, hiding 135 rows from every wide read) has been
 * healed. Keep it: the drift was silent, cost a reconciler its whole job, and
 * nothing else re-checks it.
 *
 * Run: bun scripts/probe-boardcards-projection-drop.ts
 */
import { readConfig, schemaHashFor } from "../src/config.ts";
import { newNodeClient, type QueryFilter } from "../src/client.ts";
import { listBoards } from "../src/record.ts";
import {
  BOARD_CARDS_SPINE_FIELDS,
  BOARD_CARDS_DEP_SEED_FIELDS,
  BOARD_CARDS_FOOTER_FIELDS,
  BOARD_CARDS_DISPLAY_FIELDS,
  BOARD_CARDS_LIST_FIELDS,
  sweepBoardCardsPartition,
} from "../src/board-cards.ts";
import { BOARD_CARDS_FIELDS } from "../src/schemas.ts";

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

async function skSet(board: string, fields: readonly string[]): Promise<Set<string>> {
  const filter = { HashKey: board } as QueryFilter;
  const res = await node.queryAll({ schemaHash: schemaHash!, fields: [...fields], filter });
  const out = new Set<string>();
  for (const r of res.results) {
    // The row's REAL address, which the wire carries on every row regardless of
    // projection — NOT the payload copy `fields.sk`. Keying on the copy made
    // every arm of this probe, including its own baseline, blind to exactly the
    // rows it exists to find: a partial write leaves `slug`/`title`/`column`/
    // `position` and no key copies, so those rows have no `sk` atom and were
    // silently skipped everywhere. The differences then netted to zero and this
    // script printed "CLEAN" while 19 such rows sat on the live `default`
    // partition. Corrected 2026-08-04.
    const range = (r as { key?: { range?: string | null } }).key?.range;
    if (typeof range === "string" && range.length > 0) out.add(range);
  }
  return out;
}

const PROJECTIONS: Array<[string, readonly string[]]> = [
  // Not a baseline — an arm like any other, and a lossy one: it leads with
  // `board`, which 19 of 357 live rows had no atom for on 2026-08-01.
  ["SPINE (board-led, itself lossy)", BOARD_CARDS_SPINE_FIELDS],
  ["DEP_SEED (list --column seed)", BOARD_CARDS_DEP_SEED_FIELDS],
  ["FOOTER (other-boards count)", BOARD_CARDS_FOOTER_FIELDS],
  ["DISPLAY (renderBoard)", BOARD_CARDS_DISPLAY_FIELDS],
  ["LIST (list/pickup/MCP json)", BOARD_CARDS_LIST_FIELDS],
  ["FULL (heal / write shape)", BOARD_CARDS_FIELDS],
];

const boards = await listBoards(node, cfg);
console.log(`boards: ${boards.map((b) => b.slug).join(", ")}\n`);

let totalLost = 0;
const lostByBoard = new Map<string, Set<string>>();

for (const b of boards) {
  const sweep = await sweepBoardCardsPartition(node, cfg, b.slug);
  if (sweep && sweep.failedLeads.length > 0) {
    const refused = sweep.failedLeads.map((f) => f.field).join(", ");
    console.log(`   [!] enumeration incomplete — node refused lead(s) ${refused}; LOST is a LOWER BOUND`);
  }
  const base = new Set((sweep?.rows ?? []).map((r) => r.sk));
  if (base.size === 0) continue;
  console.log(`── board ${b.slug} — ${base.size} rows in the partition`);
  for (const [label, fields] of PROJECTIONS) {
    const t0 = performance.now();
    const seen = await skSet(b.slug, fields);
    const ms = Math.round(performance.now() - t0);
    const lost = [...base].filter((sk) => !seen.has(sk));
    if (lost.length > 0) {
      const prev = lostByBoard.get(b.slug) ?? new Set<string>();
      for (const sk of lost) prev.add(sk);
      lostByBoard.set(b.slug, prev);
    }
    console.log(
      `   ${label.padEnd(30)} fields=${String(fields.length).padStart(2)}  rows=${String(seen.size).padStart(4)}  LOST=${String(lost.length).padStart(3)}  ${ms}ms`,
    );
  }
  console.log("");
}

for (const [board, lost] of lostByBoard) {
  totalLost += lost.size;
  console.log(`── per-field attribution on ${board} (${lost.size} rows lost by some projection)`);
  const attrSweep = await sweepBoardCardsPartition(node, cfg, board);
  const base = new Set((attrSweep?.rows ?? []).map((r) => r.sk));
  for (const field of BOARD_CARDS_FIELDS) {
    if ((BOARD_CARDS_SPINE_FIELDS as readonly string[]).includes(field)) continue;
    const seen = await skSet(board, [...BOARD_CARDS_SPINE_FIELDS, field]);
    const missing = [...base].filter((sk) => !seen.has(sk));
    if (missing.length > 0) {
      console.log(`   ${field.padEnd(16)} missing on ${String(missing.length).padStart(4)} rows`);
    }
  }
  const sample = [...lost].slice(0, 8);
  console.log(`   sample lost sks: ${sample.join(", ")}`);
  console.log("");
}

if (totalLost === 0) {
  console.log("no BoardCards row is dropped by any product projection on this node.");
} else {
  console.log(
    `TOTAL: ${totalLost} BoardCards rows are invisible to at least one product read path.`,
  );
}
