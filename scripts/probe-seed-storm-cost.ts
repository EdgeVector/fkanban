#!/usr/bin/env bun
/**
 * READ-ONLY probe: what does the `listCardsWithFields` index-seed fallback cost,
 * and is it reachable on the live primary?
 *
 * The fallback runs `for (const c of cards) await upsertBoardCard(node, cfg, c)`
 * — SERIAL, with no `previous` and no `skipOrphanPurge`, so every card pays a
 * wide keyed read PLUS a whole-partition orphan scan. It is entered when the
 * BoardCards partition query THREW, which on this node is the ordinary
 * backpressure signal (`service_timeout` / "too many concurrent reads").
 *
 * This probe measures the two per-card round trips and multiplies. It writes
 * NOTHING — it never calls upsertBoardCard.
 *
 * Run: bun scripts/probe-seed-storm-cost.ts
 */
import { readConfig, schemaHashFor } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { listBoards, listCards } from "../src/record.ts";
import {
  BOARD_CARDS_SPINE_FIELDS,
  boardCardsHash,
  listBoardCardsPartition,
} from "../src/board-cards.ts";
import { readCardListIndex, cardListIndexIsSuperseded } from "../src/card-list-index.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const time = async <T>(fn: () => Promise<T>): Promise<[T, number]> => {
  const t0 = performance.now();
  const v = await fn();
  return [v, Math.round(performance.now() - t0)];
};

// --- Reachability: would a BoardCards throw actually land in the seed branch?
const indexed = await readCardListIndex(node, cfg);
const superseded = cardListIndexIsSuperseded(cfg);
const indexedLen = indexed === null ? "null (row missing)" : `${indexed.length} entries`;
const fallsThrough = indexed === null || (indexed.length === 0 && superseded);
console.log("=== reachability of the write-seed branch");
console.log(`  readCardListIndex('all_cards') : ${indexedLen}`);
console.log(`  cardListIndexIsSuperseded      : ${superseded}`);
console.log(
  `  => on a BoardCards THROW, list ${fallsThrough ? "FALLS INTO the scan+seed branch" : "returns from the index instead"}`,
);

// --- Per-card cost of the two round trips upsertBoardCard makes in this path.
const boards = await listBoards(node, cfg);
const cards = await listCards(node, cfg, { boards });
const byBoard = new Map<string, number>();
for (const c of cards) byBoard.set(c.board || "default", (byBoard.get(c.board || "default") ?? 0) + 1);

console.log(`\n=== board sizes (${cards.length} live cards over ${boards.length} boards)`);
for (const [b, n] of [...byBoard.entries()].sort((a, b2) => b2[1] - a[1]).slice(0, 6)) {
  console.log(`  ${b.padEnd(28)} ${n}`);
}

console.log(`\n=== per-card round trips in the seed loop`);
const samples = 3;
let purgeTotal = 0;
for (let i = 0; i < samples; i += 1) {
  const [, ms] = await time(() =>
    listBoardCardsPartition(node, cfg, "default", { fields: BOARD_CARDS_SPINE_FIELDS }),
  );
  purgeTotal += ms;
  console.log(`  purgeOtherBoardCardRows partition read (default, spine) : ${ms}ms`);
}
const purgeAvg = Math.round(purgeTotal / samples);

const schemaHash = boardCardsHash(cfg);
const probeCard = cards.find((c) => (c.board || "default") === "default");
let wideAvg = 0;
if (schemaHash && probeCard) {
  let t = 0;
  for (let i = 0; i < samples; i += 1) {
    const [, ms] = await time(() =>
      node.queryAll({
        schemaHash,
        fields: [...BOARD_CARDS_SPINE_FIELDS],
        filter: { HashKey: "default" },
      }),
    );
    t += ms;
  }
  wideAvg = Math.round(t / samples);
  console.log(`  readWholeBoardCardRow-class keyed read                   : ~${wideAvg}ms`);
}

const defaultCards = byBoard.get("default") ?? 0;
const perCard = purgeAvg + wideAvg;
console.log(`\n=== projected cost of ONE seed fallback (serial, as written)`);
console.log(`  per card               : ~${perCard}ms (${wideAvg}ms probe + ${purgeAvg}ms partition purge)`);
console.log(`  cards on 'default'     : ${defaultCards}`);
console.log(`  all live cards         : ${cards.length}`);
console.log(
  `  serial total           : ~${Math.round((perCard * cards.length) / 1000)}s  (~${((perCard * cards.length) / 60000).toFixed(1)} min)`,
);
console.log(`  node operations issued : ~${cards.length * 2} reads + up to ${cards.length} writes`);
console.log(
  `\n  …all of it triggered BY a BoardCards read failing, i.e. when the node is already shedding.`,
);
