#!/usr/bin/env bun
/**
 * READ-ONLY probe: does the default (indexed) `kanban search` path find the
 * same LIVE cards the exhaustive `--complete` scan finds?
 *
 * `scripts/probe-search-reads.ts` showed the default path returning fewer
 * matches than `--complete`. That gap is only a defect if the missing cards are
 * LIVE BOARD CARDS. The Card full scan also surfaces archived/deleted ghosts
 * (run (k): 65 such slugs with cardExists=false), so a raw match-count
 * comparison over-claims — a card `--complete` finds and the default path drops
 * might be one that SHOULD be dropped.
 *
 * So classify the difference against board membership (BoardCards), which is
 * the index the write path actually maintains, rather than trusting counts.
 *
 * Run: bun scripts/probe-search-recall.ts [query ...]
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { searchResult } from "../src/commands/search.ts";
import { listAllBoardCards } from "../src/board-cards.ts";
import { listBoards } from "../src/record.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

// Board membership = the live board. A slug here is a card a user can see with
// `kanban list`; a slug absent here is not on any board.
const boards = await listBoards(node, cfg);
const membership = (await listAllBoardCards(node, cfg, boards)) ?? [];
const liveSlugs = new Set(membership.map((m) => m.slug));
console.log(`board membership: ${liveSlugs.size} live slugs (${membership.length} rows, ${boards.length} boards)`);

const queries = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["lastdb", "reconcile", "board"];

for (const q of queries) {
  const fast = await searchResult({ cfg, node, query: q });
  const full = await searchResult({ cfg, node, query: q, complete: true });

  const fastSlugs = new Set(fast.cards.map((c) => c.slug));
  const fullSlugs = new Set(full.cards.map((c) => c.slug));

  const missedAll = [...fullSlugs].filter((s) => !fastSlugs.has(s));
  const missedLive = missedAll.filter((s) => liveSlugs.has(s));
  const missedGhost = missedAll.filter((s) => !liveSlugs.has(s));
  // The converse matters too: anything the fast path returns that the full scan
  // does not would mean the fast path invents matches.
  const extraInFast = [...fastSlugs].filter((s) => !fullSlugs.has(s));

  console.log(`\n=== "${q}"`);
  console.log(`  default (indexed)  : ${fastSlugs.size} matches`);
  console.log(`  --complete (scan)  : ${fullSlugs.size} matches`);
  console.log(`  missed by default  : ${missedAll.length}`);
  console.log(`    of which LIVE board cards : ${missedLive.length}   <-- real recall loss`);
  console.log(`    of which off-board ghosts : ${missedGhost.length}   <-- correctly dropped`);
  console.log(`  returned by default but not by scan: ${extraInFast.length}`);
  if (missedLive.length > 0) {
    console.log(`  sample missed-live slugs: ${missedLive.slice(0, 8).join(", ")}`);
  }
}
