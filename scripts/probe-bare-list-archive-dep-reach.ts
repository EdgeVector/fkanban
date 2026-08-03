#!/usr/bin/env bun
/**
 * READ-ONLY probe: if bare `kanban list` stopped reading the whole terminal
 * column, how many dep edges would it no longer be able to resolve locally?
 *
 * Bare `list` renders at most DEFAULT_COLUMN_LIMIT cards per column but reads
 * every row in the partition, because `allCards` doubles as the dep-resolution
 * set: a dep pointing at a finished card is only known finished if that card's
 * row was read. Bounding the terminal read is therefore only safe if the edges
 * that reach PAST the bound are few enough to point-read — the same k the
 * `--column` path already weighs against DEP_SEED_POINT_READ_MAX.
 *
 * This measures k for the bare-list path on the live board. It writes nothing.
 *
 * Run: bun scripts/probe-bare-list-archive-dep-reach.ts [board] [limit]
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { listBoards, boardTerminalMap, sortCards, CARD_DISPLAY_FIELDS } from "../src/record.ts";
import { listBoardCardsPartition, boardCardsProjectionForCardFields } from "../src/board-cards.ts";
import { DEP_SEED_POINT_READ_MAX, DEFAULT_COLUMN_LIMIT } from "../src/commands/list.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const BOARD = process.argv[2] ?? "default";
const LIMIT = Number(process.argv[3] ?? String(DEFAULT_COLUMN_LIMIT));

const boards = await listBoards(node, cfg);
const terminal = boardTerminalMap(boards).get(BOARD) ?? "done";

const all = await listBoardCardsPartition(node, cfg, BOARD, {
  fields: boardCardsProjectionForCardFields(CARD_DISPLAY_FIELDS),
});
if (all === null) throw new Error("BoardCards not readable");

const active = all.filter((c) => c.column !== terminal);
const archive = sortCards(all.filter((c) => c.column === terminal));
const kept = new Set(archive.slice(0, LIMIT).map((c) => c.slug));
const dropped = archive.slice(LIMIT);
const droppedSlugs = new Set(dropped.map((c) => c.slug));

// Every distinct dep slug on a card that would still be READ under the bound.
const readSet = new Set([...active.map((c) => c.slug), ...kept]);
const depsOfRead = [
  ...new Set([...active, ...archive.slice(0, LIMIT)].flatMap((c) => c.deps ?? [])),
].filter((s) => s.length > 0);

const unresolvable = depsOfRead.filter((s) => !readSet.has(s));
const intoArchive = unresolvable.filter((s) => droppedSlugs.has(s));
const offBoard = unresolvable.filter((s) => !droppedSlugs.has(s));

console.log(`board=${BOARD} terminal=${terminal} limit=${LIMIT}`);
console.log(`  rows total            ${all.length}`);
console.log(`  active (rendered)     ${active.length}`);
console.log(`  archive kept          ${Math.min(LIMIT, archive.length)}`);
console.log(`  archive DROPPED       ${dropped.length}   <- rows a bounded read would not fetch`);
console.log("");
console.log(`  distinct dep slugs on the read set        ${depsOfRead.length}`);
console.log(`  ...already resolvable from the read set   ${depsOfRead.length - unresolvable.length}`);
console.log(`  ...k = need resolving after the bound     ${unresolvable.length}`);
console.log(`       of which point INTO the dropped archive  ${intoArchive.length}`);
console.log(`       of which point off-board / missing today ${offBoard.length}   (already point-read today)`);
console.log("");
console.log(
  `  DEP_SEED_POINT_READ_MAX = ${DEP_SEED_POINT_READ_MAX} -> bounded read would ` +
    (unresolvable.length <= DEP_SEED_POINT_READ_MAX
      ? `POINT-READ ${unresolvable.length} slug(s)`
      : `fall back to a full terminal-column seed read (k=${unresolvable.length} over threshold)`),
);
if (intoArchive.length > 0) {
  console.log(`  edges into the archive: ${intoArchive.slice(0, 20).join(", ")}`);
}
