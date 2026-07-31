#!/usr/bin/env bun
/**
 * READ-ONLY probe: is the Card full scan a CENSUS, or only an oracle?
 *
 * `scanBoardsForReconcile` learned rule 2 the hard way — "a scan is not a
 * census", it omits live records a point read returns — and defends against it
 * with an `alsoConsider` parameter so a caller can force a verdict on a slug the
 * scan never listed. `scanCardSummariesForReconcile` documents the same hazard
 * in prose and has no such parameter.
 *
 * That gap only matters if the Card scan actually omits reachable slugs. This
 * measures it, rather than reasoning from the Board result:
 *
 *   A. slugs the BoardCards partitions know about (a keyed read, independent of
 *      the scan) that the Card full scan never lists, yet `cardExists` confirms.
 *      Each one is a card `migrate legacy-columns` can never nominate — even
 *      when the operator names it explicitly with `--slugs`.
 *   B. the same question for the `all_cards` rollup's slugs.
 *
 * Non-zero A is a silent under-migration: the command reports success having
 * never considered the card.
 *
 * Run: bun scripts/probe-card-scan-census.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { cardExists, listBoards, scanCardSummariesForReconcile } from "../src/record.ts";
import { listBoardCardsPartition } from "../src/board-cards.ts";
import { readCardListIndex } from "../src/card-list-index.ts";
import { mapWithConcurrency } from "../src/concurrency.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const boards = await listBoards(node, cfg);
const membership = new Set<string>();
for (const b of boards) {
  for (const c of (await listBoardCardsPartition(node, cfg, b.slug)) ?? []) {
    if (c.slug) membership.add(c.slug);
  }
}

const scanRows = await scanCardSummariesForReconcile(node, cfg);
const scanned = new Set(scanRows.map((c) => c.slug).filter(Boolean));
const rollup = new Set(((await readCardListIndex(node, cfg)) ?? []).map((c) => c.slug).filter(Boolean));

const missingFromScan = [...membership].filter((s) => !scanned.has(s));
const rollupMissingFromScan = [...rollup].filter((s) => !scanned.has(s) && !membership.has(s));

console.log(`boards:                      ${boards.length}`);
console.log(`BoardCards membership slugs: ${membership.size}`);
console.log(`Card scan rows / slugs:      ${scanRows.length} / ${scanned.size}`);
console.log(`all_cards rollup slugs:      ${rollup.size}`);
console.log("");
console.log(`A. membered but NOT in scan:  ${missingFromScan.length}`);
console.log(`B. rollup-only, NOT in scan:  ${rollupMissingFromScan.length}`);

// A slug absent from the scan is only interesting if the record is really there.
const verify = async (slugs: string[], label: string) => {
  if (slugs.length === 0) return;
  const checked = await mapWithConcurrency(slugs, async (slug) => ({
    slug,
    exists: await cardExists(node, cfg, slug),
  }));
  const live = checked.filter((c) => c.exists);
  console.log("");
  console.log(`${label}: ${live.length}/${slugs.length} confirmed present by keyed read`);
  for (const c of live.slice(0, 25)) console.log(`   ${c.slug}`);
  if (live.length > 25) console.log(`   … ${live.length - 25} more`);
};

await verify(missingFromScan, "A (census gap — migrate can never nominate these)");
await verify(rollupMissingFromScan, "B");

console.log("");
console.log(
  missingFromScan.length === 0 && rollupMissingFromScan.length === 0
    ? "Card scan listed every reachable slug in this sample — no census gap observed."
    : "Card scan is NOT a census: the slugs above exist and the scan does not list them.",
);
