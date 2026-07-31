#!/usr/bin/env bun
/**
 * Probe: what does reading ONE BoardCards row cost on the live `default`
 * board, keyed by its exact sk?
 *
 * This is the price of making a narrow write SAFE. `updateRecord` on a
 * BoardCards row that does not exist silently succeeds and stores whatever
 * subset it was given (measured, probe-narrow-write-shape.ts), and LastDB
 * drops a row from any projection where a projected field has no atom — so a
 * narrow write issued blind can quietly delete a card from every list. A
 * keyed read before the write turns that into a decidable question.
 *
 * Read-only. Run: bun scripts/probe-boardcard-point-read.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { BOARD_CARDS_FIELDS } from "../src/schemas.ts";
import {
  BOARD_CARDS_SPINE_FIELDS,
  boardCardSk,
  boardCardsHash,
  listBoardCardsPartition,
} from "../src/board-cards.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});
const schemaHash = boardCardsHash(cfg);
if (!schemaHash) {
  console.error("board_cards schema not bound");
  process.exit(1);
}

const ms = async <T>(label: string, fn: () => Promise<T>): Promise<[T, number]> => {
  const t0 = performance.now();
  const v = await fn();
  const dt = performance.now() - t0;
  console.log(`  ${label.padEnd(48)} ${dt.toFixed(0).padStart(6)}ms`);
  return [v, dt];
};

const BOARD = "default";

// Pick a real card off the busiest active column via the drop-free spine read.
const [spine] = await ms("spine read (to pick a victim card)", () =>
  listBoardCardsPartition(node, cfg, BOARD, { fields: BOARD_CARDS_SPINE_FIELDS }),
);
const victim = (spine ?? []).find((c) => c.column === "todo") ?? (spine ?? [])[0];
if (!victim) {
  console.error("no cards on default");
  process.exit(1);
}
const sk = boardCardSk(victim.column, victim.position, victim.slug);
console.log(`\nvictim: ${victim.slug}  sk=${sk}\n`);

const pointRead = (fields: readonly string[]) =>
  node.queryAll({
    schemaHash,
    fields: [...fields],
    filter: { HashRangePrefix: { hash: BOARD, prefix: sk } } as never,
  });

const REPS = 5;
const wide: number[] = [];
const spineOnly: number[] = [];
console.log(`== keyed point read (HashRangePrefix on the full sk), ${REPS} interleaved reps ==`);
for (let r = 0; r < REPS; r += 1) {
  const [w, wms] = await ms(`rep ${r + 1}  24-field projection`, () => pointRead(BOARD_CARDS_FIELDS));
  wide.push(wms);
  if (r === 0) console.log(`      -> ${w.results.length} row(s)`);
  const [, sms] = await ms(`rep ${r + 1}   5-field spine`, () => pointRead(BOARD_CARDS_SPINE_FIELDS));
  spineOnly.push(sms);
}

const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
console.log("\n== verdict (median) ==");
console.log(`  point read, 24 fields   ${med(wide).toFixed(0)}ms`);
console.log(`  point read, 5 fields    ${med(spineOnly).toFixed(0)}ms`);
console.log(
  `\n  A read-then-narrow-write would cost ~${(med(wide) + 620).toFixed(0)}ms ` +
    `against the ~4695ms a wide upsert measures today.`,
);
