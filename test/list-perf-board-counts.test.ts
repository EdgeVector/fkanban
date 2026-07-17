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
import { searchCmd } from "../src/commands/search.ts";
import { FkanbanError, type NodeClient, type QueryFilter, type QueryResponse } from "../src/client.ts";
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
    columns: ["backlog", "todo", "doing", "done"],
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
  rejectColumnFilter?: boolean;
  nativeSearchSlugs?: string[];
}): NodeClient & { cardScanFields: string[][]; cardQueries: Array<{ fields: string[]; filter?: QueryFilter }> } {
  const boardRows = opts.boards.map((b) => ({ fields: boardToFields(b), key: { hash: b.slug, range: null } }));
  const cardRows = opts.cards.map((c) => ({ fields: cardToFields(c), key: { hash: c.slug, range: null } }));
  const cardScanFields: string[][] = [];
  const cardQueries: Array<{ fields: string[]; filter?: QueryFilter }> = [];
  const stub = () => {
    throw new Error("not implemented in fake node");
  };
  const node: NodeClient & { cardScanFields: string[][]; cardQueries: Array<{ fields: string[]; filter?: QueryFilter }> } = {
    baseUrl: "http://fake",
    userHash: "test-user",
    cardScanFields,
    cardQueries,
    autoIdentity: stub as never,
    bootstrap: stub as never,
    loadSchemas: stub as never,
    listSchemas: stub as never,
    createRecord: stub as never,
    updateRecord: stub as never,
    deleteRecord: stub as never,
    async rawCall(method, path) {
      if (method === "GET" && path.startsWith("/api/native-index/search")) {
        return {
          status: 200,
          headers: new Headers(),
          body: "",
          json: {
            ok: true,
            results: (opts.nativeSearchSlugs ?? []).map((slug) => ({
              schema_name: "cardhash",
              schema_display_name: "Card",
              field: "body",
              key_value: { hash: slug, range: null },
              value: "native candidate",
              metadata: { score: 0.9 },
            })),
          },
        };
      }
      return stub() as never;
    },
    nodeTransport: stub as never,
    async queryAll(q: { schemaHash: string; fields: string[]; filter?: QueryFilter }): Promise<QueryResponse> {
      if (q.schemaHash === "cardhash") {
        cardQueries.push({ fields: q.fields, filter: q.filter });
        // Only the unfiltered full-board scan is the list/count payload; the
        // point-read (HashKey) findCard is not relevant here.
        if (!q.filter) {
          cardScanFields.push(q.fields);
          if (opts.cardScanError) throw new Error("node shed the full scan (load)");
        }
        if (opts.rejectColumnFilter && q.filter?.column) {
          throw new FkanbanError({
            code: "node_http_400",
            message: "Node /api/query returned HTTP 400: unsupported filter.",
          });
        }
        let rows = cardRows;
        if (q.filter?.HashKey) {
          rows = rows.filter((r) => r.key.hash === q.filter!.HashKey);
        } else if (q.filter) {
          rows = rows.filter((r) =>
            Object.entries(q.filter!).every(([field, value]) => r.fields[field] === value)
          );
        }
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
    expect(bySlug.get("default")!.columns).toEqual(["backlog", "todo", "doing", "done"]);
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

describe("search — default text path uses indexed/native candidates", () => {
  test("does not fetch every full card body for a native-index body hit", async () => {
    const node = fakeNode({
      boards: [board({ slug: "default", title: "Default board" })],
      cards: [
        card({
          slug: "body-hit",
          title: "Body hit",
          body: "needle only appears in this full card body",
        }),
        card({
          slug: "other",
          title: "Other",
          body: "a large unrelated body that should not be fetched by the default search scan",
        }),
      ],
      nativeSearchSlugs: ["body-hit"],
    });

    const out = await searchCmd({ cfg, node, query: "needle" });
    expect(out).toContain("body-hit");
    expect(node.cardQueries.some((q) => q.filter?.HashKey === "body-hit" && q.fields.includes("body"))).toBe(true);
    const fullScans = node.cardQueries.filter((q) => q.filter === undefined && q.fields.includes("body"));
    expect(fullScans).toHaveLength(0);
  });

  test("--json keeps exhaustive search while returning capped body previews by default", async () => {
    const node = fakeNode({
      boards: [board({ slug: "default", title: "Default board" })],
      cards: Array.from({ length: 25 }, (_, i) =>
        card({
          slug: `body-hit-${i}`,
          title: `Body hit ${i}`,
          body: `needle ${"long body ".repeat(50)}`,
          position: String(i + 1),
        }),
      ),
    });

    const out = await searchCmd({ cfg, node, query: "needle", json: true });
    const parsed = JSON.parse(out) as Array<Card & { bodyTruncated: boolean }>;
    expect(parsed).toHaveLength(20);
    expect(parsed[0]!.body.length).toBeLessThanOrEqual(200);
    expect(parsed[0]!.bodyTruncated).toBe(true);
    const fullScans = node.cardQueries.filter((q) => q.filter === undefined && q.fields.includes("body"));
    expect(fullScans).toHaveLength(1);
  });

  test("search --all removes the broad JSON row cap but keeps body previews", async () => {
    const node = fakeNode({
      boards: [board({ slug: "default", title: "Default board" })],
      cards: Array.from({ length: 25 }, (_, i) =>
        card({
          slug: `body-hit-${i}`,
          title: `Body hit ${i}`,
          body: `needle ${"long body ".repeat(50)}`,
          position: String(i + 1),
        }),
      ),
    });

    const out = await searchCmd({ cfg, node, query: "needle", json: true, all: true });
    const parsed = JSON.parse(out) as Array<Card & { bodyTruncated: boolean }>;
    expect(parsed).toHaveLength(25);
    expect(parsed[0]!.bodyTruncated).toBe(true);
  });

  test("search --full-body restores the complete-body JSON surface", async () => {
    const node = fakeNode({
      boards: [board({ slug: "default", title: "Default board" })],
      cards: [card({ slug: "body-hit", title: "Body hit", body: `needle ${"long body ".repeat(50)}` })],
    });

    const out = await searchCmd({ cfg, node, query: "needle", json: true, fullBody: true });
    const parsed = JSON.parse(out) as Array<Card & { bodyTruncated: boolean }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.body).toContain("long body ".repeat(20));
    expect(parsed[0]!.bodyTruncated).toBe(false);
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

  test("--json queries full fields but returns broad body previews by default", async () => {
    const longBody = "multi-paragraph spec body ".repeat(30);
    const node = fakeNode({
      boards: [board({ slug: "default", title: "Default board" })],
      cards: [card({ slug: "a", board: "default", title: "Card A", body: longBody })],
    });
    const out = await listCmd({ cfg, node, json: true });
    const parsed = JSON.parse(out) as Array<Card & { bodyTruncated: boolean }>;
    expect(parsed[0]!.body.length).toBeLessThanOrEqual(200);
    expect(parsed[0]!.bodyTruncated).toBe(true);
    // The full-board card scan for --json fetched `body`.
    const scan = node.cardScanFields.at(-1)!;
    expect(scan).toContain("body");
  });

  test("--full-body restores complete bodies for broad JSON list output", async () => {
    const longBody = "multi-paragraph spec body ".repeat(30);
    const node = fakeNode({
      boards: [board({ slug: "default", title: "Default board" })],
      cards: [card({ slug: "a", board: "default", title: "Card A", body: longBody })],
    });
    const out = await listCmd({ cfg, node, json: true, fullBody: true });
    const parsed = JSON.parse(out) as Array<Card & { bodyTruncated: boolean }>;
    expect(parsed[0]!.body).toBe(longBody);
    expect(parsed[0]!.bodyTruncated).toBe(false);
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

  // The live node's /api/query filter is a HashRangeFilter — field-equality
  // filters like {column: "todo"} are not a node capability and 400 on every
  // call (2026-07-17 request-ops investigation: one guaranteed error plus an
  // N+1 fallback per column list). The contract is now: NEVER send a field
  // filter; filter client-side over a body-free scan; keep bodies point-read
  // per MATCHING card only.
  test("--column never sends a field filter to the node", async () => {
    const node = fakeNode({
      boards: [board({ slug: "default", title: "Default board" })],
      cards: [
        card({ slug: "todo-a", column: "todo" }),
        card({ slug: "doing-b", column: "doing" }),
      ],
    });
    const out = await listCmd({ cfg, node, column: "todo", json: true });
    expect((JSON.parse(out) as Card[]).map((c) => c.slug)).toEqual(["todo-a"]);

    expect(node.cardQueries.some((q) => q.filter?.column !== undefined)).toBe(false);
    expect(node.cardQueries.some((q) => q.filter === undefined)).toBe(true);
  });

  test("--column point-reads dependency statuses for blocked metadata", async () => {
    const node = fakeNode({
      boards: [board({ slug: "default", title: "Default board" })],
      cards: [
        card({ slug: "todo-a", column: "todo", deps: ["dep-a"] }),
        card({ slug: "dep-a", column: "doing" }),
        card({ slug: "unrelated", column: "review" }),
      ],
    });
    const out = await listCmd({ cfg, node, column: "todo", json: true });
    const parsed = JSON.parse(out) as Array<Card & { blocked: boolean; blockedBy: string[] }>;
    expect(parsed.map((c) => c.slug)).toEqual(["todo-a"]);
    expect(parsed[0]!.blocked).toBe(true);
    expect(parsed[0]!.blockedBy).toEqual(["dep-a"]);

    expect(node.cardQueries.some((q) => q.filter?.column !== undefined)).toBe(false);
    expect(node.cardQueries.some((q) => q.filter?.HashKey === "dep-a")).toBe(true);
  });

  test("--column still avoids a full-body board scan (bodies point-read per matching card)", async () => {
    const node = fakeNode({
      boards: [board({ slug: "default", title: "Default board" })],
      cards: [
        card({ slug: "todo-a", column: "todo" }),
        card({ slug: "doing-b", column: "doing" }),
      ],
      rejectColumnFilter: true,
    });
    const out = await listCmd({ cfg, node, column: "todo", json: true });
    expect((JSON.parse(out) as Card[]).map((c) => c.slug)).toEqual(["todo-a"]);

    expect(node.cardQueries.some((q) => q.filter?.column !== undefined)).toBe(false);
    expect(node.cardQueries.some((q) => q.filter === undefined)).toBe(true);
    expect(node.cardQueries.some((q) => q.filter === undefined && q.fields.includes("body"))).toBe(false);
    expect(node.cardQueries.some((q) => q.filter?.HashKey === "todo-a" && q.fields.includes("body"))).toBe(true);
    expect(node.cardQueries.some((q) => q.filter?.HashKey === "doing-b")).toBe(false);
  });
});
