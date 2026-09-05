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
  BOARD_CARDS_DISPLAY_FIELDS,
  BOARD_CARDS_LIST_FIELDS,
  boardCardFieldsFromCard,
  boardCardSk,
  boardCardsProjectionForCardFields,
  cardFromBoardCardFields,
  listAllBoardCards,
  listBoardCardsPartition,
  parseBoardCardSk,
  preferFresherBoardCard,
  purgeOtherBoardCardRows,
  sweepBoardCardJanitor,
  upsertBoardCard,
} from "../src/board-cards.ts";
import { resetBoardCardJanitorForTests } from "../src/board-card-janitor.ts";
import { CARD_LIST_INDEX_KEY } from "../src/card-list-index.ts";
import { boardCardsHealResult } from "../src/commands/board_cards_heal.ts";
import { emptyStructuredFields, type Card } from "../src/record.ts";
import {
  BOARD_CARDS_FIELDS,
  BOARD_CARDS_LAYOUT,
  boardCardsSchema,
  DEFAULT_COLUMNS,
} from "../src/schemas.ts";

const cfgWithBoardCards: Config = {
  configVersion: 1,
  nodeUrl: "http://127.0.0.1:9",
  userHash: "user",
  schemaServiceUrl: "http://127.0.0.1:9",
  schemaHashes: {
    board: "board-hash",
    card: "card-hash",
    card_list_index: "card-list-index-hash",
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
      // MERGE, not replace. A real LastDB update writes only the fields it is
      // handed and leaves the rest of the row intact (measured 2026-07-31,
      // scripts/probe-narrow-write-shape.ts: a 2-field update left the other
      // 22 fields readable at the full projection). A fake that replaces makes
      // every narrow write look like data loss and every wide write look
      // mandatory.
      const prior = table.get(key)?.fields ?? {};
      table.set(key, { keyHash, rangeKey: rangeKey ?? null, fields: { ...prior, ...fields } });
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

  test("boardCardsProjectionForCardFields always includes spine, never body/layout", () => {
    const proj = boardCardsProjectionForCardFields([
      "slug",
      "title",
      "body",
      "tags",
      "deps",
    ]);
    expect(proj).toContain("board");
    expect(proj).toContain("sk");
    expect(proj).toContain("column");
    expect(proj).toContain("position");
    expect(proj).toContain("title");
    expect(proj).toContain("tags");
    expect(proj).not.toContain("body");
    expect(proj).not.toContain("layout");
    // Display-sized: well under the full write shape.
    expect(proj.length).toBeLessThan(BOARD_CARDS_LIST_FIELDS.length);
    expect(BOARD_CARDS_DISPLAY_FIELDS.length).toBeLessThan(BOARD_CARDS_LIST_FIELDS.length);
  });

  test("listAllBoardCards defaults to product list projection (not full write shape)", async () => {
    const node = fakeNode();
    await upsertBoardCard(node, cfgWithBoardCards, card({ slug: "a" }), null, {
      skipOrphanPurge: true,
    });
    // Spy: queryAll fields
    const fieldsLog: string[][] = [];
    const orig = node.queryAll.bind(node);
    node.queryAll = async (opts) => {
      fieldsLog.push([...opts.fields]);
      return orig(opts);
    };
    await listAllBoardCards(node, cfgWithBoardCards, [{ slug: "default" }]);
    expect(fieldsLog.length).toBeGreaterThan(0);
    const proj = fieldsLog[0]!;
    expect(proj).not.toContain("layout");
    expect(proj).not.toContain("body");
    expect(proj).toContain("block_status");
    // `slug` is no longer fetched — it is sliced off `QueryRow.key.range`.
    // `board` stays because it LEADS, and the leading field gates the row set.
    expect(proj).not.toContain("slug");
    expect(proj[0]).toBe("board");
    expect(proj).toContain("position");
  });

  test("listBoardCardsPartition defaults to product list projection (not full write shape)", async () => {
    const node = fakeNode();
    await upsertBoardCard(node, cfgWithBoardCards, card({ slug: "a" }), null, {
      skipOrphanPurge: true,
    });
    const fieldsLog: string[][] = [];
    const orig = node.queryAll.bind(node);
    node.queryAll = async (opts) => {
      fieldsLog.push([...opts.fields]);
      return orig(opts);
    };
    await listBoardCardsPartition(node, cfgWithBoardCards, "default");
    expect(fieldsLog.length).toBeGreaterThan(0);
    const proj = fieldsLog[0]!;
    // Default must match listAllBoardCards — never silently hydrate layout/db.
    expect(proj).not.toContain("layout");
    expect(proj).not.toContain("db");
    expect(proj).not.toContain("body");
    expect(proj).toContain("block_status");
    expect(proj).toContain("title");
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

  test("skipOrphanPurge on create leaves no whole-partition list (mutation bar)", async () => {
    // createCardRecord passes skipOrphanPurge so a brand-new slug does not pay
    // listBoardCardsPartition on every add (measured multi-second on primary).
    const node = fakeNode();
    let partitionQueries = 0;
    const origQuery = node.queryAll.bind(node);
    node.queryAll = async (args: Parameters<typeof node.queryAll>[0]) => {
      const f = args.filter as { HashKey?: string } | undefined;
      if (f && typeof f === "object" && "HashKey" in f && f.HashKey === "default") {
        partitionQueries += 1;
      }
      return origQuery(args);
    };
    const fresh = card({ slug: "brand-new-card", column: "todo", position: "1" });
    await upsertBoardCard(node, cfgWithBoardCards, fresh, null, { skipOrphanPurge: true });
    expect(partitionQueries).toBe(0);
    const listed = await listAllBoardCards(node, cfgWithBoardCards, [{ slug: "default" }]);
    expect(listed!.some((c) => c.slug === "brand-new-card")).toBe(true);
  });

  test("upsert with previous sk does not re-list the BoardCards partition (move bar)", async () => {
    // Hot move path already deletes the known previous sk; a second full-board
    // partition scan for multi-orphan purge was pure latency
    // (papercut-fkanban-move-pays-whole-partition-orphan-scan).
    const node = fakeNode();
    const prev = card({ slug: "move-me", column: "todo", position: "1" });
    const next = card({ slug: "move-me", column: "doing", position: "2" });
    await node.createRecord({
      schemaHash: cfgWithBoardCards.schemaHashes.board_cards!,
      keyHash: "default",
      rangeKey: boardCardSk(prev.column, prev.position, prev.slug),
      fields: boardCardFieldsFromCard(prev),
    });
    let partitionQueries = 0;
    const origQuery = node.queryAll.bind(node);
    node.queryAll = async (args: Parameters<typeof node.queryAll>[0]) => {
      const f = args.filter as { HashKey?: string } | undefined;
      if (f && typeof f === "object" && "HashKey" in f && f.HashKey === "default") {
        partitionQueries += 1;
      }
      return origQuery(args);
    };
    await upsertBoardCard(node, cfgWithBoardCards, next, prev);
    expect(partitionQueries).toBe(0);
    await sweepBoardCardJanitor(node);
    const listed = await listAllBoardCards(node, cfgWithBoardCards, [{ slug: "default" }]);
    expect(listed).toHaveLength(1);
    expect(listed![0]!.column).toBe("doing");
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

  test("board-cards-heal deletes stale membership by its real range key", async () => {
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
      fields: { ...done, body: done.body },
    });

    // The row still lives at the old physical key, but protein folding has
    // refreshed its copied payload fields from current Card truth. Rebuilding
    // the delete address from those copies targets `doing#2`, not the real
    // `doing#1` key, and used to leave this row behind forever.
    await node.createRecord({
      schemaHash: cfgWithBoardCards.schemaHashes.board_cards!,
      keyHash: "default",
      rangeKey: boardCardSk(doing.column, doing.position, doing.slug),
      fields: boardCardFieldsFromCard(done),
    });

    const applied = await boardCardsHealResult({ cfg: cfgWithBoardCards, node, apply: true });
    expect(applied.report.healed).toBe(1);

    const listed = await listAllBoardCards(node, cfgWithBoardCards, [{ slug: "default" }]);
    expect(listed).toHaveLength(1);
    expect(listed![0]!.column).toBe("done");

    const clean = await boardCardsHealResult({ cfg: cfgWithBoardCards, node, apply: false });
    expect(clean.report.drifted).toBe(0);
    expect(clean.report.would_heal).toBe(0);
  });

  test("board-cards-heal trusts point-read card over stale CardListIndex", async () => {
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
        ...done,
        body: done.body,
      },
    });
    await node.createRecord({
      schemaHash: cfgWithBoardCards.schemaHashes.card_list_index!,
      keyHash: CARD_LIST_INDEX_KEY,
      fields: {
        key: CARD_LIST_INDEX_KEY,
        payload_json: JSON.stringify([{ ...doing, body: "" }]),
        updated_at: doing.updated_at,
      },
    });
    await node.createRecord({
      schemaHash: cfgWithBoardCards.schemaHashes.board_cards!,
      keyHash: "default",
      rangeKey: boardCardSk(doing.column, doing.position, doing.slug),
      fields: boardCardFieldsFromCard(doing),
    });

    const dry = await boardCardsHealResult({ cfg: cfgWithBoardCards, node, apply: false });
    expect(dry.report.drifted).toBe(1);
    expect(dry.report.actions[0]).toMatchObject({
      slug: "my-card",
      list_column: "doing",
      truth_column: "done",
      action: "delete-stale-and-upsert",
    });

    const applied = await boardCardsHealResult({ cfg: cfgWithBoardCards, node, apply: true });
    expect(applied.report.healed).toBe(1);
    const clean = await boardCardsHealResult({ cfg: cfgWithBoardCards, node, apply: false });
    expect(clean.report.drifted).toBe(0);

    const listed = await listAllBoardCards(node, cfgWithBoardCards, [{ slug: "default" }]);
    expect(listed).toHaveLength(1);
    expect(listed![0]!.column).toBe("done");
  });
});

