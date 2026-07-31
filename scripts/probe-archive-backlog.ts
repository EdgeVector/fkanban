#!/usr/bin/env bun
/**
 * READ-ONLY probe: how big is the archive backlog the dead daily sweep left?
 *
 * `~/.fkanban/archive-done.ts` has logged `SKIP: could not read board` on every
 * fire since 2026-07-23 (it shells `bun run ~/code/edgevector/fkanban/src/cli.ts`,
 * a path that ceased to exist when fkanban became a portal). This measures what
 * that cost: how many terminal cards are past the 24h cutoff, and how much of
 * the hot partition they are.
 *
 * Run: bun scripts/probe-archive-backlog.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { listBoards, listCardsByColumn } from "../src/record.ts";

// `updated_at` is the age signal, and it is NOT in CARD_STATUS_FIELDS — project
// it explicitly or every card reads back "" and Date.parse gives NaN.
const AGE_FIELDS = ["slug", "board", "column", "position", "updated_at", "kind", "tags"];
import { listBoardCardsPartitionSpine } from "../src/board-cards.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const CUTOFF_HOURS = 24;
const now = Date.now();
const boards = await listBoards(node, cfg);

let grandTotal = 0;
let grandStale = 0;

for (const b of boards) {
  const terminal = b.columns[b.columns.length - 1] ?? "done";
  const spine = (await listBoardCardsPartitionSpine(node, cfg, b.slug)) ?? [];
  const cards = await listCardsByColumn(node, cfg, terminal, AGE_FIELDS, b.slug);
  const withTime = cards.filter((c) => Number.isFinite(Date.parse(c.updated_at)));
  const stale = withTime.filter((c) => now - Date.parse(c.updated_at) >= CUTOFF_HOURS * 3600_000);
  const ages = stale
    .map((c) => (now - Date.parse(c.updated_at)) / 86400_000)
    .sort((x, y) => y - x);

  grandTotal += spine.length;
  grandStale += stale.length;

  console.log(`board ${b.slug}  (terminal column: ${terminal})`);
  console.log(`  partition rows          ${spine.length}`);
  console.log(`  in terminal column      ${cards.length}`);
  console.log(`  ... with parsable time  ${withTime.length}`);
  console.log(`  ... past ${CUTOFF_HOURS}h cutoff    ${stale.length}`);
  if (ages.length > 0) {
    console.log(`  oldest / median age     ${ages[0].toFixed(1)}d / ${ages[Math.floor(ages.length / 2)].toFixed(1)}d`);
  }
  console.log();
}

console.log(`TOTAL partition rows fleet-wide: ${grandTotal}`);
console.log(`TOTAL archivable right now:      ${grandStale}`);
console.log(
  `partition after a working sweep:  ${grandTotal - grandStale} rows ` +
    `(${(((grandTotal - grandStale) / grandTotal) * 100).toFixed(0)}% of today)`,
);
