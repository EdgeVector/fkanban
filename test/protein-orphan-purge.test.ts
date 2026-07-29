/**
 * Protein success path must preserve BoardCards invariant: at most one row
 * per (board, slug). When updateCardRecord runs without `previous` (add-update,
 * backlog promote, pickup_claim), it must still purge other sks after protein
 * writes the next tip.
 *
 * Do NOT use mock.module on src/protein.ts here — bun keeps that process-wide
 * and poisons later suites that need real dual-write membership.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
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
import * as protein from "../src/protein.ts";

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
    boardRows() {
      return [...tableFor("board-cards-hash").values()];
    },
  };
}

describe("protein update orphan purge (BoardCards invariant)", () => {
  afterEach(() => {
    // Restore spies so later files (and later tests) see the real protein path.
    // Prefer spyOn over mock.module — mock.module is process-wide and sticky.
  });

  test("without previous, protein success still leaves one BoardCards row per slug", async () => {
    // Plant two sks for the same slug (stale todo + new doing) as a column move
    // without previous would leave under the old protein-only purge path.
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
      },
      keyHash: "default",
      rangeKey: staleSk,
    });
    await node.createRecord({
      schemaHash: boardHash,
      fields: {
        board: "default",
        sk: nextSk,
        slug,
        title: "Orphan probe",
        column: "doing",
        position: "9",
        layout: BOARD_CARDS_LAYOUT,
        milestone: "ms-1",
        tags: ["t"],
        kind: "pr",
      },
      keyHash: "default",
      rangeKey: nextSk,
    });
    expect(node.boardRows().filter((r) => r.fields.slug === slug)).toHaveLength(2);

    // Drive the real purge helper the protein success path must call when
    // previous is omitted (same entry point as upsertBoardCard no-previous).
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

  test("updateCardRecord protein success without previous purges orphans", async () => {
    const node = fakeStoreNode();
    const boardHash = "board-cards-hash";
    const slug = "orphan-card";
    const staleSk = boardCardSk("todo", "1", slug);
    const nextSk = boardCardSk("doing", "9", slug);

    // Pre-plant stale todo row only; protein path will "write" doing tip by our
    // spy, then updateCardRecord must purge the todo orphan.
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

    const writeSpy = spyOn(protein, "writeMembershipViaProtein").mockImplementation(
      async (n: NodeClient, _cfg: Config, card: Card | { slug: string; column: string; position: string; board?: string; title?: string; milestone?: string; tags?: string[]; kind?: string; assignee?: string; deps?: string[]; surfaces?: string[]; created_at?: string; created_by?: string; updated_at?: string; db?: string; repo?: string; base?: string; block_status?: string; block_reason?: string; north_star?: string; pr_url?: string; branch?: string }) => {
        const sk = boardCardSk(card.column, card.position, card.slug);
        await n.createRecord({
          schemaHash: boardHash,
          fields: {
            board: card.board || "default",
            sk,
            slug: card.slug,
            title: (card as Card).title ?? "",
            column: card.column,
            position: String(card.position),
            layout: BOARD_CARDS_LAYOUT,
            milestone: (card as Card).milestone ?? "",
            tags: (card as Card).tags ?? [],
            kind: (card as Card).kind ?? "",
            assignee: (card as Card).assignee ?? "",
            deps: (card as Card).deps ?? [],
            surfaces: (card as Card).surfaces ?? [],
            created_at: (card as Card).created_at ?? "",
            created_by: (card as Card).created_by ?? "",
            updated_at: (card as Card).updated_at ?? "",
            db: (card as Card).db ?? "",
            repo: (card as Card).repo ?? "",
            base: (card as Card).base ?? "",
            block_status: (card as Card).block_status ?? "",
            block_reason: (card as Card).block_reason ?? "",
            north_star: (card as Card).north_star ?? "",
            pr_url: (card as Card).pr_url ?? "",
            branch: (card as Card).branch ?? "",
          },
          keyHash: card.board || "default",
          rangeKey: sk,
        });
        return true;
      },
    );

    try {
      const { updateCardRecord } = await import("../src/record.ts");

      // Fat Card write goes to card-hash; plant empty so updateRecord can "succeed".
      await node.createRecord({
        schemaHash: "card-hash",
        fields: { slug, title: "Orphan probe", column: "doing" },
        keyHash: slug,
      });

      const next = baseCard({ column: "doing", position: "9", slug });
      // CRITICAL: omit previous — the production bug path.
      await updateCardRecord({ cfg, node }, next);

      const rows = node.boardRows().filter((r) => r.fields.slug === slug);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.rangeKey).toBe(nextSk);
      expect(rows[0]!.fields.column).toBe("doing");
      expect(writeSpy).toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
      protein.resetProteinCaches();
    }
  });
});
