#!/usr/bin/env bun
/**
 * Can a board's ACTIVE set be read as key ranges instead of the whole partition?
 *
 * `pickup status` reads every BoardCards row on every board and then throws the
 * terminal column away client-side (`activeCards`). On the live default board
 * that is 141 `done` rows discarded out of 169 — 83% of the read.
 *
 * Run (d) already refuted the obvious fix and the refutation is why this probe
 * exists rather than a patch: reading the ACTIVE COLUMNS as six
 * `HashRangePrefix` queries plus k point reads LOST to two whole-partition
 * reads (797ms vs 522ms), because a kanban read pays for round trips, not rows.
 * So the question is not "can we read fewer rows" — it is "can we read fewer
 * rows WITHOUT paying more round trips".
 *
 * `HashRangeFilter::HashRangeRange { hash, start, end }` (inclusive start,
 * exclusive end) answers that, and fkanban uses it nowhere today — the only two
 * shapes in `board-cards.ts` are `HashKey` (whole partition) and
 * `HashRangePrefix` (one column). The terminal column is a single contiguous
 * span of the sort key (`done#…`), so its COMPLEMENT is exactly two ranges:
 *
 *     ["", "done#")   and   ["done$", "￿")     // '$' is the char after '#'
 *
 * Two round trips per board, whatever the column list is — it does not scale
 * with column count the way the six-prefix shape did, and it needs no point
 * reads. That is the shape this probe measures.
 *
 * Verdict equality is checked too: a cost win that returns a different active
 * set is a bug, not an optimisation.
 *
 *   bun scripts/probe-nonterminal-range-vs-whole.ts          # default board
 *   bun scripts/probe-nonterminal-range-vs-whole.ts 7        # 7 reps
 *
 * Reps alternate A/B so neither shape gets the warm cache all to itself.
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient, type NodeClient, type QueryFilter } from "../src/client.ts";
import { listBoards } from "../src/record.ts";
import { boardCardsHash, BOARD_CARDS_LIST_FIELDS } from "../src/board-cards.ts";

const reps = Number(process.argv[2] ?? 5);
const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const schemaHash = boardCardsHash(cfg);
if (!schemaHash) {
  console.error("board_cards schema not bound in config — nothing to measure");
  process.exit(1);
}
const fields = [...BOARD_CARDS_LIST_FIELDS];

/** Char after '#', so `["done$", …)` starts strictly past every `done#…` key. */
const AFTER_HASH = "$";
const UPPER = "￿";

async function query(filter: QueryFilter): Promise<Array<Record<string, unknown>>> {
  const res = await (node as NodeClient).queryAll({ schemaHash: schemaHash!, fields, filter });
  // Rows come back as `{ fields: {...} }` envelopes — unwrap, or every field
  // read is `undefined` and the terminal filter silently matches nothing.
  return (res.results as Array<{ fields?: Record<string, unknown> }>).map(
    (r) => (r.fields ?? (r as Record<string, unknown>)) as Record<string, unknown>,
  );
}

// The list projection carries `column`, not `sk` — classify off the field the
// production read actually has, or the terminal filter silently matches nothing.
const columnOf = (r: Record<string, unknown>) => String(r["column"] ?? "");
const slugOf = (r: Record<string, unknown>) => String(r["slug"] ?? "");

/** A: what pickup does today — whole partition, filter the terminal column off. */
async function whole(board: string, terminal: string): Promise<string[]> {
  const rows = await query({ HashKey: board } as unknown as QueryFilter);
  return rows.filter((r) => columnOf(r) !== terminal).map(slugOf).sort();
}

/** B: the two ranges that bracket the terminal column, read concurrently. */
async function ranges(board: string, terminal: string): Promise<string[]> {
  const below = { HashRangeRange: { hash: board, start: "", end: `${terminal}#` } };
  const above = {
    HashRangeRange: { hash: board, start: `${terminal}${AFTER_HASH}`, end: UPPER },
  };
  const [lo, hi] = await Promise.all([
    query(below as unknown as QueryFilter),
    query(above as unknown as QueryFilter),
  ]);
  return [...lo, ...hi].map(slugOf).sort();
}

const boards = await listBoards(node, cfg);
console.log(`boards: ${boards.map((b) => b.slug).join(", ")}`);

for (const b of boards) {
  const terminal = b.columns[b.columns.length - 1] ?? "done";
  const all = await query({ HashKey: b.slug } as unknown as QueryFilter);
  const terminalRows = all.filter((r) => columnOf(r) === terminal).length;
  console.log(
    `\n== board ${b.slug} — ${all.length} rows, ${terminalRows} in terminal column "${terminal}" ` +
      `(${all.length ? Math.round((terminalRows / all.length) * 100) : 0}% discarded today)`,
  );
  // Row counts before timing: a range shape that returns nothing is "fast" for
  // the wrong reason, and that is exactly how a bad filter reads as a win.
  const belowN = (
    await query({
      HashRangeRange: { hash: b.slug, start: "", end: `${terminal}#` },
    } as unknown as QueryFilter)
  ).length;
  const aboveN = (
    await query({
      HashRangeRange: { hash: b.slug, start: `${terminal}${AFTER_HASH}`, end: UPPER },
    } as unknown as QueryFilter)
  ).length;
  console.log(`   range rows: below=${belowN} above=${aboveN} total=${belowN + aboveN} (want ${all.length - terminalRows})`);

  const aMs: number[] = [];
  const bMs: number[] = [];
  let mismatch = 0;
  for (let i = 0; i < reps; i += 1) {
    // Alternate which shape goes first so warmth cannot favour either.
    const aFirst = i % 2 === 0;
    let aRes: string[] = [];
    let bRes: string[] = [];
    if (aFirst) {
      let t = performance.now();
      aRes = await whole(b.slug, terminal);
      aMs.push(performance.now() - t);
      t = performance.now();
      bRes = await ranges(b.slug, terminal);
      bMs.push(performance.now() - t);
    } else {
      let t = performance.now();
      bRes = await ranges(b.slug, terminal);
      bMs.push(performance.now() - t);
      t = performance.now();
      aRes = await whole(b.slug, terminal);
      aMs.push(performance.now() - t);
    }
    if (JSON.stringify(aRes) !== JSON.stringify(bRes)) {
      mismatch += 1;
      if (mismatch === 1) {
        const onlyA = aRes.filter((s) => !bRes.includes(s));
        const onlyB = bRes.filter((s) => !aRes.includes(s));
        console.log(`  VERDICT MISMATCH: onlyWhole=${onlyA.join(",")} onlyRanges=${onlyB.join(",")}`);
      }
    }
  }

  const med = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]!;
  const wins = aMs.filter((a, i) => bMs[i]! < a).length;
  console.log(`  whole partition + client filter : median ${Math.round(med(aMs))}ms  [${aMs.map(Math.round).join(", ")}]`);
  console.log(`  two HashRangeRange (concurrent) : median ${Math.round(med(bMs))}ms  [${bMs.map(Math.round).join(", ")}]`);
  console.log(`  ranges won ${wins}/${reps} reps · verdict equality: ${mismatch === 0 ? "GREEN" : `RED (${mismatch}/${reps})`}`);
}
