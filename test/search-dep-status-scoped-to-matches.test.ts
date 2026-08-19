// Search resolved dependencies for the whole board and printed a verdict about
// the matches.
//
// `listDependencyStatusesForCards` point-reads every dep edge that points OFF
// its input set, so the scope of its first argument IS the read count.
// `indexedSearchCards` passed `scopedDisplay` — the entire board — while the
// only consumer of the result, `blockedSlugSet(matches, allCards, …)`, asks
// `depStatus` about the MATCHES alone. Deps of non-matching cards were fetched,
// mapped into a `Map`, and dropped unread.
//
// Measured live 2026-08-03 on a 191-card board with 26 board-wide off-set deps
// (`scripts/probe-search-dep-scope-cost.ts`, 7 interleaved reps): "lastdb"
// 932ms -> 195ms, "milestone" 969ms -> 197ms, a query matching NOTHING
// 976ms -> 0ms — with `blockedSlugSet` returning the identical blocked set
// every time. A search that found nothing spent a full second resolving
// dependencies for an empty answer.
//
// These tests pin the two halves that make that a cost change: the reads are
// scoped to what the output can observe, and the printed verdict is unchanged.

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
    body: over.body ?? "brief",
    board: "default",
    column: over.column ?? "todo",
    position: over.position ?? "1",
    assignee: "",
    tags: [],
    deps: over.deps ?? [],
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

function seedBoard(node: FakeNode): void {
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
}

/** On the board (Card + BoardCards) — so it is in the display read's row set. */
function seedCard(node: FakeNode, c: Card): void {
  node.seed({ schemaHash: "cardhash", keyHash: c.slug, fields: cardToFields(c) });
  node.seed({
    schemaHash: "boardcardshash",
    keyHash: c.board,
    rangeKey: boardCardSk(c.column, c.position, c.slug),
    fields: boardCardFieldsFromCard(c),
  });
}

/**
 * A Card record with NO BoardCards row: it is absent from the display read, so
 * a dep pointing at it is exactly the off-set edge that costs a point read.
 */
function seedOffBoardCard(node: FakeNode, c: Card): void {
  node.seed({ schemaHash: "cardhash", keyHash: c.slug, fields: cardToFields(c) });
}

/** Dep-status point reads against Card (not the slug+body key-list drain). */
function cardPointReads(node: FakeNode): Array<Record<string, unknown>> {
  return node.reads
    .filter((r) =>
      r.schemaHash === "cardhash" &&
      r.filter !== undefined &&
      r.fields.includes("deps"),
    )
    .map((r) => r.filter as unknown as Record<string, unknown>);
}

describe("search resolves deps for its matches, not for the whole board", () => {
  let node: FakeNode;

  beforeEach(() => {
    node = fakeNode();
    seedBoard(node);
    // The match. Its dep points off the board, so a verdict about it needs one
    // real read.
    seedCard(node, card({ slug: "needle-card", body: "needle", deps: ["needle-dep"] }));
    seedOffBoardCard(node, card({ slug: "needle-dep", column: "todo", position: "2" }));
    // Three non-matching cards, each with its own off-board dep. Nothing the
    // command prints can depend on these.
    for (const n of [1, 2, 3]) {
      seedCard(node, card({ slug: `other-${n}`, body: "unrelated", deps: [`other-dep-${n}`] }));
      seedOffBoardCard(node, card({ slug: `other-dep-${n}`, position: String(n + 10) }));
    }
  });

  // NON-VACUITY. If the fixture's off-board deps were resolvable from the board
  // read, both arms would issue zero point reads and the assertions below would
  // be about nothing.
  test("the fixture reproduces the input: non-matching cards carry off-board deps", async () => {
    const boardRead = await node.queryAll({
      schemaHash: "boardcardshash",
      fields: ["slug"],
      filter: { HashKey: "default" } as never,
    });
    const onBoard = new Set(
      boardRead.results.map((r) => String((r.fields as Record<string, unknown>).slug ?? "")),
    );
    expect(onBoard.has("needle-dep")).toBe(false);
    for (const n of [1, 2, 3]) expect(onBoard.has(`other-dep-${n}`)).toBe(false);
  });

  test("only the MATCH's dep is point-read — the other three are not", async () => {
    await searchResult({ node, cfg, query: "needle" } as never);
    const reads = JSON.stringify(cardPointReads(node));
    expect(reads).toContain("needle-dep");
    for (const n of [1, 2, 3]) expect(reads).not.toContain(`other-dep-${n}`);
  });

  test("a search that matches NOTHING point-reads no dependency at all", async () => {
    // The shape the old code made worst: zero results, full board dep fan-out.
    const { cards } = await searchResult({ node, cfg, query: "zzz-no-such-term" } as never);
    expect(cards).toHaveLength(0);
    for (const n of [1, 2, 3]) {
      expect(JSON.stringify(cardPointReads(node))).not.toContain(`other-dep-${n}`);
    }
  });

  test("the blocked verdict is unchanged — the dep is still resolved and still blocks", async () => {
    // Cost, not behaviour: the match's dep sits in `todo`, not the terminal
    // column, so the match must still render as blocked.
    const { text, cards } = await searchResult({ node, cfg, query: "needle" } as never);
    expect(cards.map((c) => c.slug)).toEqual(["needle-card"]);
    expect(text).toContain("🔒");
  });

  test("a dep already on the board resolves with no read at all", async () => {
    const local = fakeNode();
    seedBoard(local);
    seedCard(local, card({ slug: "a-card", body: "needle", deps: ["b-card"] }));
    seedCard(local, card({ slug: "b-card", column: "done", position: "2" }));
    await searchResult({ node: local, cfg, query: "needle" } as never);
    expect(JSON.stringify(cardPointReads(local))).not.toContain("b-card");
  });
});
