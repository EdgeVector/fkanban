// Two same-subsystem changes, exercised against an in-memory fake node:
//
//  1. `board list` per-board live-card counts (board.ts): text shows
//     `(N cards)` / `(empty)`, `--json` carries an additive `cardCount`, and a
//     failed count scan degrades gracefully (board list still renders, no count).
//  2. `list` text-path body-free fetch (list.ts + record.ts): the TEXT render
//     fetches CARD_DISPLAY_FIELDS (no `body`) while `--json`/`--wide` keep full
//     fields.
//
// No live brain node — the fake node honours the HashKey point-read filter and
// records the `fields` each query asks for, so we can assert what went over the
// wire. (Reached over the LastDB unix socket in production; the retired :9001
// TCP port is not a health signal.)
//
// Column reads are HashRangePrefix-only against BoardCards. There is deliberately
// no HashKey + client-filter secondary: a prefix path that silently degrades to a
// partition scan hides its own breakage, which is how the OPE range-key bug stayed
// invisible. A prefix-blind node must therefore render an EMPTY column, and the
// fixtures here assert exactly that rather than papering over it.

import { describe, expect, test } from "bun:test";
import { cardsFromJson } from "./json_page.ts";

import { boardListCmd, boardListResult } from "../src/commands/board.ts";
import { DEP_SEED_POINT_READ_MAX, listCmd } from "../src/commands/list.ts";
import { searchCmd, searchResult } from "../src/commands/search.ts";
import { FkanbanError, type NodeClient, type QueryFilter, type QueryResponse } from "../src/client.ts";
import { boardToFields, cardToFields, emptyStructuredFields, type Board, type Card } from "../src/record.ts";
import { BOARD_LIST_INDEX_KEY, CARD_LIST_INDEX_KEY } from "../src/card-list-index.ts";
import { boardCardFieldsFromCard } from "../src/board-cards.ts";
import type { Config } from "../src/config.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash" },
};

