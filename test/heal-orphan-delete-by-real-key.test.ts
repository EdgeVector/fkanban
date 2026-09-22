// papercut-fkanban-board-cards-heal-apply-reports-healed-but-orphan-row-survives-20260921
//
// 17 legacy ghost rows on the live `default` board carry `position: ""` in
// their payload while their physical range key holds a real position. The
// delete-orphan branch rebuilt the key from the payload copy
// (`backlog#000…#slug`), the node acked a delete of a key that never existed,
// heal reported `healed=17`, and every row survived for weeks.
//
// Pinned here:
// 1. delete-orphan deletes the row's REAL range key, so the ghost is gone.
// 2. When a delete does not land, heal does not count it as healed and says so.

import { describe, expect, test } from "bun:test";

import { fakeNode, type FakeNode } from "./fake-node.ts";
import type { Config } from "../src/config.ts";
import { boardCardsHealResult } from "../src/commands/board_cards_heal.ts";
import { boardToFields, nowIso, type Card } from "../src/record.ts";
import { boardCardFieldsFromCard, boardCardSk } from "../src/board-cards.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash", board_cards: "boardcardshash" },
};
const BOARD = "default";

function ghost(slug: string): Card {
  const now = nowIso();
  return {
    slug,
    title: "",
    body: "",
    board: BOARD,
    column: "backlog",
    position: "",
    assignee: "",
    tags: [],
    deps: [],
    surfaces: [],
    created_at: now,
    updated_at: now,
    done_at: "",
    first_doing_at: "",
    db: "",
    kind: "",
    priority: "",
    block_status: "",
    block_reason: "",
    north_star: "",
    milestone: "",
    repo: "",
    base: "",
    pr_url: "",
    branch: "",
    created_by: "unknown",
  } as Card;
}

function boardWithGhosts(slugs: string[]): FakeNode {
  const node = fakeNode();
  const now = nowIso();
  node.seed({
    schemaHash: "boardhash",
    keyHash: BOARD,
    fields: boardToFields({
      slug: BOARD,
      title: BOARD,
      body: "",
      columns: [...DEFAULT_COLUMNS],
      created_at: now,
      updated_at: now,
    }),
  });
  slugs.forEach((slug, i) => {
    const c = ghost(slug);
    node.seed({
      schemaHash: "boardcardshash",
      keyHash: BOARD,
      // The physical key holds a real position; the payload copy is empty.
      rangeKey: boardCardSk("backlog", String(1784000000000 + i), slug),
      fields: { ...boardCardFieldsFromCard(c), position: "" },
    });
  });
  return node;
}

describe("board-cards-heal delete-orphan uses the real range key", () => {
  test("a ghost row with an empty position copy is really deleted", async () => {
    const node = boardWithGhosts(["ghost-a", "ghost-b"]);
    const { report } = await boardCardsHealResult({ cfg, node, board: BOARD, json: true, apply: true });

    expect(report.missing_card).toBe(2);
    expect(report.healed).toBe(2);
    expect(report.unverified_deletes ?? 0).toBe(0);
    expect(node.rowsOf("boardcardshash")).toHaveLength(0);
  });

  test("a delete that does not land is not counted as healed", async () => {
    const node = boardWithGhosts(["ghost-a"]);
    // A node that acks every delete and drops it.
    (node as unknown as { deleteRecords?: unknown }).deleteRecords = async () => ({ ok: true });
    (node as unknown as { deleteRecord?: unknown }).deleteRecord = async () => ({ ok: true });
    const { report, text } = await boardCardsHealResult({
      cfg,
      node,
      board: BOARD,
      json: false,
      apply: true,
      visibilitySleep: async () => {},
    });

    expect(report.healed).toBe(0);
    expect(report.unverified_deletes).toBe(1);
    expect(text).toContain("UNVERIFIED DELETE");
    expect(node.rowsOf("boardcardshash")).toHaveLength(1);
  });
});
