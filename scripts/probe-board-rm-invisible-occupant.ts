#!/usr/bin/env bun
/**
 * Probe: does `board rm` refuse a board whose only occupant is a membership row
 * no projected read can see — on the REAL node, not the fake?
 *
 * The guard's fix is built on two claims the in-memory fake cannot witness,
 * because the fake models a stricter drop rule than the node does (see
 * `test/fake-node.ts`): that a sparse BoardCards row is invisible to the board
 * list, and that leading a projection with each field in turn finds it anyway.
 * This runs both against the primary.
 *
 * WRITES, on a throwaway board only (`zz-chief-rm-probe-*`). It never touches
 * `default`, and it removes everything it created, including on the failure
 * paths. Run: bun scripts/probe-board-rm-invisible-occupant.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient, FkanbanError } from "../src/client.ts";
import { boardCreateCmd, boardRmCmd } from "../src/commands/board.ts";
import { boardCardSk, boardCardsHash, sweepBoardCardsPartition } from "../src/board-cards.ts";
import { listBoardCardsPartition } from "../src/board-cards.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const BOARD = `zz-chief-rm-probe-${Date.now()}`;
const SLUG = "zz-invisible-occupant";
const SK = boardCardSk("todo", "7777", SLUG);
const boardCards = boardCardsHash(cfg);
if (!boardCards) throw new Error("no board_cards schema hash in config");

async function cleanup(): Promise<void> {
  try {
    await node.deleteRecord({ schemaHash: boardCards!, keyHash: BOARD, rangeKey: SK });
  } catch { /* already gone */ }
  try {
    await boardRmCmd({ cfg, node, slug: BOARD, force: true });
  } catch { /* already gone */ }
}

try {
  await boardCreateCmd({ cfg, node, slug: BOARD, title: "chief-engineer rm probe" });

  // A partial write: `updateRecord` against a row that does not exist is a
  // silent upsert storing exactly the subset sent. This is how the live
  // partition acquired its sparse rows, reproduced deliberately.
  await node.updateRecord({
    schemaHash: boardCards,
    keyHash: BOARD,
    rangeKey: SK,
    fields: { title: "invisible occupant" },
  });

  const projected = await listBoardCardsPartition(node, cfg, BOARD);
  const sweep = await sweepBoardCardsPartition(node, cfg, BOARD);
  console.log(`projected wide read : ${projected?.length ?? "null"} rows`);
  console.log(`completeness sweep  : ${sweep?.rows.length ?? "null"} rows` +
    (sweep?.failedLeads.length ? ` (failed leads: ${sweep.failedLeads.map((f) => f.field).join(",")})` : ""));

  const err = await boardRmCmd({ cfg, node, slug: BOARD }).catch((e: unknown) => e);
  const code = err instanceof FkanbanError ? err.code : `NO REFUSAL (${JSON.stringify(err)})`;
  console.log(`board rm (no force) : ${code}`);

  await boardRmCmd({ cfg, node, slug: BOARD, force: true });
  const after = await sweepBoardCardsPartition(node, cfg, BOARD);
  console.log(`after --force       : ${after?.rows.length ?? "null"} membership rows left`);

  const green =
    (projected?.length ?? -1) === 0 &&
    (sweep?.rows.length ?? -1) === 1 &&
    code === "board_not_empty" &&
    (after?.rows.length ?? -1) === 0;
  console.log(green ? "GREEN" : "RED");
} finally {
  await cleanup();
}
