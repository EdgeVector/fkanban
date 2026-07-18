import { describe, expect, test } from "bun:test";

import {
  FkanbanError,
  type CasExpectation,
  type NodeClient,
  type QueryFilter,
  type QueryResponse,
  type QueryRow,
} from "../src/client.ts";
import type { Config } from "../src/config.ts";
import {
  boardCardFieldsFromCard,
  boardCardSk,
  cardFromBoardCardFields,
  listAllBoardCards,
  parseBoardCardSk,
  preferFresherBoardCard,
  purgeOtherBoardCardRows,
  upsertBoardCard,
} from "../src/board-cards.ts";
import { boardCardsHealResult } from "../src/commands/board_cards_heal.ts";
import { emptyStructuredFields, type Card } from "../src/record.ts";
import { BOARD_CARDS_LAYOUT, boardCardsSchema } from "../src/schemas.ts";

const cfgWithBoardCards: Config = {
  configVersion: 1,
  nodeUrl: "http://127.0.0.1:9",
  userHash: "user",
  schemaServiceUrl: "http://127.0.0.1:9",
  schemaHashes: {
    board: "board-hash",
    card: "card-hash",
    board_cards: "board-cards-hash",
  },
};

function card(partial: Partial<Card> = {}): Card {
  return {
    slug: "my-card",
    title: "My card",
    body: "SHOULD NOT APPEAR ON BOARD CARDS",
    board: "default",
    column: "todo",
    position: "3",
    assignee: "tom",
    tags: ["a"],
    deps: ["other"],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    ...emptyStructuredFields(),
    surfaces: ["src/**"],
    done_at: "",
    kind: "pr",
    repo: "EdgeVector/fkanban",
    ...partial,
  };
}

function casError(actual: unknown): FkanbanError {
  return new FkanbanError({
    code: "cas_conflict",
    message: "CAS precondition failed.",
    cause: { error: "cas_conflict", field: "column", expected: "todo", actual },
  });
}

function fakeNode(): NodeClient {
  type StoredRecord = { keyHash: string; rangeKey: string | null; fields: Record<string, unknown> };
  const store = new Map<string, Map<string, StoredRecord>>();
  const storeKey = (keyHash: string, rangeKey?: string | null) => `${keyHash}\0${rangeKey ?? ""}`;
  const tableFor = (schemaHash: string) => {
    let t = store.get(schemaHash);
    if (!t) {
      t = new Map();
      store.set(schemaHash, t);
    }
    return t;
  };
  const rowsFor = (schemaHash: string, filter?: QueryFilter): QueryRow[] => {
    const t = tableFor(schemaHash);
    const entries = filter?.HashKey
      ? [...t.values()].filter((rec) => rec.keyHash === filter.HashKey)
      : [...t.values()];
    return entries.map(({ keyHash, rangeKey, fields }) => ({
      fields,
      key: { hash: keyHash, range: rangeKey },
    }));
  };
  const checkExpected = (fields: Record<string, unknown>, expected?: CasExpectation) => {
    if (expected === undefined) return;
    const actual = fields[expected.field];
    if (expected.type === "absent") {
      if (actual !== undefined && actual !== "") throw casError(actual);
    } else if (actual !== expected.value) {
      throw casError(actual);
    }
  };
  const notImpl = (m: string) => async (): Promise<never> => {
    throw new Error(`fakeNode.${m} not implemented`);
  };
  return {
    baseUrl: cfgWithBoardCards.nodeUrl,
    userHash: cfgWithBoardCards.userHash,
    autoIdentity: notImpl("autoIdentity"),
    bootstrap: notImpl("bootstrap"),
    loadSchemas: notImpl("loadSchemas"),
    listSchemas: notImpl("listSchemas"),
    async createRecord({ schemaHash, fields, keyHash, rangeKey, expected }) {
      const table = tableFor(schemaHash);
      const key = storeKey(keyHash, rangeKey);
      checkExpected(table.get(key)?.fields ?? {}, expected);
      table.set(key, { keyHash, rangeKey: rangeKey ?? null, fields: { ...fields } });
    },
    async updateRecord({ schemaHash, fields, keyHash, rangeKey, expected }) {
      const table = tableFor(schemaHash);
      const key = storeKey(keyHash, rangeKey);
      if (!table.has(key)) throw new Error("missing for update");
      checkExpected(table.get(key)?.fields ?? {}, expected);
      table.set(key, { keyHash, rangeKey: rangeKey ?? null, fields: { ...fields } });
    },
    async deleteRecord({ schemaHash, keyHash, rangeKey }) {
      tableFor(schemaHash).delete(storeKey(keyHash, rangeKey));
    },
    async queryAll({ schemaHash, filter }): Promise<QueryResponse> {
      const results = rowsFor(schemaHash, filter);
      return { ok: true, results, returned_count: results.length, total_count: results.length };
    },
    rawCall: notImpl("rawCall") as NodeClient["rawCall"],
    nodeTransport: () => ({ transport: "unavailable" as const }),
  };
}

