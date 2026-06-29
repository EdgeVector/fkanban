// Two same-subsystem changes, exercised against an in-memory fake node:
//
//  1. `board list` per-board live-card counts (board.ts): text shows
//     `(N cards)` / `(empty)`, `--json` carries an additive `cardCount`, and a
//     failed count scan degrades gracefully (board list still renders, no count).
//  2. `list` text-path body-free fetch (list.ts + record.ts): the TEXT render
//     fetches CARD_DISPLAY_FIELDS (no `body`) while `--json`/`--wide` keep full
//     fields.
//
// No live :9001 brain — the fake node honours the HashKey point-read filter and
// records the `fields` each query asks for, so we can assert what went over the
// wire.

import { describe, expect, test } from "bun:test";

import { boardListCmd, boardListResult } from "../src/commands/board.ts";
import { listCmd } from "../src/commands/list.ts";
import { type NodeClient, type QueryFilter, type QueryResponse } from "../src/client.ts";
import { boardToFields, cardToFields, emptyStructuredFields, type Board, type Card } from "../src/record.ts";
import type { Config } from "../src/config.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash" },
};

function board(partial: Partial<Board>): Board {
  return {
    slug: "b",
    title: "B",
    body: "",
    columns: ["backlog", "todo", "doing", "review", "done"],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

function card(partial: Partial<Card>): Card {
  return {
    slug: "c",
    title: "C",
    body: "a multi-paragraph spec body that the text render never displays",
    board: "default",
    column: "todo",
    position: "1",
    assignee: "",
    tags: [],
    deps: [],
    ...emptyStructuredFields(),
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

// Records the `fields` of every CARD (cardhash) queryAll so a test can assert
// what the list path actually fetched. `cardScanError` makes the unfiltered
// (full-scan) card query throw, to exercise graceful degradation.
function fakeNode(opts: {
  boards: Board[];
  cards: Card[];
  cardScanError?: boolean;
}): NodeClient & { cardScanFields: string[][] } {
  const boardRows = opts.boards.map((b) => ({ fields: boardToFields(b), key: { hash: b.slug, range: null } }));
  const cardRows = opts.cards.map((c) => ({ fields: cardToFields(c), key: { hash: c.slug, range: null } }));
  const cardScanFields: string[][] = [];
  const stub = () => {
    throw new Error("not implemented in fake node");
  };
  const node: NodeClient & { cardScanFields: string[][] } = {
    baseUrl: "http://fake",
    userHash: "test-user",
    cardScanFields,
    autoIdentity: stub as never,
    bootstrap: stub as never,
    loadSchemas: stub as never,
    listSchemas: stub as never,
    createRecord: stub as never,
    updateRecord: stub as never,
    deleteRecord: stub as never,
    rawCall: stub as never,
    nodeTransport: stub as never,
    async queryAll(q: { schemaHash: string; fields: string[]; filter?: QueryFilter }): Promise<QueryResponse> {
      if (q.schemaHash === "cardhash") {
        // Only the unfiltered full-board scan is the list/count payload; the
        // point-read (HashKey) findCard is not relevant here.
        if (!q.filter) {
          cardScanFields.push(q.fields);
          if (opts.cardScanError) throw new Error("node shed the full scan (load)");
        }
        let rows = cardRows;
        if (q.filter) rows = rows.filter((r) => r.key.hash === q.filter!.HashKey);
        return { ok: true, results: rows };
      }
      let rows = q.schemaHash === "boardhash" ? boardRows : [];
      if (q.filter) rows = rows.filter((r) => r.key.hash === q.filter!.HashKey);
      return { ok: true, results: rows };
    },
  };
  return node;
}

describe("board list — per-board live-card counts", () => {
  test("text appends pluralized counts; empty board shows (empty)", async () => {
    const node = fakeNode({
      boards: [board({ slug: "default", title: "Default board" }), board({ slug: "scratch", title: "Scratch" })],
      cards: [
        card({ slug: "a", board: "default" }),
        card({ slug: "b", board: "default" }),
        card({ slug: "c", board: "default" }),
        card({ slug: "d", board: "scratch" }),
      ],
    });
    const out = await boardListCmd({ cfg, node });
    expect(out).toContain("default              Default board  (3 cards)");
    // scratch has exactly one live card → singular.
    expect(out).toContain("scratch              Scratch  (1 card)");
  });

  test("a board with no live cards shows (empty)", async () => {
    const node = fakeNode({
      boards: [board({ slug: "default", title: "Default board" }), board({ slug: "fresh", title: "Fresh" })],
      cards: [card({ slug: "a", board: "default" })],
    });
    const out = await boardListCmd({ cfg, node });
    expect(out).toContain("default              Default board  (1 card)");
    expect(out).toContain("fresh                Fresh  (empty)");
  });

  test("soft-deleted (tombstoned) cards are NOT counted", async () => {
    const node = fakeNode({
      boards: [board({ slug: "default", title: "Default board" })],
      cards: [
        card({ slug: "live", board: "default" }),
        card({ slug: "dead", board: "default", tags: ["__fkanban_deleted__"] }),
      ],
    });
    const { boards } = await boardListResult({ cfg, node });
    expect(boards[0]!.cardCount).toBe(1);
  });

  test("--json adds an additive numeric cardCount field per board", async () => {
    const node = fakeNode({
      boards: [board({ slug: "default", title: "Default board" }), board({ slug: "scratch", title: "Scratch" })],
      cards: [card({ slug: "a", board: "default" }), card({ slug: "b", board: "default" })],
    });
    const out = await boardListCmd({ cfg, node, json: true });
    const parsed = JSON.parse(out) as Array<Board & { cardCount: number | null }>;
    const bySlug = new Map(parsed.map((b) => [b.slug, b]));
    expect(bySlug.get("default")!.cardCount).toBe(2);
    expect(bySlug.get("scratch")!.cardCount).toBe(0);
    // Additive only — the existing Board shape is intact.
    expect(bySlug.get("default")!.columns).toEqual(["backlog", "todo", "doing", "review", "done"]);
  });

  test("count scan failure degrades gracefully: boards still render, no counts", async () => {
    const node = fakeNode({
      boards: [board({ slug: "default", title: "Default board" })],
      cards: [card({ slug: "a", board: "default" })],
      cardScanError: true,
    });
    const { text, boards } = await boardListResult({ cfg, node });
    // No throw; board still listed, just without a count suffix.
    expect(text).toContain("default              Default board\n");
    expect(text).not.toContain("card");
    expect(boards[0]!.cardCount).toBeNull();
    // --json: cardCount is null (not absent), so consumers see the fallback.
    const out = await boardListCmd({ cfg, node, json: true });
    const parsed = JSON.parse(out) as Array<Board & { cardCount: number | null }>;
    expect(parsed[0]!.cardCount).toBeNull();
  });
});

describe("list — text path fetches body-free fields, structured views keep full fields", () => {
  test("text render queries CARD_DISPLAY_FIELDS (no body)", async () => {
    const node = fakeNode({
      boards: [board({ slug: "default", title: "Default board" })],
      cards: [card({ slug: "a", board: "default", title: "Card A" })],
    });
    const out = await listCmd({ cfg, node });
    expect(out).toContain("Card A");
    // The full-board card scan for the text path omitted `body`.
    const scan = node.cardScanFields.at(-1)!;
    expect(scan).not.toContain("body");
    expect(scan).toContain("title");
    expect(scan).toContain("column");
  });

  test("--json queries full fields (including body) and returns bodies", async () => {
    const node = fakeNode({
      boards: [board({ slug: "default", title: "Default board" })],
      cards: [card({ slug: "a", board: "default", title: "Card A" })],
    });
    const out = await listCmd({ cfg, node, json: true });
    const parsed = JSON.parse(out) as Card[];
    expect(parsed[0]!.body).toContain("multi-paragraph spec body");
    // The full-board card scan for --json fetched `body`.
    const scan = node.cardScanFields.at(-1)!;
    expect(scan).toContain("body");
  });

  test("--wide queries full fields so repo/base/pr/updated are available", async () => {
    const node = fakeNode({
      boards: [board({ slug: "default", title: "Default board" })],
      cards: [
        card({
          slug: "a",
          board: "default",
          title: "Card A",
          repo: "EdgeVector/fkanban",
          base: "main",
          pr_url: "https://github.com/EdgeVector/fkanban/pull/1",
        }),
      ],
    });
    const out = await listCmd({ cfg, node, wide: true });
    expect(out).toContain("EdgeVector/fkanban");
    expect(out).toContain("https://github.com/EdgeVector/fkanban/pull/1");
    const scan = node.cardScanFields.at(-1)!;
    expect(scan).toContain("body");
    expect(scan).toContain("repo");
    expect(scan).toContain("base");
    expect(scan).toContain("pr_url");
    expect(scan).toContain("updated_at");
  });
});