const cfgWithIndexes: Config = {
  ...cfg,
  schemaHashes: { ...cfg.schemaHashes, card_list_index: "indexhash", board_cards: "boardcardshash" },
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
    body: "Repo: EdgeVector/fkanban\nBase: main\n\n## GOAL\nfixture\n\n## END STATE\ndone\n",
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
type CardQueryLog = { fields: string[]; filter?: QueryFilter };
type ListKeysLog = { schemaHash: string };

function fakeNode(opts: {
  boards: Board[];
  cards: Card[];
  cardScanError?: boolean;
  rejectUnallowedCardScan?: boolean;
  rejectColumnFilter?: boolean;
  nativeSearchSlugs?: string[];
  // Extra rows the Card key-list / point-get path returns beyond the modelled
  // cards — the live primary historically returned more than one scan row for
  // some slugs. Kept for ghost-row coverage via seeded extras.
  extraCardScanRows?: Array<Record<string, unknown>>;
}): NodeClient & { cardScanFields: string[][]; cardQueries: CardQueryLog[]; listKeysCalls: ListKeysLog[] } {
  const boardRows = opts.boards.map((b) => ({ fields: boardToFields(b), key: { hash: b.slug, range: null } }));
  const cardRows = [
    ...opts.cards.map((c) => ({ fields: cardToFields(c) as Record<string, unknown>, key: { hash: c.slug, range: null } })),
    ...(opts.extraCardScanRows ?? []).map((fields) => ({
      fields,
      key: { hash: String(fields.slug ?? ""), range: null },
    })),
  ];
  const boardCardRows = opts.cards.map((c) => ({
    fields: boardCardFieldsFromCard(c),
    key: { hash: c.board, range: null },
  }));
  const cardScanFields: string[][] = [];
  const cardQueries: CardQueryLog[] = [];
  const listKeysCalls: ListKeysLog[] = [];
  const stub = () => {
    throw new Error("not implemented in fake node");
  };
  const node: NodeClient & { cardScanFields: string[][]; cardQueries: CardQueryLog[]; listKeysCalls: ListKeysLog[] } = {
    baseUrl: "http://fake",
    userHash: "test-user",
    cardScanFields,
    cardQueries,
    listKeysCalls,
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
    async listRecordKeys(schemaHash, _opts = {}) {
      listKeysCalls.push({ schemaHash });
      if (schemaHash === "cardhash" && opts.cardScanError) {
        throw new Error("node shed the card key list (load)");
      }
      const hashes = [
        ...opts.cards.map((c) => c.slug),
        ...((opts.extraCardScanRows ?? [])
          .map((fields) => String(fields.slug ?? ""))
          .filter((slug) => slug.length > 0)),
      ];
      // Boards / milestones not needed by these tests.
      if (schemaHash === "boardhash") {
        return {
          schema: schemaHash,
          keys: opts.boards.map((b) => ({ hash: b.slug, range: null })),
          has_more: false,
          next_cursor: null,
          truncated: false,
        };
      }
      return {
        schema: schemaHash,
        keys: [...new Set(hashes)].map((hash) => ({ hash, range: null })),
        has_more: false,
        next_cursor: null,
        truncated: false,
      };
    },
    async queryAll(q: { schemaHash: string; fields: string[]; filter?: QueryFilter }): Promise<QueryResponse> {
      if (q.schemaHash === "indexhash") {
        const key = q.filter?.HashKey;
        if (key === BOARD_LIST_INDEX_KEY) {
          return {
            ok: true,
            results: [{
              key: { hash: BOARD_LIST_INDEX_KEY, range: null },
              fields: { key: BOARD_LIST_INDEX_KEY, payload_json: JSON.stringify(opts.boards), updated_at: "2026-01-01T00:00:00.000Z" },
            }],
          };
        }
        if (key === CARD_LIST_INDEX_KEY) {
          return {
            ok: true,
            results: [{
              key: { hash: CARD_LIST_INDEX_KEY, range: null },
              fields: { key: CARD_LIST_INDEX_KEY, payload_json: JSON.stringify(opts.cards.map((c) => ({ ...c, body: "" }))), updated_at: "2026-01-01T00:00:00.000Z" },
            }],
          };
        }
        return { ok: true, results: [] };
      }
      if (q.schemaHash === "boardcardshash") {
        let rows = boardCardRows;
        const rangePrefix = (q.filter as unknown as { HashRangePrefix?: { hash?: string; prefix?: string } } | undefined)?.HashRangePrefix;
        if (rangePrefix?.hash && rangePrefix.prefix !== undefined) {
          rows = rows.filter((r) => r.fields.board === rangePrefix.hash && typeof r.fields.sk === "string" && r.fields.sk.startsWith(rangePrefix.prefix!));
        } else if (q.filter?.HashKey) {
          rows = rows.filter((r) => r.fields.board === q.filter!.HashKey);
        }
        return { ok: true, results: rows };
      }
      if (q.schemaHash === "cardhash") {
        cardQueries.push({ fields: q.fields, filter: q.filter });
        // Unfiltered Card queries are forbidden. Body/admin drains use
        // listRecordKeys + HashKey point-gets.
        if (!q.filter) {
          cardScanFields.push(q.fields);
          if (opts.rejectUnallowedCardScan) {
            throw new FkanbanError({
              code: "full_schema_scan_not_allowed",
              message: "full_schema_scan_not_allowed: unfiltered query is deprecated for product apps",
            });
          }
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
    const parsed = cardsFromJson(out) as Array<Board & { cardCount: number | null }>;
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
    const parsed = cardsFromJson(out) as Array<Board & { cardCount: number | null }>;
    expect(parsed[0]!.cardCount).toBeNull();
  });
});

// The default search path matches against REAL bodies via key list + HashKey
// point-gets (slug+body). Never an unfiltered Card query.
describe("search — default text path matches real bodies via key list", () => {
  test("default search uses key list + point-get, never an unfiltered Card query", async () => {
    const node = fakeNode({
      boards: [board({ slug: "default", title: "Default board" })],
      cards: [
        card({
          slug: "feature-ready",
          title: "Ready feature slice",
          tags: ["feature-ship"],
          body: "feature details should not be needed for tag search",
        }),
      ],
      rejectUnallowedCardScan: true,
    });

    const { cards } = await searchResult({ cfg: cfgWithIndexes, node, query: "feature-ship" });

    expect(cards.map((c) => c.slug)).toEqual(["feature-ready"]);
    expect(node.cardQueries.filter((q) => q.filter === undefined)).toEqual([]);
    expect(node.listKeysCalls.some((c) => c.schemaHash === "cardhash")).toBe(true);
    expect(node.cardQueries.every((q) => typeof q.filter?.HashKey === "string")).toBe(true);
  });

  test("a body-only match is found — the recall the candidate path silently lost", async () => {
    const node = fakeNode({
      boards: [board({ slug: "default", title: "Default board" })],
      cards: [
        card({ slug: "body-only", title: "Unrelated title", body: "the needle is only in this body" }),
        card({ slug: "other", title: "Other", body: "nothing here" }),
      ],
      // No nativeSearchSlugs: the semantic index does NOT surface this card.
      // Pre-fix, that made it unfindable — body text could only match for cards
      // some other index happened to return.
      nativeSearchSlugs: [],
    });

    const { cards } = await searchResult({ cfg: cfgWithIndexes, node, query: "needle" });

    expect(cards.map((c) => c.slug)).toEqual(["body-only"]);
  });

  test("a match found on display fields still carries its real body", async () => {
    const node = fakeNode({
      boards: [board({ slug: "default", title: "Default board" })],
      cards: [card({ slug: "tagged", title: "Tagged", tags: ["feature-ship"], body: "the real body text" })],
      nativeSearchSlugs: [],
    });

    const { cards } = await searchResult({ cfg: cfgWithIndexes, node, query: "feature-ship" });

    // Pre-fix this matched on the body-free display read and was returned
    // as-is, so it reached the caller with body: "" — 127 of 153 live matches
    // did — while the `fkanban_search` MCP contract promises a full body.
    expect(cards.map((c) => c.slug)).toEqual(["tagged"]);
    expect(cards[0]!.body).toBe("the real body text");
  });

  test("one body scan replaces the per-candidate point reads, even when the index has hits", async () => {
    const node = fakeNode({
      boards: [board({ slug: "default", title: "Default board" })],
      cards: Array.from({ length: 10 }, (_, i) =>
        card({ slug: `hit-${i}`, title: `Hit ${i}`, body: "needle", position: String(i + 1) }),
      ),
      // The semantic index offers candidates; the scan has already answered, so
      // spending a wide point read per candidate is pure cost.
      nativeSearchSlugs: Array.from({ length: 10 }, (_, i) => `hit-${i}`),
    });

    const { cards } = await searchResult({ cfg: cfgWithIndexes, node, query: "needle" });

    expect(cards).toHaveLength(10);
    expect(node.cardQueries.filter((q) => q.filter === undefined)).toHaveLength(0);
    expect(node.listKeysCalls.some((c) => c.schemaHash === "cardhash")).toBe(true);
    expect(node.cardQueries.filter((q) => q.filter?.HashKey !== undefined && q.fields.includes("body")).length).toBeGreaterThan(0);
  });

  test("a duplicate empty Card row does not erase the body it matches on", async () => {
    // The live primary returns MORE THAN ONE Card row for some slugs — measured
    // 47 of 593, of which 33 carry the empty body LAST. Last-write-wins over the
    // scan therefore threw away the real brief and the card stopped matching.
    const node = fakeNode({
      boards: [board({ slug: "default", title: "Default board" })],
      cards: [card({ slug: "dupe", title: "Dupe", body: "the needle lives in this body" })],
      extraCardScanRows: [{ slug: "dupe", body: "" }],
    });

    const { cards } = await searchResult({ cfg: cfgWithIndexes, node, query: "needle" });

    expect(cards.map((c) => c.slug)).toEqual(["dupe"]);
    expect(cards[0]!.body).toBe("the needle lives in this body");
  });

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

    // Indexed config: the shape every real deployment runs (run (k) confirmed
    // BoardCards is the index the write path maintains). The no-index config is
    // the DEGRADED path and has its own test.
    const out = await searchCmd({ cfg: cfgWithIndexes, node, query: "needle" });
    expect(out).toContain("body-hit");
    // Bodies arrive via key list + HashKey point-gets, never an unfiltered scan.
    expect(node.cardQueries.filter((q) => q.filter === undefined)).toHaveLength(0);
    expect(node.listKeysCalls.some((c) => c.schemaHash === "cardhash")).toBe(true);
    expect(node.cardQueries.some((q) => q.filter?.HashKey === "body-hit" && q.fields.includes("body"))).toBe(true);
    const bodyPoint = node.cardQueries.find((q) => q.filter?.HashKey === "body-hit" && q.fields.includes("body"));
    expect(bodyPoint!.fields).toEqual(["slug", "body"]);
  });

  test("--json uses indexed/native candidates by default while returning capped body previews", async () => {
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
      nativeSearchSlugs: Array.from({ length: 25 }, (_, i) => `body-hit-${i}`),
    });

    const out = await searchCmd({ cfg: cfgWithIndexes, node, query: "needle", json: true });
    const parsed = cardsFromJson(out) as Array<Card & { bodyTruncated: boolean }>;
    expect(parsed).toHaveLength(20);
    expect(parsed[0]!.body.length).toBeLessThanOrEqual(200);
    expect(parsed[0]!.bodyTruncated).toBe(true);
    // Body previews are a RENDER cap; bodies come from key list + HashKey reads.
    expect(node.cardQueries.filter((q) => q.filter === undefined)).toHaveLength(0);
    expect(node.listKeysCalls.some((c) => c.schemaHash === "cardhash")).toBe(true);
  });

  test("--json stays on indexed card reads when the node rejects unallowed Card scans", async () => {
    const node = fakeNode({
      boards: [board({ slug: "default", title: "Default board" })],
      cards: [
        card({
          slug: "feature-ready",
          title: "Ready feature slice",
          tags: ["feature-ship"],
          body: "feature details should not be needed for tag search",
        }),
        card({
          slug: "ordinary-work",
          title: "Ordinary work",
          tags: ["cleanup"],
          body: "unrelated",
        }),
      ],
      rejectUnallowedCardScan: true,
    });

    const out = await searchCmd({ cfg: cfgWithIndexes, node, query: "feature-ship", json: true });
    const parsed = cardsFromJson(out) as Array<Card & { bodyTruncated: boolean }>;

    expect(parsed.map((c) => c.slug)).toEqual(["feature-ready"]);
    expect(node.cardQueries.filter((q) => q.filter === undefined)).toHaveLength(0);
  });

  test("complete search also uses key list + point-get, never an unfiltered Card query", async () => {
    const node = fakeNode({
      boards: [board({ slug: "default", title: "Default board" })],
      cards: [
        card({
          slug: "feature-ready",
          title: "Ready feature slice",
          tags: ["feature-ship"],
          body: "feature details should not be needed for tag search",
        }),
      ],
      rejectUnallowedCardScan: true,
    });

    const { cards } = await searchResult({ cfg, node, query: "feature-ship", complete: true });

    expect(cards.map((c) => c.slug)).toEqual(["feature-ready"]);
    expect(node.cardQueries.filter((q) => q.filter === undefined)).toHaveLength(0);
    expect(node.listKeysCalls.some((c) => c.schemaHash === "cardhash")).toBe(true);
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
      nativeSearchSlugs: Array.from({ length: 25 }, (_, i) => `body-hit-${i}`),
      rejectUnallowedCardScan: true,
    });

    const out = await searchCmd({ cfg: cfgWithIndexes, node, query: "needle", json: true, all: true });
    const parsed = cardsFromJson(out) as Array<Card & { bodyTruncated: boolean }>;
    expect(parsed).toHaveLength(25);
    expect(parsed[0]!.bodyTruncated).toBe(true);
    expect(node.cardQueries.filter((q) => q.filter === undefined)).toHaveLength(0);
    // `--all` lifts the ROW cap; bodies still come from key list + HashKey reads.
    expect(node.listKeysCalls.some((c) => c.schemaHash === "cardhash")).toBe(true);
    expect(node.cardQueries.every((q) => typeof q.filter?.HashKey === "string")).toBe(true);
  });

  test("search --full-body restores the complete-body JSON surface", async () => {
    const node = fakeNode({
      boards: [board({ slug: "default", title: "Default board" })],
      cards: [card({ slug: "body-hit", title: "Body hit", body: `needle ${"long body ".repeat(50)}` })],
    });

    const out = await searchCmd({ cfg, node, query: "needle", json: true, fullBody: true });
    const parsed = cardsFromJson(out) as Array<Card & { bodyTruncated: boolean }>;
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
    // No board_cards in cfg → key-list drain + HashKey point-gets (no body).
    expect(node.cardQueries.filter((q) => q.filter === undefined)).toHaveLength(0);
    const point = node.cardQueries.find((q) => q.filter?.HashKey === "a");
    expect(point).toBeDefined();
    expect(point!.fields).not.toContain("body");
    expect(point!.fields).toContain("title");
    expect(point!.fields).toContain("column");
  });

  test("--json list stays body-free over the wire (no board-wide body fetch)", async () => {
    const longBody = "multi-paragraph spec body ".repeat(30);
    const node = fakeNode({
      boards: [board({ slug: "default", title: "Default board" })],
      cards: [card({ slug: "a", board: "default", title: "Card A", body: longBody })],
    });
    const out = await listCmd({ cfg, node, json: true });
    const parsed = cardsFromJson(out) as Array<Card & { bodyTruncated: boolean }>;
    // Thin list path: empty/preview body without N+1 Card point-reads for body.
    expect(parsed[0]!.body.length).toBeLessThanOrEqual(200);
    expect(node.cardQueries.some((q) => q.filter?.HashKey === "a" && q.fields.includes("body"))).toBe(false);
  });

  test("--full-body returns complete bodies for the capped page", async () => {
    const longBody = "multi-paragraph spec body ".repeat(30);
    const node = fakeNode({
      boards: [board({ slug: "default", title: "Default board" })],
      cards: [card({ slug: "a", board: "default", title: "Card A", body: longBody })],
    });
    const out = await listCmd({ cfg, node, json: true, fullBody: true });
    const parsed = cardsFromJson(out) as Array<Card & { bodyTruncated: boolean }>;
    expect(parsed[0]!.body).toBe(longBody);
    expect(parsed[0]!.bodyTruncated).toBe(false);
  });

  test("--wide queries product list fields so repo/base/pr/updated are available", async () => {
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
    // Wide without board_cards uses key-list + HashKey; product list fields only.
    const point = node.cardQueries.find((q) => q.filter?.HashKey === "a");
    expect(point).toBeDefined();
    expect(point!.fields).not.toContain("body");
    expect(point!.fields).toContain("repo");
    expect(point!.fields).toContain("base");
    expect(point!.fields).toContain("pr_url");
    expect(point!.fields).toContain("updated_at");
  });

  // Column list primary path is BoardCards HashRangePrefix only — never a
  // field-equality filter on Card, and never a silent full-board Card scan
  // fallback when the prefix path is the contract under test.
  test("--column never sends a field filter to the node", async () => {
    const node = fakeNode({
      boards: [board({ slug: "default", title: "Default board" })],
      cards: [
        card({ slug: "todo-a", column: "todo" }),
        card({ slug: "doing-b", column: "doing" }),
      ],
    });
    const out = await listCmd({ cfg: cfgWithIndexes, node, column: "todo", json: true });
    expect((cardsFromJson(out) as Card[]).map((c) => c.slug)).toEqual(["todo-a"]);

    expect(node.cardQueries.some((q) => q.filter?.column !== undefined)).toBe(false);
    // No secondary full-board Card scan for column list.
    expect(node.cardQueries.some((q) => q.filter === undefined)).toBe(false);
  });

  test("--column keeps Card HashKey dep fan-out BOUNDED by k, never N+1", async () => {
    // This assertion used to read "zero Card point-reads". Zero was real, but it
    // was bought with an unbounded read of the terminal column — so the check
    // passed while the cost it existed to prevent had merely moved onto an axis
    // it wasn't watching. What made N+1 a storm was that it was unbounded, so
    // that is what gets pinned: at most one point-read per off-set dep slug, and
    // never more than DEP_SEED_POINT_READ_MAX of them.
    const node = fakeNode({
      boards: [board({ slug: "default", title: "Default board" })],
      cards: [
        card({ slug: "todo-a", column: "todo", deps: ["dep-a"] }),
        card({ slug: "dep-a", column: "doing" }),
        card({ slug: "unrelated", column: "review" }),
      ],
    });
    const out = await listCmd({ cfg: cfgWithIndexes, node, column: "todo", json: true });
    const parsed = cardsFromJson(out) as Array<Card & { blocked: boolean; blockedBy: string[] }>;
    expect(parsed.map((c) => c.slug)).toEqual(["todo-a"]);
    // The verdict is the invariant that must not move, and it does not: an
    // unfinished dep blocks whether it was resolved by scan or by point-read.
    expect(parsed[0]!.blocked).toBe(true);
    expect(parsed[0]!.blockedBy).toEqual(["dep-a"]);

    expect(node.cardQueries.some((q) => q.filter?.column !== undefined)).toBe(false);
    const pointReads = node.cardQueries.filter((q) => q.filter?.HashKey !== undefined);
    // k = 1 here (only `dep-a` points off the todo column), so: exactly one.
    expect(pointReads).toHaveLength(1);
    expect(pointReads[0]!.filter?.HashKey).toBe("dep-a");
  });

  test("--column does not report a LIVE unfinished dep as missing", async () => {
    // The correctness half, and the reason the old seed was not merely slower.
    //
    // `missingDeps` means "this dep has no card" — a dangling edge. Seeding only
    // from the terminal column made every dep that was alive but UNFINISHED
    // indistinguishable from one that did not exist, because the one place the
    // seed looked was the archive of finished work. So `list` reported live
    // cards as dangling while `show` — same board, authoritative path — reported
    // them correctly. Measured on the live default board 2026-08-02: `backlog`
    // named 2 such deps, both sitting in `default/todo`.
    //
    // `blocked` was right either way, which is why this survived: the loud field
    // agreed and the quiet one did not.
    const node = fakeNode({
      boards: [board({ slug: "default", title: "Default board" })],
      cards: [
        card({ slug: "todo-a", column: "todo", deps: ["dep-live", "dep-ghost"] }),
        card({ slug: "dep-live", column: "doing" }),
      ],
    });
    const out = await listCmd({ cfg: cfgWithIndexes, node, column: "todo", json: true });
    const parsed = cardsFromJson(out) as Array<
      Card & { blocked: boolean; blockedBy: string[]; missingDeps: string[] }
    >;
    expect(parsed[0]!.blocked).toBe(true);
    // Both block. Only the one with no card anywhere is MISSING.
    expect(parsed[0]!.blockedBy.sort()).toEqual(["dep-ghost", "dep-live"]);
    expect(parsed[0]!.missingDeps).toEqual(["dep-ghost"]);
  });

  test("--column falls back to the archive scan rather than fan out past the cap", async () => {
    // The other half of bounded. Past the threshold the flat read is the cheaper
    // one, so the fan-out must STOP — an uncapped point-read path would be the
    // original storm rebuilt, just with a nicer reason for existing.
    //
    // Verified green against the PRE-CHANGE code too, and that is expected: the
    // old path always scanned, so this branch is where new and old agree. It is
    // a regression guard on the fallback, not evidence that the cap works — the
    // three tests that go red without the change are what carry that.
    const deps = Array.from({ length: DEP_SEED_POINT_READ_MAX + 5 }, (_, i) => `dep-${i}`);
    const node = fakeNode({
      boards: [board({ slug: "default", title: "Default board" })],
      cards: [
        card({ slug: "todo-a", column: "todo", deps }),
        ...deps.map((slug, i) => card({ slug, column: "done", position: String(i + 1) })),
      ],
    });
    const out = await listCmd({ cfg: cfgWithIndexes, node, column: "todo", json: true });
    const parsed = cardsFromJson(out) as Array<Card & { blocked: boolean }>;
    // Every dep is finished, so the scan seed must clear the block — proving the
    // fallback resolved them rather than merely declining to point-read.
    expect(parsed[0]!.blocked).toBe(false);
    expect(node.cardQueries.some((q) => q.filter?.HashKey !== undefined)).toBe(false);
  });

  test("--column list stays thin (no per-card body hydrate without --full-body)", async () => {
    const node = fakeNode({
      boards: [board({ slug: "default", title: "Default board" })],
      cards: [
        card({ slug: "todo-a", column: "todo" }),
        card({ slug: "doing-b", column: "doing" }),
      ],
      rejectColumnFilter: true,
    });
    const out = await listCmd({ cfg: cfgWithIndexes, node, column: "todo", json: true });
    expect((cardsFromJson(out) as Card[]).map((c) => c.slug)).toEqual(["todo-a"]);

    expect(node.cardQueries.some((q) => q.filter?.column !== undefined)).toBe(false);
    expect(node.cardQueries.some((q) => q.filter === undefined)).toBe(false);
    // Default JSON list does not point-read bodies for matching cards.
    expect(node.cardQueries.some((q) => q.filter?.HashKey === "todo-a" && q.fields.includes("body"))).toBe(false);
    expect(node.cardQueries.some((q) => q.filter?.HashKey === "doing-b")).toBe(false);
  });
});
