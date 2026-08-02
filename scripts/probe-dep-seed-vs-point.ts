#!/usr/bin/env bun
/**
 * READ-ONLY: is `list --column`'s dependency seed cheaper as the terminal-column
 * scan it does today, or as point-reads of only the dep slugs it actually needs?
 *
 * `list --column X` renders 🔒 by resolving each visible card's `deps` through
 * `depStatus`, which treats an UNRESOLVABLE dep as blocked. So the seed is
 * load-bearing: without it every card whose deps are all finished renders as
 * blocked-by-missing. The question is not whether to resolve, but how.
 *
 *   A (today)  one BoardCards `HashRangePrefix(board, "<terminal>#")` read at
 *              BOARD_CARDS_DEP_SEED_FIELDS. Cost scales with the SIZE OF THE
 *              TERMINAL COLUMN, which is an append-only archive — it only grows.
 *   B          `listDependencyStatusesForCards(…, knownCards=columnOnly)`,
 *              which point-reads only the dep slugs pointing off the visible
 *              set. Cost scales with the number of OFF-SET DEP EDGES.
 *
 * B is the shape `show`/`move` already use. It was rejected for the list path on
 * 2026-07-29 (c7d913e0) on a measurement recorded in concurrency.ts: "a rows=1
 * Card point-read averages ~2s on the primary under the 0.23.1 HashGroup
 * warm-cap read". That number, not the design, is what this probe re-tests — if
 * a point-read is no longer multi-second, A is paying an unbounded archive scan
 * to dodge a cost that no longer exists.
 *
 * Reps are INTERLEAVED: the live node serves the whole fleet, so A-then-A-then-B
 * mostly measures whatever else was running at the time.
 *
 * Run: bun scripts/probe-dep-seed-vs-point.ts [column] [reps]
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import {
  listBoards,
  listDependencyStatusesForCards,
  boardTerminalMap,
  CARD_LIST_FIELDS,
} from "../src/record.ts";
import { BOARD_CARDS_DEP_SEED_FIELDS, listBoardCardsPartition } from "../src/board-cards.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const COLUMN = process.argv[2] ?? "todo";
const REPS = Number(process.argv[3] ?? "5");
const BOARD = "default";

const boards = await listBoards(node, cfg);
const boardTerminal = boardTerminalMap(boards);
const terminalCol = boardTerminal.get(BOARD) ?? "done";

// The visible set, exactly as `list --column` fetches it.
const columnOnly =
  (await listBoardCardsPartition(node, cfg, BOARD, {
    column: COLUMN,
    fields: [...CARD_LIST_FIELDS],
  })) ?? [];

const visibleSlugs = new Set(columnOnly.map((c) => c.slug));
const depEdges = [...new Set(columnOnly.flatMap((c) => c.deps ?? []))];
const offSetDeps = depEdges.filter((s) => !visibleSlugs.has(s));

console.log(`board=${BOARD} column=${COLUMN} terminal=${terminalCol} reps=${REPS}`);
console.log(`  visible cards         ${columnOnly.length}`);
console.log(`  cards with deps       ${columnOnly.filter((c) => (c.deps?.length ?? 0) > 0).length}`);
console.log(`  distinct dep slugs    ${depEdges.length}`);
console.log(`  OFF-SET dep slugs (k) ${offSetDeps.length}   <- what B point-reads`);

// Size the archive A must scan, so the ratio is interpretable.
const terminalRows =
  (await listBoardCardsPartition(node, cfg, BOARD, {
    column: terminalCol,
    fields: [...BOARD_CARDS_DEP_SEED_FIELDS],
  })) ?? [];
console.log(`  terminal column rows  ${terminalRows.length}   <- what A scans, every time\n`);

const timesA: number[] = [];
const timesB: number[] = [];

for (let rep = 0; rep < REPS; rep++) {
  const a0 = performance.now();
  await listBoardCardsPartition(node, cfg, BOARD, {
    column: terminalCol,
    fields: [...BOARD_CARDS_DEP_SEED_FIELDS],
  });
  timesA.push(performance.now() - a0);

  const b0 = performance.now();
  await listDependencyStatusesForCards(node, cfg, columnOnly, columnOnly);
  timesB.push(performance.now() - b0);
}

const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const fmt = (xs: number[]) =>
  `median ${med(xs).toFixed(0).padStart(5)}ms  min ${Math.min(...xs).toFixed(0).padStart(5)}ms  max ${Math.max(...xs).toFixed(0).padStart(5)}ms`;

console.log(`A terminal-column scan (${terminalRows.length} rows)  ${fmt(timesA)}`);
console.log(`B point-read off-set deps (k=${offSetDeps.length})   ${fmt(timesB)}`);
const ratio = med(timesA) / Math.max(med(timesB), 0.001);
console.log(`\nB is ${ratio.toFixed(2)}x ${ratio >= 1 ? "CHEAPER" : "MORE EXPENSIVE"} than A at this board shape.`);
if (offSetDeps.length > 0) {
  console.log(`per-point-read: ~${(med(timesB) / offSetDeps.length).toFixed(0)}ms  (the ~2s claim in concurrency.ts is what this tests)`);
}
