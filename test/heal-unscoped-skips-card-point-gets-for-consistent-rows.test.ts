// Unscoped board-cards-heal must not query Card for every membership row.
//
// Scheduled `kanban-groom-board-cards-heal` measured 2026-09-16: 529 Card
// queries in 21.6 min (~1470/h) against a bar of under 50/h. LOAD/CALL=297.7
// — a HashKey point-get does not load ~298 shards. The `--slug` path already
// point-gets only the named card. Unscoped heal must:
//   - never Card-list / HashKeys
//   - HashKey-get Card only for BoardCards-visible drifted candidates
//
// papercut-kanban-groom-board-cards-heal-scheduled-card-query-rate-over-50-per-hour-20260916

import { describe, expect, test } from "bun:test";

import { fakeNode, type FakeNode } from "./fake-node.ts";
import type { Config } from "../src/config.ts";
import {
  boardCardsHealResult,
  membershipNeedsCardTruth,
} from "../src/commands/board_cards_heal.ts";
import { boardToFields, cardToFields, nowIso, type Card } from "../src/record.ts";
import { boardCardFieldsFromCard, boardCardSk } from "../src/board-cards.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: {
    card: "cardhash",
    board: "boardhash",
    board_cards: "boardcardshash",
    card_list_index: "cardlistindexhash",
  },
};

const BOARD = "default";

function card(over: Partial<Card> & { slug: string }): Card {
  const now = nowIso();
  const { slug, title, board, column, position, ...rest } = over;
  return {
    slug,
    title: title ?? slug,
    body: "",
    board: board ?? BOARD,
    column: column ?? "todo",
    position: position ?? "m",
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
    ...rest,
  } as Card;
}

function seedBoard(node: FakeNode): void {
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
}

function seedCard(node: FakeNode, c: Card): void {
  node.seed({ schemaHash: "cardhash", keyHash: c.slug, fields: cardToFields(c) });
}

function seedMembership(node: FakeNode, c: Card): void {
  node.seed({
    schemaHash: "boardcardshash",
    keyHash: c.board,
    rangeKey: boardCardSk(c.column, c.position, c.slug),
    fields: boardCardFieldsFromCard(c),
  });
}

function cardQueries(node: FakeNode) {
  return node.reads.filter((r) => r.schemaHash === "cardhash");
}

function cardListOrHashKeys(node: FakeNode) {
  return cardQueries(node).filter((r) => {
    const filter = r.filter as Record<string, unknown> | undefined;
    if (!filter) return true;
    if ("HashKeys" in filter) return true;
    if (typeof filter.HashKey !== "string" || filter.HashKey.length === 0) return true;
    return false;
  });
}

function cardPointGets(node: FakeNode): string[] {
  return cardQueries(node)
    .map((r) => (r.filter as Record<string, unknown> | undefined)?.HashKey)
    .filter((k): k is string => typeof k === "string" && k.length > 0);
}

describe("membershipNeedsCardTruth", () => {
  const healthy = card({ slug: "healthy", title: "healthy", column: "todo", position: "a" });
  const row = {
    column: healthy.column,
    position: String(healthy.position),
    slug: healthy.slug,
    full: healthy,
  };

  test("a single complete matching row does not need Card", () => {
    expect(membershipNeedsCardTruth([row], [boardCardSk(row.column, row.position, row.slug)], DEFAULT_COLUMNS)).toBe(false);
  });

  test("missing membership, duplicates, empty title, and invalid column need Card", () => {
    expect(membershipNeedsCardTruth([], undefined, DEFAULT_COLUMNS)).toBe(true);
    expect(membershipNeedsCardTruth([row, row], undefined, DEFAULT_COLUMNS)).toBe(true);
    expect(
      membershipNeedsCardTruth(
        [{ ...row, full: { ...healthy, title: "" } }],
        undefined,
        DEFAULT_COLUMNS,
      ),
    ).toBe(true);
    expect(
      membershipNeedsCardTruth(
        [{ ...row, column: "not-a-column" }],
        undefined,
        DEFAULT_COLUMNS,
      ),
    ).toBe(true);
  });
});

describe("unscoped heal does not Card-list and point-gets only drifted slugs", () => {
  test("consistent membership rows issue zero Card queries", async () => {
    const node = fakeNode();
    seedBoard(node);
    for (let i = 0; i < 8; i += 1) {
      const c = card({ slug: `live-${i}`, position: `p${i}` });
      seedCard(node, c);
      seedMembership(node, c);
    }
    node.reads.length = 0;

    const { report } = await boardCardsHealResult({ cfg, node, json: true });

    expect(report.drifted).toBe(0);
    expect(report.blocked).toBe(false);
    expect(cardListOrHashKeys(node)).toEqual([]);
    expect(cardPointGets(node)).toEqual([]);
  });

  test("a sparse drifted row point-gets only that slug, never a Card list", async () => {
    const node = fakeNode();
    seedBoard(node);
    const healthy = card({ slug: "healthy", position: "a" });
    const drifted = card({ slug: "drifted", title: "", column: "todo", position: "b" });
    const driftedTruth = card({ slug: "drifted", title: "Drifted", column: "doing", position: "b" });
    seedCard(node, healthy);
    seedCard(node, driftedTruth);
    seedMembership(node, healthy);
    seedMembership(node, drifted);
    node.reads.length = 0;

    const { report } = await boardCardsHealResult({ cfg, node, json: true, apply: true });

    expect(cardListOrHashKeys(node)).toEqual([]);
    expect([...new Set(cardPointGets(node))]).toEqual(["drifted"]);
    const action = report.actions.find((a) => a.slug === "drifted");
    expect(action?.action).toBe("delete-stale-and-upsert");
    expect(report.actions.some((a) => a.slug === "healthy" && a.action !== "noop-match")).toBe(false);
  });

  test("--slug still point-gets the named card even when the row looks consistent", async () => {
    const node = fakeNode();
    seedBoard(node);
    const named = card({ slug: "named", column: "doing", position: "n" });
    seedCard(node, named);
    seedMembership(node, { ...named, column: "todo" });
    node.reads.length = 0;

    const { report } = await boardCardsHealResult({
      cfg,
      node,
      slugs: ["named"],
      json: true,
      apply: true,
    });

    expect(cardListOrHashKeys(node)).toEqual([]);
    expect(cardPointGets(node)).toContain("named");
    expect(report.actions.find((a) => a.slug === "named")?.action).toBe("delete-stale-and-upsert");
  });
});
