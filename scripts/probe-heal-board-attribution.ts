#!/usr/bin/env bun
/**
 * READ-ONLY probe: `board_cards_heal` attributes a card to a board using the
 * Card FULL SCAN's `board` field. How often is that field wrong?
 *
 * `scanCardSummariesForReconcile` is documented as a SLUG ORACLE ONLY — its
 * non-slug fields are blank on most rows, and the 47 duplicated slugs resolve
 * last-write-wins. Heal honours that for WRITES (every repair is authored by a
 * point read of Card truth) but not for two SELECTION decisions at
 * `board_cards_heal.ts:315-322`:
 *
 *   const board = t.board || "default";                 // scan-derived
 *   if (boardFilter && board !== boardFilter) continue; // (1) skips the card
 *   byKey.set(`${board}\0${slug}`, []);                 // (2) synthesises a key
 *
 * (1) means `groom board-cards-heal --board X` silently drops a card whose scan
 *     row is blank, even though truth says it is on X and its membership row is
 *     the thing heal exists to restore.
 * (2) means a card whose membership is ALREADY correct on X can be enqueued a
 *     second time under `default`, where rows=[] reads as "missing membership".
 *
 * This measures both against Card truth, over the slugs heal would consider.
 *
 * Run: bun scripts/probe-heal-board-attribution.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { listBoards, scanCardSummariesForReconcile, findCardSummaryForReconcile } from "../src/record.ts";
import { listBoardCardsPartition } from "../src/board-cards.ts";
import { mapWithConcurrency } from "../src/concurrency.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const boards = await listBoards(node, cfg);
console.log(`boards: ${boards.map((b) => b.slug).join(", ")}`);

// Exactly heal's discovery step, including its last-write-wins map.
const scanRows = await scanCardSummariesForReconcile(node, cfg);
const indexedBySlug = new Map<string, { slug: string; board?: string }>();
for (const c of scanRows) if (c.slug) indexedBySlug.set(c.slug, { slug: c.slug, board: c.board });

const blank = [...indexedBySlug.values()].filter((t) => !t.board);
console.log(`scan rows: ${scanRows.length}  distinct slugs: ${indexedBySlug.size}`);
console.log(`slugs whose winning scan row has BLANK board: ${blank.length}`);

// Where does membership actually live? (keyed partition reads, independent of scan)
const memberBoard = new Map<string, string>();
for (const b of boards) {
  for (const c of (await listBoardCardsPartition(node, cfg, b.slug)) ?? []) {
    if (c.slug) memberBoard.set(c.slug, b.slug);
  }
}

// Truth for every slug heal would consider.
const truths = await mapWithConcurrency([...indexedBySlug.keys()], async (slug) => ({
  slug,
  truth: await findCardSummaryForReconcile(node, cfg, slug),
}));

let misattributed = 0;
let wouldDoubleEnqueue = 0;
const skippedByFilter = new Map<string, string[]>();
const examples: string[] = [];

for (const { slug, truth } of truths) {
  if (!truth) continue; // archived ghost — heal drops it correctly
  const scanBoard = (indexedBySlug.get(slug)?.board || "default");
  const truthBoard = truth.board || "default";
  if (scanBoard !== truthBoard) {
    misattributed += 1;
    if (examples.length < 15) {
      examples.push(`   ${slug}\n      scan board="${indexedBySlug.get(slug)?.board}" -> "${scanBoard}"   truth board="${truthBoard}"`);
    }
    // (2): membership already correct on truthBoard, but heal also keys it under scanBoard
    if (memberBoard.get(slug) === truthBoard) wouldDoubleEnqueue += 1;
  }
  // (1): which --board runs would silently skip this card?
  for (const b of boards) {
    if (truthBoard === b.slug && scanBoard !== b.slug) {
      skippedByFilter.set(b.slug, [...(skippedByFilter.get(b.slug) ?? []), slug]);
    }
  }
}

console.log("");
console.log(`cards whose SCAN board disagrees with TRUTH board: ${misattributed}`);
console.log(`  of those, membership already correct (spurious "missing membership"): ${wouldDoubleEnqueue}`);
if (examples.length) {
  console.log("");
  console.log("examples:");
  for (const e of examples) console.log(e);
}

console.log("");
console.log("(1) cards `groom board-cards-heal --board <X>` would silently SKIP:");
for (const b of boards) {
  const skipped = skippedByFilter.get(b.slug) ?? [];
  console.log(`   --board ${b.slug}: ${skipped.length} skipped`);
  for (const s of skipped.slice(0, 10)) console.log(`      ${s}`);
  if (skipped.length > 10) console.log(`      … ${skipped.length - 10} more`);
}
