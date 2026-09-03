import { beforeEach, describe, expect, test } from "bun:test";

import { fakeNode, type FakeNode } from "./fake-node.ts";
import type { Config } from "../src/config.ts";
import { boardToFields, cardToFields, nowIso, type Card } from "../src/record.ts";
import { boardCardFieldsFromCard, boardCardSk } from "../src/board-cards.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";
import { searchResult } from "../src/commands/search.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash", board_cards: "boardcardshash" },
};

function card(over: Partial<Card> & { slug: string }): Card {
  const now = nowIso();
  return {
    slug: over.slug,
    title: over.title ?? over.slug,
    body: over.body ?? "## GOAL\nAn ordinary brief.",
    board: over.board ?? "default",
    column: over.column ?? "todo",
    position: over.position ?? "m",
    assignee: "",
    tags: [],
    deps: [],
    surfaces: [],
    created_at: now,
    updated_at: now,
    done_at: "",
    db: "",
    kind: "pr",
    priority: "",
    block_status: "none",
    block_reason: "",
    north_star: "",
    milestone: "",
    repo: "EdgeVector/fkanban",
    base: "main",
    pr_url: "",
    branch: "",
    created_by: "test",
  } as Card;
}

describe("default search does not HashKey every Card", () => {
  let node: FakeNode;

  beforeEach(() => {
    node = fakeNode();
    const now = nowIso();
    node.seed({
      schemaHash: "boardhash",
      keyHash: "default",
      fields: boardToFields({
        slug: "default",
        title: "default",
        body: "",
        columns: [...DEFAULT_COLUMNS],
        created_at: now,
        updated_at: now,
      }),
    });
    for (let i = 0; i < 8; i++) {
      const c = card({
        slug: `card-${i}`,
        title: i === 3 ? "unique-display-hit" : `other-${i}`,
        body: `secret-body-token-${i}`,
        position: String(i),
      });
      node.seed({ schemaHash: "cardhash", keyHash: c.slug, fields: cardToFields(c) });
      node.seed({
        schemaHash: "boardcardshash",
        keyHash: c.board,
        rangeKey: boardCardSk(c.column, c.position, c.slug),
        fields: boardCardFieldsFromCard(c),
      });
    }
  });

  test("a display-field hit issues zero Card HashKeys", async () => {
    const before = node.reads.length;
    const res = await searchResult({ cfg, node, query: "unique-display-hit" });
    expect(res.cards.map((c) => c.slug)).toEqual(["card-3"]);
    const cardHashKeys = node.reads
      .slice(before)
      .filter((r) => r.schemaHash === "cardhash" && r.filter?.HashKey);
    expect(cardHashKeys).toHaveLength(0);
  });

  test("a body-only token is not a default hit", async () => {
    const res = await searchResult({ cfg, node, query: "secret-body-token-3" });
    expect(res.cards.map((c) => c.slug)).not.toContain("card-3");
  });

  test("--complete still HashKeys Card for a body-only hit", async () => {
    const res = await searchResult({
      cfg,
      node,
      query: "secret-body-token-3",
      complete: true,
    });
    expect(res.cards.map((c) => c.slug)).toContain("card-3");
  });
});