describe("board-cards keys", () => {
  test("sk is column#pos8#slug", () => {
    expect(boardCardSk("todo", "3", "my-card")).toBe("todo#00000003#my-card");
    expect(boardCardSk("doing", 42, "x")).toBe("doing#00000042#x");
  });

  test("parseSk round-trips", () => {
    const sk = boardCardSk("backlog", "10", "slug-with-dash");
    const p = parseBoardCardSk(sk);
    expect(p).toEqual({ column: "backlog", position: "10", slug: "slug-with-dash" });
  });

  test("column prefix sorts before later columns", () => {
    const keys = [
      boardCardSk("todo", 1, "a"),
      boardCardSk("doing", 1, "b"),
      boardCardSk("backlog", 1, "c"),
      boardCardSk("todo", 2, "d"),
    ].sort();
    expect(keys[0]!.startsWith("backlog#")).toBe(true);
    expect(keys.filter((k) => k.startsWith("todo#"))).toHaveLength(2);
  });
});

describe("board-cards projection", () => {
  test("fields omit body and set layout", () => {
    const f = boardCardFieldsFromCard(card());
    expect(f.body).toBeUndefined();
    expect(f.layout).toBe(BOARD_CARDS_LAYOUT);
    expect(f.sk).toBe("todo#00000003#my-card");
    expect(f.board).toBe("default");
    expect(f.slug).toBe("my-card");
    expect(f.deps).toEqual(["other"]);
  });

  test("cardFromBoardCardFields restores thin card with empty body", () => {
    const f = boardCardFieldsFromCard(card());
    const c = cardFromBoardCardFields(f);
    expect(c.body).toBe("");
    expect(c.slug).toBe("my-card");
    expect(c.column).toBe("todo");
    expect(c.kind).toBe("pr");
    expect(c.repo).toBe("EdgeVector/fkanban");
  });
});

describe("boardCards schema", () => {
  test("is HashRange on board/sk", () => {
    expect(boardCardsSchema.schema.schema_type).toBe("HashRange");
    expect(boardCardsSchema.schema.key).toEqual({
      hash_field: "board",
      range_field: "sk",
    });
    expect(boardCardsSchema.schema.fields).toContain("layout");
    expect(boardCardsSchema.schema.fields).not.toContain("body");
  });
});

