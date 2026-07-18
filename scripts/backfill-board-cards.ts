#!/usr/bin/env bun
/**
 * Backfill BoardCards HashRange from CardListIndex (preferred) or point Card reads.
 *
 *   bun scripts/backfill-board-cards.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { listBoards, type Card } from "../src/record.ts";
import { readCardListIndex } from "../src/card-list-index.ts";
import {
  upsertBoardCard,
  boardCardsHash,
  listBoardCardsPartition,
} from "../src/board-cards.ts";

async function main() {
  const config = readConfig();
  const hash = boardCardsHash(config);
  if (!hash) {
    console.error(
      `No schemaHashes.board_cards in ${config.configPath ?? "config"}. Register first.`,
    );
    process.exit(1);
  }
  console.log("config", config.configPath ?? "(default)");
  console.log("board_cards", hash);

  const node = newNodeClient({
    baseUrl: config.nodeUrl,
    userHash: config.userHash,
    socketPath: config.nodeSocketPath,
  });

  const boards = await listBoards(node, config);
  console.log("boards", boards.map((b) => b.slug).join(", ") || "(none)");

  const indexed = await readCardListIndex(node, config);
  if (!indexed || indexed.length === 0) {
    console.error(
      "CardListIndex empty/missing — cannot backfill without a full Card scan. " +
        "Seed via normal card mutations, or restore all_cards index first.",
    );
    process.exit(1);
  }
  console.log("index cards", indexed.length);

  let ok = 0;
  let fail = 0;
  for (const summary of indexed) {
    const card = summary as Card;
    try {
      await upsertBoardCard(node, config, card);
      ok++;
      if (ok % 50 === 0) console.log(`  … ${ok}/${indexed.length}`);
    } catch (e) {
      fail++;
      console.error(`  fail ${card.slug}:`, (e as Error).message?.slice(0, 200));
    }
  }

  console.log("upserted", ok, "failed", fail);

  for (const b of boards) {
    const part = await listBoardCardsPartition(node, config, b.slug);
    console.log(`partition ${b.slug}: ${part?.length ?? "null"} rows`);
  }
  console.log("OK backfill complete");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
