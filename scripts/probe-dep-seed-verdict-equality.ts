#!/usr/bin/env bun
/**
 * READ-ONLY: do the terminal-column dep seed and the point-read dep resolution
 * produce the SAME 🔒 verdict on the live board?
 *
 * Speed is not the question here — probe-dep-seed-vs-point.ts answers that.
 * This asks the question that has to be answered FIRST, because a cheaper read
 * that renders a different board is not cheaper, it is wrong.
 *
 * The two paths can legitimately disagree in one case worth finding rather than
 * arguing about: a dep with a BoardCards row in the terminal column but NO Card
 * record (a ghost row). The scan resolves it as finished; the point-read returns
 * null and `depStatus` counts an unresolvable dep as BLOCKED. If ghosts exist on
 * this board, that divergence is real and any swap has to account for it.
 *
 * Prints per-column: blocked-set A, blocked-set B, and the symmetric difference.
 *
 * Run: bun scripts/probe-dep-seed-verdict-equality.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import {
  listBoards,
  listDependencyStatusesForCards,
  boardTerminalMap,
  blockedSlugSet,
  CARD_LIST_FIELDS,
} from "../src/record.ts";
import { BOARD_CARDS_DEP_SEED_FIELDS, listBoardCardsPartition } from "../src/board-cards.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const BOARD = "default";
const boards = await listBoards(node, cfg);
const boardTerminal = boardTerminalMap(boards);
const terminalCol = boardTerminal.get(BOARD) ?? "done";
const COLUMNS = (boards.find((b) => b.slug === BOARD)?.columns ?? [
  "backlog",
  "todo",
  "doing",
  "done",
]).filter((c) => c !== terminalCol);

let divergences = 0;

for (const column of COLUMNS) {
  const columnOnly =
    (await listBoardCardsPartition(node, cfg, BOARD, {
      column,
      fields: [...CARD_LIST_FIELDS],
    })) ?? [];
  if (columnOnly.length === 0) {
    console.log(`${column.padEnd(10)} (empty)`);
    continue;
  }

  // A — today: merge the whole terminal column in as known cards.
  const terminalCards =
    (await listBoardCardsPartition(node, cfg, BOARD, {
      column: terminalCol,
      fields: [...BOARD_CARDS_DEP_SEED_FIELDS],
    })) ?? [];
  const mergedA = new Map(columnOnly.map((c) => [c.slug, c]));
  for (const c of terminalCards) mergedA.set(c.slug, c);
  const blockedA = blockedSlugSet(columnOnly, [...mergedA.values()], boardTerminal);

  // B — point-read only the dep slugs that point off the visible set.
  const resolvedB = await listDependencyStatusesForCards(node, cfg, columnOnly, columnOnly);
  const blockedB = blockedSlugSet(columnOnly, resolvedB, boardTerminal);

  const onlyA = [...blockedA].filter((s) => !blockedB.has(s));
  const onlyB = [...blockedB].filter((s) => !blockedA.has(s));
  divergences += onlyA.length + onlyB.length;

  const verdict = onlyA.length + onlyB.length === 0 ? "MATCH" : "DIVERGE";
  console.log(
    `${column.padEnd(10)} cards=${String(columnOnly.length).padStart(3)}  blockedA=${String(blockedA.size).padStart(3)}  blockedB=${String(blockedB.size).padStart(3)}  ${verdict}`,
  );
  if (onlyA.length) console.log(`             blocked only under A (scan): ${onlyA.join(", ")}`);
  if (onlyB.length) console.log(`             blocked only under B (point): ${onlyB.join(", ")}`);
}

console.log(
  divergences === 0
    ? "\nGREEN — identical verdicts on every non-terminal column."
    : `\nRED — ${divergences} slug(s) render differently. Do not swap without handling these.`,
);
