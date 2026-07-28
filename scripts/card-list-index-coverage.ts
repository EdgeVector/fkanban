#!/usr/bin/env bun
/**
 * READ-ONLY coverage proof for retiring the CardListIndex `all_cards` rollup.
 *
 * `all_cards` is a single Hash row holding every card, rewritten in full on
 * every card mutation. BoardCards (HashRange, hash=board) already carries the
 * same body-free summary, one row per card, and is the primary read path — so
 * `all_cards` is redundant *provided BoardCards covers it*. This proves that
 * before `groom card-list-index-retire` is allowed to clear the payload.
 *
 *   bun scripts/card-list-index-coverage.ts
 *
 * Exit 0 when BoardCards covers every all_cards slug; exit 1 otherwise.
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { listBoards } from "../src/record.ts";
import { readCardListIndex, cardListIndexHash } from "../src/card-list-index.ts";
import { listAllBoardCards, boardCardsHash } from "../src/board-cards.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

console.log("card_list_index hash:", cardListIndexHash(cfg) ?? "(unset)");
console.log("board_cards      hash:", boardCardsHash(cfg) ?? "(unset)");

const indexed = (await readCardListIndex(node, cfg)) ?? [];
console.log(`all_cards entries: ${indexed.length}  serialized: ${JSON.stringify(indexed).length} B`);

const boards = await listBoards(node, cfg);
console.log("boards:", boards.map((b) => b.slug).join(", ") || "(none)");
const bc = (await listAllBoardCards(node, cfg, boards)) ?? [];
console.log(`BoardCards rows (deduped by slug): ${bc.length}`);

const bcBySlug = new Map(bc.map((c) => [c.slug, c]));
const idxSlugs = new Set(indexed.map((c) => c.slug));

const uncovered = [...idxSlugs].filter((s) => !bcBySlug.has(s));
const onlyBoardCards = [...bcBySlug.keys()].filter((s) => !idxSlugs.has(s));

console.log(`\nIn all_cards but NOT in BoardCards (blocks retire): ${uncovered.length}`);
for (const s of uncovered.slice(0, 40)) console.log("  -", s);
console.log(`\nIn BoardCards but NOT in all_cards (index already stale): ${onlyBoardCards.length}`);
for (const s of onlyBoardCards.slice(0, 40)) console.log("  +", s);

let drift = 0;
for (const c of indexed) {
  const b = bcBySlug.get(c.slug);
  if (!b) continue;
  if ((b.board || "default") !== (c.board || "default") || b.column !== c.column) {
    drift += 1;
    if (drift <= 20) {
      console.log(`  ~ ${c.slug}: index=${c.board}/${c.column} boardcards=${b.board}/${b.column}`);
    }
  }
}
console.log(`\nboard/column disagreements on shared slugs: ${drift}`);
console.log(uncovered.length === 0 ? "\nCOVERED — safe to retire all_cards" : "\nNOT COVERED — do not retire");
process.exit(uncovered.length === 0 ? 0 : 1);
