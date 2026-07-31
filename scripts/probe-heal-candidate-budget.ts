#!/usr/bin/env bun
/**
 * READ-ONLY probe: how many Card point reads does `groom board-cards-heal`
 * make, before vs after moving the `--board` filter off the scan?
 *
 * Heal point-reads Card truth once per distinct candidate slug. The candidate
 * set used to be narrowed by a scan-derived board (`t.board || "default"`);
 * it is now narrowed by whether the slug has a BoardCards row at all, with the
 * `--board` filter applied after truth answers. That is more correct — a blank
 * scan board can no longer deny a card candidacy — but on a FILTERED run it can
 * only widen the set, so the cost belongs in the record next to the fix.
 *
 * Both numbers are computed from the same live reads, so they are comparable.
 *
 * Run: bun scripts/probe-heal-candidate-budget.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { listBoards, scanCardSummariesForReconcile } from "../src/record.ts";
import { listBoardCardsPartition } from "../src/board-cards.ts";
import { readCardListIndex, cardListIndexIsSuperseded } from "../src/card-list-index.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const boards = await listBoards(node, cfg);

// Discovery, exactly as heal does it — plus the scan's board, which only the
// OLD code consulted.
const scanBoard = new Map<string, string | undefined>();
if (cardListIndexIsSuperseded(cfg)) {
  for (const c of await scanCardSummariesForReconcile(node, cfg)) {
    if (c.slug) scanBoard.set(c.slug, c.board);
  }
}
for (const c of (await readCardListIndex(node, cfg)) ?? []) {
  if (c.slug && !scanBoard.has(c.slug)) scanBoard.set(c.slug, c.board);
}

const rowsByBoard = new Map<string, Set<string>>();
for (const b of boards) {
  const slugs = new Set<string>();
  for (const c of (await listBoardCardsPartition(node, cfg, b.slug)) ?? []) {
    if (c.slug) slugs.add(c.slug);
  }
  rowsByBoard.set(b.slug, slugs);
}

const report = (label: string, boardFilter: string | null) => {
  const targets = boardFilter ? [boardFilter] : boards.map((b) => b.slug);
  const withRows = new Set<string>();
  for (const t of targets) for (const s of rowsByBoard.get(t) ?? []) withRows.add(s);

  // BEFORE: synthetic candidate iff the scan's guessed board equals the filter
  // (and no row already keys it there).
  const before = new Set(withRows);
  for (const [slug, board] of scanBoard) {
    const guess = board || "default";
    if (boardFilter && guess !== boardFilter) continue;
    before.add(slug);
  }

  // AFTER: synthetic candidate iff the slug has no membership row on ANY board
  // — answered by one spine read per non-target partition, not by point reads.
  const memberedAnywhere = new Set<string>();
  for (const slugs of rowsByBoard.values()) for (const s of slugs) memberedAnywhere.add(s);
  const after = new Set(withRows);
  for (const slug of scanBoard.keys()) if (!memberedAnywhere.has(slug)) after.add(slug);

  const missedByGuess = [...scanBoard.keys()].filter((s) => !before.has(s) && after.has(s));
  console.log(
    `${label.padEnd(34)} point reads before=${String(before.size).padStart(4)}  ` +
      `after=${String(after.size).padStart(4)}  delta=${after.size - before.size >= 0 ? "+" : ""}${after.size - before.size}` +
      `   (${missedByGuess.length} slugs the old guess never point-read)`,
  );
};

console.log(`boards: ${boards.map((b) => b.slug).join(", ")}`);
console.log(`candidate slugs from discovery: ${scanBoard.size}`);
console.log("");
report("unfiltered", null);
for (const b of boards) report(`--board ${b.slug}`, b.slug);
console.log("");
console.log("Reads are per-run and bounded by discovery; heal is a manual/scheduled");
console.log("reconciler, never a list path. A slug the old guess never read is a card");
console.log("`--board X` could not repair.");
