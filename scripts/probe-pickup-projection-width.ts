#!/usr/bin/env bun
/**
 * READ-ONLY probe: how much of a whole-partition BoardCards read is projection
 * WIDTH rather than row count?
 *
 * `probe-pickup-active-vs-whole.ts` refuted the obvious fix (read only the
 * active columns): 6 prefix queries + k point reads ran 797ms against 522ms for
 * 2 whole-partition reads, because per-query fixed overhead beats the archive
 * rows it avoids. So the archive rows have to be paid for — the open question
 * is how WIDE each of them is fetched.
 *
 * `pickup status` reads at 22 fields (`CARD_LIST_FIELDS` -> BoardCards
 * projection); `list --column`'s dep seed reads at 7. Same rows, same one query,
 * no extra round trip — so if width is a large share of the read, trimming it is
 * free in a way that splitting the read is not.
 *
 * Interleaved reps so node warmth cannot favour one width.
 *
 * Run: bun scripts/probe-pickup-projection-width.ts [reps]
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import {
  BOARD_CARDS_DEP_SEED_FIELDS,
  BOARD_CARDS_LIST_FIELDS,
  BOARD_CARDS_SPINE_FIELDS,
  boardCardsHash,
  boardCardsProjectionForCardFields,
} from "../src/board-cards.ts";
import { CARD_LIST_FIELDS, CARD_DISPLAY_FIELDS } from "../src/record.ts";

const reps = Number(process.argv[2] ?? 3);
const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});
const schemaHash = boardCardsHash(cfg);
if (!schemaHash) throw new Error("board_cards schema hash not configured");

const shapes: Array<{ name: string; fields: readonly string[] }> = [
  { name: "pickup  (CARD_LIST_FIELDS)", fields: boardCardsProjectionForCardFields([...CARD_LIST_FIELDS]) },
  { name: "list    (CARD_DISPLAY_FIELDS)", fields: boardCardsProjectionForCardFields([...CARD_DISPLAY_FIELDS]) },
  { name: "BOARD_CARDS_LIST_FIELDS", fields: BOARD_CARDS_LIST_FIELDS },
  { name: "dep seed (BOARD_CARDS_DEP_SEED_FIELDS)", fields: BOARD_CARDS_DEP_SEED_FIELDS },
  { name: "spine   (BOARD_CARDS_SPINE_FIELDS)", fields: BOARD_CARDS_SPINE_FIELDS },
];

const timings = new Map<string, number[]>();
const rowCounts = new Map<string, number>();

for (let i = 1; i <= reps; i++) {
  console.log(` rep ${i}`);
  for (const s of shapes) {
    const t0 = performance.now();
    const res = await node.queryAll({
      schemaHash,
      fields: [...s.fields],
      filter: { HashKey: "default" } as never,
    });
    const t = Math.round(performance.now() - t0);
    (timings.get(s.name) ?? timings.set(s.name, []).get(s.name)!).push(t);
    rowCounts.set(s.name, res.results.length);
    // Non-empty rows: the projection-drop rule says a narrow projection can
    // return rows carrying nothing but the leading field. Count what survives.
    const withSlug = res.results.filter(
      (r) => typeof (r.fields as Record<string, unknown>)?.slug === "string" &&
        ((r.fields as Record<string, unknown>).slug as string).length > 0,
    ).length;
    console.log(
      `   ${s.name.padEnd(38)} fields=${String(s.fields.length).padStart(2)} ` +
        `rows=${String(res.results.length).padStart(3)} slug-bearing=${String(withSlug).padStart(3)} ${String(t).padStart(5)}ms`,
    );
  }
}

const med = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
console.log(`\n== median of ${reps} reps, HashKey(default), ${rowCounts.get(shapes[0].name)} rows ==`);
const base = med(timings.get(shapes[0].name)!);
for (const s of shapes) {
  const m = med(timings.get(s.name)!);
  const pct = Math.round((m / base) * 100);
  console.log(`  ${s.name.padEnd(38)} fields=${String(s.fields.length).padStart(2)} ${String(m).padStart(5)}ms  ${String(pct).padStart(3)}% of pickup`);
}