describe("board-cards membership integrity", () => {
  test("preferFresherBoardCard keeps newer updated_at", () => {
    const older = card({ column: "doing", position: "1", updated_at: "2026-01-01T00:00:00.000Z" });
    const newer = card({ column: "done", position: "2", updated_at: "2026-01-02T00:00:00.000Z" });
    expect(preferFresherBoardCard(older, newer).column).toBe("done");
    expect(preferFresherBoardCard(newer, older).column).toBe("done");
  });

  test("upsert without previous purges orphan doing row", async () => {
    const node = fakeNode();
    const doing = card({ column: "doing", position: "5", updated_at: "2026-01-01T00:00:00.000Z" });
    const done = card({ column: "done", position: "9", updated_at: "2026-01-03T00:00:00.000Z" });
    await node.createRecord({
      schemaHash: cfgWithBoardCards.schemaHashes.board_cards!,
      keyHash: "default",
      rangeKey: boardCardSk(doing.column, doing.position, doing.slug),
      fields: boardCardFieldsFromCard(doing),
    });

    await upsertBoardCard(node, cfgWithBoardCards, done, null);

    const listed = await listAllBoardCards(node, cfgWithBoardCards, [{ slug: "default" }]);
    expect(listed).toHaveLength(1);
    expect(listed![0]!.column).toBe("done");
    expect(listed![0]!.slug).toBe("my-card");
  });

  test("listAllBoardCards prefers fresher when duplicates exist", async () => {
    const node = fakeNode();
    const doing = card({ column: "doing", position: "1", updated_at: "2026-01-01T00:00:00.000Z" });
    const done = card({ column: "done", position: "2", updated_at: "2026-01-02T00:00:00.000Z" });
    for (const c of [doing, done]) {
      await node.createRecord({
        schemaHash: cfgWithBoardCards.schemaHashes.board_cards!,
        keyHash: "default",
        rangeKey: boardCardSk(c.column, c.position, c.slug),
        fields: boardCardFieldsFromCard(c),
      });
    }
    const listed = await listAllBoardCards(node, cfgWithBoardCards, [{ slug: "default" }]);
    expect(listed).toHaveLength(1);
    expect(listed![0]!.column).toBe("done");
  });

  test("purgeOtherBoardCardRows keeps keepSk only", async () => {
    const node = fakeNode();
    const a = card({ column: "doing", position: "1" });
    const b = card({ column: "done", position: "2" });
    for (const c of [a, b]) {
      await node.createRecord({
        schemaHash: cfgWithBoardCards.schemaHashes.board_cards!,
        keyHash: "default",
        rangeKey: boardCardSk(c.column, c.position, c.slug),
        fields: boardCardFieldsFromCard(c),
      });
    }
    const keep = boardCardSk("done", "2", "my-card");
    const n = await purgeOtherBoardCardRows(node, cfgWithBoardCards, "default", "my-card", keep);
    expect(n).toBe(1);
    const listed = await listAllBoardCards(node, cfgWithBoardCards, [{ slug: "default" }]);
    expect(listed![0]!.column).toBe("done");
  });

  test("board-cards-heal deletes stale doing when card is done", async () => {
    const node = fakeNode();
    const doing = card({ column: "doing", position: "1", updated_at: "2026-01-01T00:00:00.000Z" });
    const done = card({ column: "done", position: "2", updated_at: "2026-01-02T00:00:00.000Z" });
    await node.createRecord({
      schemaHash: cfgWithBoardCards.schemaHashes.board!,
      keyHash: "default",
      fields: {
        slug: "default",
        title: "Default",
        body: "",
        columns: ["backlog", "todo", "doing", "done"],
        created_at: done.created_at,
        updated_at: done.updated_at,
      },
    });
    await node.createRecord({
      schemaHash: cfgWithBoardCards.schemaHashes.card!,
      keyHash: done.slug,
      fields: {
        slug: done.slug,
        title: done.title,
        body: done.body,
        board: done.board,
        column: done.column,
        position: done.position,
        assignee: "",
        tags: [],
        deps: [],
        surfaces: [],
        created_at: done.created_at,
        updated_at: done.updated_at,
      },
    });
    await node.createRecord({
      schemaHash: cfgWithBoardCards.schemaHashes.board_cards!,
      keyHash: "default",
      rangeKey: boardCardSk(doing.column, doing.position, doing.slug),
      fields: boardCardFieldsFromCard(doing),
    });

    const dry = await boardCardsHealResult({ cfg: cfgWithBoardCards, node, apply: false });
    expect(dry.report.drifted).toBeGreaterThanOrEqual(1);

    const applied = await boardCardsHealResult({ cfg: cfgWithBoardCards, node, apply: true });
    expect(applied.report.healed).toBeGreaterThanOrEqual(1);

    const listed = await listAllBoardCards(node, cfgWithBoardCards, [{ slug: "default" }]);
    expect(listed).toHaveLength(1);
    expect(listed![0]!.column).toBe("done");
  });
});
