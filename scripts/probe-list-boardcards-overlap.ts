#!/usr/bin/env bun
/**
 * READ-ONLY probe: does `list`'s BoardCards read have to WAIT for the board
 * resolution it is issued after?
 *
 * `listResult` already overlaps its two board-resolution reads with each other
 * (`findBoard` + `listBoards`, PR-measured at 153ms serial vs 119ms overlapped).
 * But the BoardCards read that follows is still a SECOND stage: it is awaited
 * after that pair settles, so a list pays two serial round trips.
 *
 * The inputs say it does not have to. `listCardsByColumn(node, cfg, column,
 * fields, boardSlug)` and `listCardsOnBoard(node, cfg, boardSlug, fields)` take
 * only `boardSlug`, the column name and a static projection — every one of them
 * known before any read is issued. Nothing the board resolution returns feeds
 * the BoardCards query; it is consumed only AFTER, by `ensureColumn` (column
 * validation) and `boardTerminalMap` (the dep-seed choice).
 *
 * `probe-command-reads.ts` measured the stage boundary this asks about:
 *
 *     kanban list --column todo — 3 queries, 459ms wall
 *       card_list_index HashKey(all_boards)      207ms  ┐ overlapped
 *       board           HashKey(default)         208ms  ┘ pair
 *       board_cards     HashRangePrefix(todo#)   240ms  ← second stage
 *
 * 208 + 240 ≈ 459. If the third read overlaps the pair, a list costs one round
 * trip instead of two — and this run has already established (runs d/e/f) that
 * round trips, not rows or bytes, are what a kanban read costs on this node.
 *
 * That is the claim. It is also exactly the shape that has been WRONG here
 * before: `probe-boardcards-write-lock-contention.ts` measured fan-out at 0.91x
 * of serial on the WRITE side, because a write takes a per-partition lock.
 * Reads take none — but "should overlap" is a prediction, and this run already
 * had one prediction refuted by a control, so measure it.
 *
 * Interleaved reps: serial and overlapped alternate, so node warmth and the
 * fleet's concurrent traffic cannot systematically favour either arm.
 *
 * Run: bun scripts/probe-list-boardcards-overlap.ts [reps] [column]
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import {
  findBoard,
  listBoards,
  listCardsByColumn,
  listCardsOnBoard,
  CARD_DISPLAY_FIELDS,
} from "../src/record.ts";

const reps = Number(process.argv[2] ?? 7);
const column = process.argv[3] ?? "todo";
const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const BOARD = "default";
const fields = [...CARD_DISPLAY_FIELDS];

const ms = async (fn: () => Promise<unknown>): Promise<number> => {
  const t0 = performance.now();
  await fn();
  return Math.round(performance.now() - t0);
};

// The two board-resolution reads, exactly as listResult issues them today.
const boardPair = () =>
  Promise.allSettled([findBoard(node, cfg, BOARD), listBoards(node, cfg)]);

const columnRead = () => listCardsByColumn(node, cfg, column, fields, BOARD);
const wholeRead = () => listCardsOnBoard(node, cfg, BOARD, fields);

type Case = { name: string; serial: () => Promise<unknown>; overlapped: () => Promise<unknown> };

const cases: Case[] = [
  {
    name: `list --column ${column}`,
    // Today: settle the board pair, THEN read BoardCards.
    serial: async () => {
      await boardPair();
      await columnRead();
    },
    // Proposed: the BoardCards read joins the same settle.
    overlapped: async () => {
      await Promise.allSettled([
        findBoard(node, cfg, BOARD),
        listBoards(node, cfg),
        columnRead(),
      ]);
    },
  },
  {
    name: "list (bare, whole partition)",
    serial: async () => {
      await boardPair();
      await wholeRead();
    },
    overlapped: async () => {
      await Promise.allSettled([
        findBoard(node, cfg, BOARD),
        listBoards(node, cfg),
        wholeRead(),
      ]);
    },
  },
];

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] ?? 0) : Math.round(((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2);
};

console.log(`board=${BOARD} column=${column} reps=${reps} (interleaved)\n`);

for (const c of cases) {
  const serial: number[] = [];
  const overlapped: number[] = [];
  for (let i = 0; i < reps; i++) {
    // Alternate which arm goes first, so a warming trend cannot favour one.
    if (i % 2 === 0) {
      serial.push(await ms(c.serial));
      overlapped.push(await ms(c.overlapped));
    } else {
      overlapped.push(await ms(c.overlapped));
      serial.push(await ms(c.serial));
    }
  }
  const sMed = median(serial);
  const oMed = median(overlapped);
  const wins = serial.filter((v, i) => (overlapped[i] ?? 0) < v).length;
  console.log(`== ${c.name}`);
  console.log(`   serial     ${String(sMed).padStart(5)}ms   [${serial.join(", ")}]`);
  console.log(`   overlapped ${String(oMed).padStart(5)}ms   [${overlapped.join(", ")}]`);
  console.log(
    `   ratio ${(oMed / sMed).toFixed(2)}x   overlapped won ${wins}/${reps} reps\n`,
  );
}
