#!/usr/bin/env bun
/**
 * READ-ONLY probe: which single field in a projection is costing rows?
 *
 * `probe-product-projection-visibility.ts` measured BOARD_CARDS_DISPLAY_FIELDS
 * returning 0 rows on `HashKey=default` while `kanban list` — same wire width —
 * returns 214. Same width means the variable is WHICH fields, not how many, so
 * this leaves each one out in turn and reports the row count.
 *
 * Also prints the projection `kanban list` actually sends (derived through
 * `boardCardsProjectionForCardFields`, the product mapping) beside the module
 * constant, because those two are not the same list.
 *
 * Read-only. Run: bun scripts/probe-projection-leave-one-out.ts [board]
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import {
  BOARD_CARDS_DISPLAY_FIELDS,
  boardCardsProjectionForCardFields,
  boardCardsWireProjection,
} from "../src/board-cards.ts";
import { CARD_DISPLAY_FIELDS, CARD_LIST_FIELDS } from "../src/record.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const bcHash = cfg.schemaHashes?.board_cards;
if (!bcHash) {
  console.log("board_cards unbound — nothing to measure.");
  process.exit(0);
}
const BOARD = process.argv[2] ?? "default";

async function rows(fields: string[]): Promise<number | string> {
  try {
    const res = await node.queryAll({
      schemaHash: bcHash!,
      fields,
      filter: { HashKey: BOARD } as never,
    });
    return (res.results ?? []).length;
  } catch (err) {
    return `ERROR ${(err as Error).message.slice(0, 60)}`;
  }
}

const moduleWire = boardCardsWireProjection([...BOARD_CARDS_DISPLAY_FIELDS]);
const productDisplayWire = boardCardsWireProjection(
  boardCardsProjectionForCardFields([...CARD_DISPLAY_FIELDS]),
);
const productListWire = boardCardsWireProjection(
  boardCardsProjectionForCardFields([...CARD_LIST_FIELDS]),
);

console.log(`BoardCards / HashKey=${BOARD}\n`);
console.log(`  BOARD_CARDS_DISPLAY_FIELDS  -> wire [${moduleWire.join(", ")}]`);
console.log(`     rows = ${await rows(moduleWire)}\n`);
console.log(`  kanban list (text)          -> wire [${productDisplayWire.join(", ")}]`);
console.log(`     rows = ${await rows(productDisplayWire)}\n`);
console.log(`  kanban list --json / pickup  -> wire [${productListWire.join(", ")}]`);
console.log(`     rows = ${await rows(productListWire)}\n`);

console.log(`Leave-one-out over the module DISPLAY wire projection:\n`);
const full = await rows(moduleWire);
console.log(`  (all ${moduleWire.length} fields)`.padEnd(34) + ` rows = ${full}`);
for (const drop of moduleWire) {
  const without = moduleWire.filter((f) => f !== drop);
  console.log(`  minus ${drop}`.padEnd(34) + ` rows = ${await rows(without)}`);
}

console.log(`\nEach field ALONE (what it can reach by itself):\n`);
for (const f of moduleWire) {
  console.log(`  [${f}]`.padEnd(34) + ` rows = ${await rows([f])}`);
}
