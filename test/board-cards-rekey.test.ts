import { describe, expect, test } from "bun:test";

import type { NodeClient } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import {
  BOARD_CARDS_REKEY_TARGET,
  boardCardsWriteHashes,
  upsertBoardCard,
  upsertBoardCardsBatch,
} from "../src/board-cards.ts";
import { stageBoardCardsRekey } from "../src/commands/init.ts";
import {
  BOARD_CARDS_REKEY_PREVIOUS,
  boardCardsRekeyCutoverConfig,
  boardCardsRekeyTargetConfig,
} from "../src/commands/board_cards_rekey.ts";
import type { Card } from "../src/record.ts";

function cfg(hashes: Record<string, string>): Config {
  return {
    configVersion: 1,
    nodeUrl: "http://127.0.0.1",
    schemaServiceUrl: "",
    userHash: "user",
    schemaHashes: hashes,
  };
}

function card(slug = "rekey-card"): Card {
  return {
    slug,
    title: "Rekey card",
    body: "",
    board: "default",
    column: "todo",
    position: "10",
    assignee: "",
    tags: [],
    deps: [],
    surfaces: [],
    created_at: "2026-08-11T00:00:00Z",
    created_by: "test",
    updated_at: "2026-08-11T00:00:00Z",
    done_at: "",
    db: "",
    repo: "EdgeVector/fkanban",
    base: "main",
    kind: "pr",
    block_status: "",
    block_reason: "",
    north_star: "ns",
    milestone: "ms",
    pr_url: "",
    branch: "",
  };
}

describe("BoardCards two-phase rekey", () => {
  test("init stages a changed BoardCards identity instead of cutting reads over", () => {
    const staged = stageBoardCardsRekey(
      cfg({ board_cards: "old-board-cards", milestone_cards: "milestones" }),
      { board_cards: "new-board-cards", milestone_cards: "milestones" },
    );
    expect(staged).toMatchObject({
      staged: true,
      active: "old-board-cards",
      target: "new-board-cards",
    });
    expect(staged.schemaHashes.board_cards).toBe("old-board-cards");
    expect(staged.schemaHashes[BOARD_CARDS_REKEY_TARGET]).toBe("new-board-cards");
  });

  test("hot single and batch writes maintain active and staged identities", async () => {
    const writes: string[] = [];
    const batches: string[][] = [];
    const node = {
      updateRecord: async (req: { schemaHash: string }) => {
        writes.push(req.schemaHash);
      },
      updateRecords: async (reqs: Array<{ schemaHash: string }>) => {
        batches.push(reqs.map((r) => r.schemaHash));
      },
    } as unknown as NodeClient;
    const config = cfg({
      board_cards: "old-board-cards",
      [BOARD_CARDS_REKEY_TARGET]: "new-board-cards",
    });

    expect(boardCardsWriteHashes(config)).toEqual(["old-board-cards", "new-board-cards"]);
    await upsertBoardCard(node, config, card(), null, { skipOrphanPurge: true });
    await upsertBoardCardsBatch(node, config, [card("batch-card")]);

    expect(writes).toEqual(["old-board-cards", "new-board-cards"]);
    expect(batches).toEqual([["old-board-cards"], ["new-board-cards"]]);
  });

  test("target-only backfill view cannot recursively dual-write, and cutover keeps rollback address", () => {
    const config = cfg({
      board_cards: "old-board-cards",
      milestone_cards: "milestones",
      [BOARD_CARDS_REKEY_TARGET]: "new-board-cards",
    });
    const target = boardCardsRekeyTargetConfig(config)!;
    expect(target.schemaHashes.board_cards).toBe("new-board-cards");
    expect(target.schemaHashes[BOARD_CARDS_REKEY_TARGET]).toBeUndefined();
    expect(boardCardsWriteHashes(target)).toEqual(["new-board-cards"]);

    const cutover = boardCardsRekeyCutoverConfig(config);
    expect(cutover.schemaHashes.board_cards).toBe("new-board-cards");
    expect(cutover.schemaHashes[BOARD_CARDS_REKEY_PREVIOUS]).toBe("old-board-cards");
    expect(cutover.schemaHashes[BOARD_CARDS_REKEY_TARGET]).toBeUndefined();
    expect(cutover.schemaHashes.milestone_cards).toBe("milestones");
  });
});
