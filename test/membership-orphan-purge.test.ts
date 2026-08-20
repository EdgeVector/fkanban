/**
 * BoardCards invariant: at most one row per (board, slug).
 *
 * The path that breaks it is `updateCardRecord` called without `previous`
 * (add-update, backlog promote, pickup_claim) — nothing names the old
 * `column#position#slug`, so a column move leaves the stale sk behind unless the
 * membership write scans for it.
 */
import { describe, expect, test } from "bun:test";
import type {
  NodeClient,
  QueryFilter,
  QueryResponse,
  QueryRow,
} from "../src/client.ts";
import type { Config } from "../src/config.ts";
import {
  boardCardSk,
  listBoardCardsPartition,
  purgeOtherBoardCardRows,
} from "../src/board-cards.ts";
import { emptyStructuredFields, type Card } from "../src/record.ts";
import { BOARD_CARDS_LAYOUT } from "../src/schemas.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://127.0.0.1:9",
  userHash: "user",
  schemaServiceUrl: "http://127.0.0.1:9",
  schemaHashes: {
    board: "board-hash",
    card: "card-hash",
    board_cards: "board-cards-hash",
    milestone_cards: "milestone-cards-hash",
  },
};

function baseCard(partial: Partial<Card> = {}): Card {
  return {
    slug: "orphan-card",
    title: "Orphan probe",
    body: "body",
    board: "default",
    column: "todo",
    position: "1",
    assignee: "",
    tags: ["t"],
    deps: [],
    created_at: "2026-01-01T00:00:00.000Z",
    created_by: "test",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...emptyStructuredFields(),
    kind: "pr",
    repo: "EdgeVector/fkanban",
    milestone: "ms-1",
    ...partial,
  };
}

function fakeStoreNode(): NodeClient & {
  boardRows: () => Array<{ keyHash: string; rangeKey: string | null; fields: Record<string, unknown> }>;
} {
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
  const notImpl = (m: string) => async (): Promise<never> => {
    throw new Error(`fakeNode.${m} not implemented`);
  };
  return {
    baseUrl: cfg.nodeUrl,
    userHash: cfg.userHash,
    autoIdentity: notImpl("autoIdentity"),
    bootstrap: notImpl("bootstrap"),
    loadSchemas: notImpl("loadSchemas"),
    listSchemas: notImpl("listSchemas"),
    async createRecord({ schemaHash, fields, keyHash, rangeKey }) {
      const table = tableFor(schemaHash);
      table.set(storeKey(keyHash, rangeKey), {
        keyHash,
        rangeKey: rangeKey ?? null,
        fields: { ...fields },
      });
    },
    async updateRecord({ schemaHash, fields, keyHash, rangeKey }) {
      const table = tableFor(schemaHash);
      const key = storeKey(keyHash, rangeKey);
      // Upsert semantics for test convenience.
      table.set(key, { keyHash, rangeKey: rangeKey ?? null, fields: { ...table.get(key)?.fields, ...fields } });
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
    boardRows() {
      return [...tableFor("board-cards-hash").values()];
    },
  };
}

describe("membership orphan purge (BoardCards invariant)", () => {
  test("the purge helper collapses a slug's rows down to the current sk", async () => {
    const node = fakeStoreNode();
    const boardHash = "board-cards-hash";
    const slug = "orphan-card";
    const staleSk = boardCardSk("todo", "1", slug);
    const nextSk = boardCardSk("doing", "9", slug);
    for (const [sk, column, position] of [
      [staleSk, "todo", "1"],
      [nextSk, "doing", "9"],
    ] as const) {
      await node.createRecord({
        schemaHash: boardHash,
        fields: {
          board: "default",
          sk,
          slug,
          title: "Orphan probe",
          column,
          position,
          layout: BOARD_CARDS_LAYOUT,
          milestone: "ms-1",
          tags: ["t"],
          kind: "pr",
        },
        keyHash: "default",
        rangeKey: sk,
      });
    }
    expect(node.boardRows().filter((r) => r.fields.slug === slug)).toHaveLength(2);

    const purged = await purgeOtherBoardCardRows(node, cfg, "default", slug, nextSk);
    expect(purged).toBeGreaterThanOrEqual(1);

    const remaining = node.boardRows().filter((r) => r.fields.slug === slug);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.rangeKey).toBe(nextSk);
    expect(remaining[0]!.fields.column).toBe("doing");

    const listed = await listBoardCardsPartition(node, cfg, "default");
    const hits = (listed ?? []).filter((c) => c.slug === slug);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.column).toBe("doing");
  });

  test("updateCardRecord without previous does not scan; unnamed orphan stays until heal", async () => {
    const node = fakeStoreNode();
    const boardHash = "board-cards-hash";
    const slug = "orphan-card";
    const staleSk = boardCardSk("todo", "1", slug);
    const nextSk = boardCardSk("doing", "9", slug);

    await node.createRecord({
      schemaHash: boardHash,
      fields: {
        board: "default",
        sk: staleSk,
        slug,
        title: "Orphan probe",
        column: "todo",
        position: "1",
        layout: BOARD_CARDS_LAYOUT,
        milestone: "ms-1",
        tags: ["t"],
        kind: "pr",
        assignee: "",
        deps: [],
        surfaces: [],
        created_at: "t",
        created_by: "t",
        updated_at: "t",
        db: "",
        repo: "EdgeVector/fkanban",
        base: "",
        block_status: "",
        block_reason: "",
        north_star: "",
        pr_url: "",
        branch: "",
      },
      keyHash: "default",
      rangeKey: staleSk,
    });

    const { updateCardRecord } = await import("../src/record.ts");

    // Fat Card write goes to card-hash; plant empty so updateRecord can succeed.
    await node.createRecord({
      schemaHash: "card-hash",
      fields: { slug, title: "Orphan probe", column: "doing" },
      keyHash: slug,
    });

    const next = baseCard({ column: "doing", position: "9", slug });
    // Omit previous: the write path must not scan the partition. The unnamed
    // stale sk stays until heal / a sweeper that already listed the partition.
    await updateCardRecord({ cfg, node }, next);

    const rows = node.boardRows().filter((r) => r.fields.slug === slug);
    expect(rows.map((r) => r.rangeKey).sort()).toEqual([nextSk, staleSk].sort());
    expect(rows.some((r) => r.rangeKey === nextSk && r.fields.column === "doing")).toBe(true);
  });
});
