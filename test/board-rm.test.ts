// `fkanban board rm` behaviour tests against an in-memory fake node — exercises
// the soft-delete write plus its two safety guards (default board, non-empty
// board) without a live :9001 brain. Mirrors the card-rm tombstone pattern.

import { describe, expect, test } from "bun:test";

import { boardRmCmd } from "../src/commands/board.ts";
import { formatBoardRm } from "../src/format.ts";
import { FkanbanError, type NodeClient, type QueryFilter, type QueryResponse } from "../src/client.ts";
import {
  boardToFields,
  cardToFields,
  emptyStructuredFields,
  isTombstoned,
  rowToBoard,
  type Board,
  type Card,
} from "../src/record.ts";
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
    body: "",
    board: "b",
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

type Update = { schemaHash: string; keyHash: string; fields: Record<string, unknown> };

// Minimal NodeClient that serves the given boards + cards from memory and
// records every updateRecord. queryAll honours the HashKey point-read filter so
// findBoard resolves a single board by slug, exactly like the real node.
function fakeNode(opts: { boards: Board[]; cards: Card[]; updates: Update[] }): NodeClient {
  const boardRows = opts.boards.map((b) => ({ fields: boardToFields(b), key: { hash: b.slug, range: null } }));
  const cardRows = opts.cards.map((c) => ({ fields: cardToFields(c), key: { hash: c.slug, range: null } }));
  const stub = () => {
    throw new Error("not implemented in fake node");
  };
  return {
    baseUrl: "http://fake",
    userHash: "test-user",
    autoIdentity: stub as never,
    bootstrap: stub as never,
    loadSchemas: stub as never,
    listSchemas: stub as never,
    createRecord: stub as never,
    deleteRecord: stub as never,
    rawCall: stub as never,
    nodeTransport: stub as never,
    async updateRecord(u) {
      opts.updates.push(u);
    },
    async queryAll(q: { schemaHash: string; fields: string[]; filter?: QueryFilter }): Promise<QueryResponse> {
      let rows = q.schemaHash === "boardhash" ? boardRows : q.schemaHash === "cardhash" ? cardRows : [];
      if (q.filter) rows = rows.filter((r) => r.key.hash === q.filter!.HashKey);
      return { ok: true, results: rows };
    },
  };
}

describe("board rm", () => {
  test("soft-deletes an empty non-default board by tombstoning columns", async () => {
    const updates: Update[] = [];
    const node = fakeNode({ boards: [board({ slug: "scratch" })], cards: [], updates });

    const res = await boardRmCmd({ cfg, node, slug: "scratch" });

    expect(res.slug).toBe("scratch");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.keyHash).toBe("scratch");
    expect(updates[0]!.schemaHash).toBe("boardhash");
    // The written-back board reads as tombstoned, so every board read path hides it.
    const written = rowToBoard({ fields: updates[0]!.fields, key: { hash: "scratch", range: null } });
    expect(isTombstoned(written.columns)).toBe(true);
  });

  test("rm of a nonexistent board throws board_not_found", async () => {
    const updates: Update[] = [];
    const node = fakeNode({ boards: [], cards: [], updates });
    const err = await boardRmCmd({ cfg, node, slug: "nope" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FkanbanError);
    expect((err as FkanbanError).code).toBe("board_not_found");
    expect(updates).toHaveLength(0);
  });

  test("refuses to remove the default board", async () => {
    const updates: Update[] = [];
    const node = fakeNode({ boards: [board({ slug: "default" })], cards: [], updates });
    const err = await boardRmCmd({ cfg, node, slug: "default", force: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FkanbanError);
    expect((err as FkanbanError).code).toBe("board_protected");
    expect(updates).toHaveLength(0);
  });

  test("refuses a board with live cards without --force", async () => {
    const updates: Update[] = [];
    const node = fakeNode({
      boards: [board({ slug: "busy" })],
      cards: [card({ slug: "c1", board: "busy" }), card({ slug: "c2", board: "busy" })],
      updates,
    });
    const err = await boardRmCmd({ cfg, node, slug: "busy" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FkanbanError);
    expect((err as FkanbanError).code).toBe("board_not_empty");
    expect((err as FkanbanError).message).toContain("2");
    expect(updates).toHaveLength(0);
  });

  test("removes a board with live cards when --force is set", async () => {
    const updates: Update[] = [];
    const node = fakeNode({
      boards: [board({ slug: "busy" })],
      cards: [card({ slug: "c1", board: "busy" })],
      updates,
    });
    const res = await boardRmCmd({ cfg, node, slug: "busy", force: true });
    expect(res.slug).toBe("busy");
    expect(updates).toHaveLength(1);
    const written = rowToBoard({ fields: updates[0]!.fields, key: { hash: "busy", range: null } });
    expect(isTombstoned(written.columns)).toBe(true);
  });

  test("a card on a different board doesn't block removal", async () => {
    const updates: Update[] = [];
    const node = fakeNode({
      boards: [board({ slug: "empty" })],
      cards: [card({ slug: "c1", board: "other" })],
      updates,
    });
    const res = await boardRmCmd({ cfg, node, slug: "empty" });
    expect(res.slug).toBe("empty");
    expect(updates).toHaveLength(1);
  });
});

describe("formatBoardRm", () => {
  test("human + json output", () => {
    expect(formatBoardRm({ slug: "scratch" })).toBe("removed board scratch");
    expect(formatBoardRm({ slug: "scratch" }, true)).toBe(JSON.stringify({ slug: "scratch" }));
  });
});