/**
 * Cost regressions, not behaviour regressions.
 *
 * A heal that is merely correct can still be unusable: on the primary
 * (2026-07-28, ~310 cards) a read-only dry run took 5m19s, because every
 * candidate was point-read WITH its multi-KB body — a body BoardCards never
 * stores and the heal blanks on arrival — strictly one at a time, and every
 * repair then re-listed the whole partition hunting orphans it already knew
 * were absent. These lock the shape of the reads, which is what made it slow.
 */
describe("board-cards heal read cost", () => {
  /** Wrap a node, recording every query so a test can assert on read shape. */
  function recordingNode(inner: NodeClient): {
    node: NodeClient;
    queries: Array<{ schemaHash: string; fields: string[] }>;
  } {
    const queries: Array<{ schemaHash: string; fields: string[] }> = [];
    const node: NodeClient = {
      ...inner,
      async queryAll(req) {
        queries.push({ schemaHash: req.schemaHash, fields: [...(req.fields ?? [])] });
        return inner.queryAll(req);
      },
    };
    return { node, queries };
  }

  /** Board + `count` cards, none of which has a BoardCards row yet. */
  async function seedUnprojectedCards(node: NodeClient, count: number): Promise<void> {
    await node.createRecord({
      schemaHash: cfgWithBoardCards.schemaHashes.board!,
      keyHash: "default",
      fields: {
        slug: "default",
        title: "Default",
        body: "",
        columns: ["backlog", "todo", "doing", "done"],
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
    });
    for (let i = 0; i < count; i += 1) {
      const c = card({ slug: `card-${i}`, position: String(i), body: "x".repeat(4096) });
      await node.createRecord({
        schemaHash: cfgWithBoardCards.schemaHashes.card!,
        keyHash: c.slug,
        fields: { ...c, body: c.body },
      });
    }
  }

  test("never asks the node for card bodies it is about to discard", async () => {
    const { node, queries } = recordingNode(fakeNode());
    await seedUnprojectedCards(node, 5);
    queries.length = 0;

    const dry = await boardCardsHealResult({ cfg: cfgWithBoardCards, node, apply: false });
    expect(dry.report.drifted).toBe(5);

    const cardReads = queries.filter((q) => q.schemaHash === cfgWithBoardCards.schemaHashes.card);
    expect(cardReads.length).toBeGreaterThan(0);
    for (const read of cardReads) expect(read.fields).not.toContain("body");
  });

  test("--apply does not re-list the partition once per repaired card", async () => {
    const { node, queries } = recordingNode(fakeNode());
    await seedUnprojectedCards(node, 5);
    queries.length = 0;

    const applied = await boardCardsHealResult({ cfg: cfgWithBoardCards, node, apply: true });
    expect(applied.report.healed).toBe(5);

    // A fixed per-partition census and nothing per repaired card. The old code
    // added one whole-partition rescan per upsert, so this grew with the number
    // of cards repaired; that is what the bound exists to catch, and it still
    // does. Three fixed parts, each derived rather than written as a constant:
    //
    //  1. one wide read;
    //  2. one read per BoardCards field — the completeness sweep. A projection
    //     filters on its LEADING field, so a single read cannot enumerate a
    //     partition and heal, the only path allowed to DELETE rows, must not be
    //     reading through one. See `listBoardCardsPartitionComplete`.
    //  3. the read-divergence probe: one whole-partition read plus one range
    //     read per column, compared to catch a node serving a short page
    //     (`readBoardCardsPartitionDivergence`). Per BOARD and per COLUMN, both
    //     bounded by the schema — never per row and never per repair.
    const partitionReads = queries.filter(
      (q) => q.schemaHash === cfgWithBoardCards.schemaHashes.board_cards,
    );
    expect(partitionReads.length).toBeLessThanOrEqual(
      1 + BOARD_CARDS_FIELDS.length + 1 + DEFAULT_COLUMNS.length,
    );

    // ...and the repair still actually happened.
    const listed = await listAllBoardCards(node, cfgWithBoardCards, [{ slug: "default" }]);
    expect(listed).toHaveLength(5);
    const clean = await boardCardsHealResult({ cfg: cfgWithBoardCards, node, apply: false });
    expect(clean.report.drifted).toBe(0);
  });
});

// Membership (sk) can match while the row's COPIED fields are stale — a
// partial dual-write leaves title/kind/milestone/… wrong with column and
// position still agreeing. Until the thin-field comparison, heal reported
// drifted=0 on such rows, so the class was invisible to it
// (papercut-pickup-write-guard-failing-cards-poison-queue-head, item 3).
describe("board-cards-heal thin-field drift", () => {
  test("refreshes a membership-matching row whose copied fields went stale (incl. milestone)", async () => {
    const node = fakeNode();
    const truth = card({ title: "New title", column: "todo", position: "3", milestone: "ms-live" });
    await node.createRecord({
      schemaHash: cfgWithBoardCards.schemaHashes.board!,
      keyHash: "default",
      fields: {
        slug: "default",
        title: "Default",
        body: "",
        columns: ["backlog", "todo", "doing", "done"],
        created_at: truth.created_at,
        updated_at: truth.updated_at,
      },
    });
    await node.createRecord({
      schemaHash: cfgWithBoardCards.schemaHashes.card!,
      keyHash: truth.slug,
      fields: {
        slug: truth.slug,
        title: truth.title,
        body: "REAL BRIEF — never on a row",
        board: truth.board,
        column: truth.column,
        position: truth.position,
        assignee: truth.assignee,
        tags: truth.tags,
        deps: truth.deps,
        surfaces: truth.surfaces,
        created_at: truth.created_at,
        updated_at: truth.updated_at,
        kind: truth.kind,
        repo: truth.repo,
        base: truth.base,
        milestone: "ms-live",
        block_status: "none",
      },
    });
    // Same sk as truth (todo, position 3) but stale title and no milestone.
    const staleRow = card({ title: "Old title", column: "todo", position: "3" });
    await node.createRecord({
      schemaHash: cfgWithBoardCards.schemaHashes.board_cards!,
      keyHash: "default",
      rangeKey: boardCardSk("todo", "3", truth.slug),
      fields: boardCardFieldsFromCard(staleRow),
    });

    const dry = await boardCardsHealResult({ cfg: cfgWithBoardCards, node, apply: false });
    expect(dry.report.drifted).toBe(1);
    const drift = dry.report.actions.find((a) => a.action === "refresh-thin-fields");
    expect(drift).toBeDefined();
    expect(drift!.reason).toContain("title");
    expect(drift!.reason).toContain("milestone");

    const applied = await boardCardsHealResult({ cfg: cfgWithBoardCards, node, apply: true });
    expect(applied.report.healed).toBe(1);

    const rows = await listAllBoardCards(node, cfgWithBoardCards, [{ slug: "default" }]);
    expect(rows).toHaveLength(1);
    expect(rows![0]!.title).toBe("New title");
    // Regression: thinCard used to drop milestone, so a heal write blanked it
    // on the row — which also made the heal non-idempotent.
    expect(rows![0]!.milestone).toBe("ms-live");

    const clean = await boardCardsHealResult({ cfg: cfgWithBoardCards, node, apply: false });
    expect(clean.report.drifted).toBe(0);
  });
});

/**
 * Wide BoardCards writes.
 *
 * Every BoardCards write sends the full 24-field row, and there is no pre-write
 * read on the write path at all. This replaced a narrow path (read the row,
 * diff, send only the difference) on 2026-08-05, for two measured reasons:
 * payload width does not drive write cost on this schema — 24-changed 1983ms,
 * 2-changed 1768ms, narrow-4-field 1806ms against a 229ms noise floor, one
 * number — and the diff basis was the BoardCards index, which can serve
 * pre-write state, making "read it back to decide what to send" unsound
 * regardless of how small that window is on any given day. Method and numbers:
 * scripts/probe-partial-write-cost.ts, scripts/probe-prewrite-read-vs-blind-wide.ts,
 * scripts/probe-write-shape-vs-readback-freshness.ts.
 *
 * These tests lock the write SHAPE, because the failure mode of getting it
 * wrong is silent: a row missing an atom on any projected field is DROPPED from
 * every wide read, with no error (see BOARD_CARDS_SPINE_FIELDS). The stale-diff
 * regression the narrow path could suffer is pinned separately, in
 * test/board-cards-wide-write.test.ts.
 */
describe("board-cards wide write", () => {
  /** Wrap a node, recording every mutation's field payload. */
  function writeRecordingNode(inner: NodeClient): {
    node: NodeClient;
    writes: Array<{ op: "create" | "update"; schemaHash: string; fields: string[] }>;
    reads: Array<{ schemaHash: string }>;
  } {
    const writes: Array<{ op: "create" | "update"; schemaHash: string; fields: string[] }> = [];
    const reads: Array<{ schemaHash: string }> = [];
    const node: NodeClient = {
      ...inner,
      async createRecord(req) {
        writes.push({ op: "create", schemaHash: req.schemaHash, fields: Object.keys(req.fields) });
        return inner.createRecord(req);
      },
      async updateRecord(req) {
        writes.push({ op: "update", schemaHash: req.schemaHash, fields: Object.keys(req.fields) });
        return inner.updateRecord(req);
      },
      async queryAll(req) {
        reads.push({ schemaHash: req.schemaHash });
        return inner.queryAll(req);
      },
    };
    return { node, writes, reads };
  }

  const BC = cfgWithBoardCards.schemaHashes.board_cards!;
  const boardCardWrites = (
    writes: Array<{ op: "create" | "update"; schemaHash: string; fields: string[] }>,
  ) => writes.filter((w) => w.schemaHash === BC);

  test("a metadata change sends the whole row, not just the changed fields", async () => {
    const { node, writes } = writeRecordingNode(fakeNode());
    const before = card({ slug: "wide", tags: ["a"] });
    await upsertBoardCard(node, cfgWithBoardCards, before, null);
    writes.length = 0;

    // Same sk (column/position/slug unchanged) — a tag add.
    const after = card({ slug: "wide", tags: ["a", "b"], updated_at: "2026-02-02T00:00:00.000Z" });
    await upsertBoardCard(node, cfgWithBoardCards, after, before);

    const bc = boardCardWrites(writes);
    expect(bc).toHaveLength(1);
    expect(bc[0]!.op).toBe("update");
    // Sending two fields cost the same as sending 24 and diffed against a
    // 1.2-2.4s-stale row to decide which two. So: send all of them.
    expect(bc[0]!.fields.length).toBe(Object.keys(boardCardFieldsFromCard(after)).length);
    expect(bc[0]!.fields.length).toBeGreaterThanOrEqual(BOARD_CARDS_LIST_FIELDS.length);
    expect(bc[0]!.fields).toContain("tags");
    expect(bc[0]!.fields).toContain("milestone");
  });

  test("the row reads back correct at the full projection after a metadata change", async () => {
    const node = fakeNode();
    const before = card({ slug: "wide", tags: ["a"], milestone: "m1", repo: "EdgeVector/fkanban" });
    await upsertBoardCard(node, cfgWithBoardCards, before, null);

    const after = card({
      slug: "wide",
      tags: ["a", "b"],
      milestone: "m1",
      repo: "EdgeVector/fkanban",
      updated_at: "2026-02-02T00:00:00.000Z",
    });
    await upsertBoardCard(node, cfgWithBoardCards, after, before);

    const rows = (await listAllBoardCards(node, cfgWithBoardCards, [{ slug: "default" }])) ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.slug).toBe("wide");
    expect(rows[0]!.tags).toEqual(["a", "b"]);
    expect(rows[0]!.milestone).toBe("m1");
    expect(rows[0]!.repo).toBe("EdgeVector/fkanban");
    expect(rows[0]!.title).toBe(before.title);
  });

  test("an INCOMPLETE row is repaired wide", async () => {
    const { node, writes } = writeRecordingNode(fakeNode());
    const c = card({ slug: "wide" });
    const sk = boardCardSk(c.column, c.position, c.slug);
    // A row that predates a schema expand: present, but missing an atom on a
    // projected field, so every wide reader drops it.
    const partial = { ...boardCardFieldsFromCard(c) };
    delete partial.milestone;
    await node.createRecord({ schemaHash: BC, keyHash: "default", rangeKey: sk, fields: partial });
    writes.length = 0;

    await upsertBoardCard(node, cfgWithBoardCards, c, c);

    const bc = boardCardWrites(writes);
    expect(bc).toHaveLength(1);
    // Full write shape — this is what heals the hole.
    expect(bc[0]!.fields).toContain("milestone");
    expect(bc[0]!.fields).toContain("slug");
    expect(bc[0]!.fields.length).toBe(Object.keys(boardCardFieldsFromCard(c)).length);
  });

  test("a MOVE writes the destination row whole", async () => {
    const { node, writes, reads } = writeRecordingNode(fakeNode());
    const before = card({ slug: "wide", column: "todo", position: "3" });
    await upsertBoardCard(node, cfgWithBoardCards, before, null);
    writes.length = 0;
    reads.length = 0;

    const moved = card({ slug: "wide", column: "doing", position: "3" });
    resetBoardCardJanitorForTests();
    await upsertBoardCard(node, cfgWithBoardCards, moved, before);

    // A move with a known `previous` retires the source sk by address, so it
    // needs no partition read either.
    expect(reads.filter((r) => r.schemaHash === BC)).toHaveLength(0);

    // The destination sk does not exist, so `write` update-then-creates; both
    // attempts must carry the full shape.
    const bc = boardCardWrites(writes);
    expect(bc.length).toBeGreaterThan(0);
    for (const w of bc) {
      expect(w.fields.length).toBe(Object.keys(boardCardFieldsFromCard(moved)).length);
    }
    await sweepBoardCardJanitor(node);
    // And the card is where it was moved to, exactly once.
    const rows = (await listAllBoardCards(node, cfgWithBoardCards, [{ slug: "default" }])) ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.column).toBe("doing");
  });

  test("no BoardCards read is issued on the write path", async () => {
    const { node, reads } = writeRecordingNode(fakeNode());
    const c = card({ slug: "wide" });
    // skipOrphanPurge because the orphan rescan is a partition read by design
    // and a separate decision (BoardCardWriteOptions.skipOrphanPurge); what is
    // asserted here is that nothing reads the row back to decide the write.
    await upsertBoardCard(node, cfgWithBoardCards, c, null, { skipOrphanPurge: true });
    await upsertBoardCard(node, cfgWithBoardCards, c, c, { skipOrphanPurge: true });
    expect(reads.filter((r) => r.schemaHash === BC)).toHaveLength(0);
  });
});
