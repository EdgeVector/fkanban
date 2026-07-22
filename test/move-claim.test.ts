import { describe, expect, test } from "bun:test";

import { FkanbanError, type CasExpectation, type NodeClient, type QueryFilter, type QueryResponse, type QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { ClaimConflictError, moveCmd } from "../src/commands/move.ts";
import { listCmd } from "../src/commands/list.ts";
import { boardCardFieldsFromCard, boardCardSk } from "../src/board-cards.ts";
import {
  boardToFields,
  cardToFields,
  emptyStructuredFields,
  findCard,
  nowIso,
  type Board,
  type Card,
} from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash" },
};
const cfgWithBoardCards: Config = {
  ...cfg,
  schemaHashes: { ...cfg.schemaHashes, board_cards: "boardcardshash" },
};

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
      : [...t.values()].filter((rec) =>
          !filter || Object.entries(filter).every(([field, value]) => rec.fields[field] === value)
        );
    return entries.map(({ keyHash, rangeKey, fields }) => ({ fields, key: { hash: keyHash, range: rangeKey } }));
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
    baseUrl: cfg.nodeUrl,
    userHash: cfg.userHash,
    autoIdentity: notImpl("autoIdentity"),
    bootstrap: notImpl("bootstrap"),
    loadSchemas: notImpl("loadSchemas"),
    listSchemas: notImpl("listSchemas"),
    async createRecord({ schemaHash, fields, keyHash, rangeKey, expected }) {
      const table = tableFor(schemaHash);
      const key = storeKey(keyHash, rangeKey);
      checkExpected(table.get(key)?.fields ?? {}, expected);
      table.set(key, { keyHash, rangeKey: rangeKey ?? null, fields });
    },
    async updateRecord({ schemaHash, fields, keyHash, rangeKey, expected }) {
      const table = tableFor(schemaHash);
      const key = storeKey(keyHash, rangeKey);
      checkExpected(table.get(key)?.fields ?? {}, expected);
      table.set(key, { keyHash, rangeKey: rangeKey ?? null, fields });
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

function card(partial: Partial<Card>): Card {
  const now = nowIso();
  return {
    slug: "claim-me",
    title: "Claim me",
    body: "Repo: EdgeVector/fkanban\nBase: main\n\n## GOAL\nfixture\n\n## END STATE\ndone\n",
    board: "default",
    column: "todo",
    position: "1",
    assignee: "",
    tags: [],
    deps: [],
    ...emptyStructuredFields(),
    created_at: now,
    updated_at: now,
    ...partial,
  };
}

function board(partial: Partial<Board> = {}): Board {
  const now = nowIso();
  return {
    slug: "default",
    title: "Default board",
    body: "",
    columns: [...DEFAULT_COLUMNS],
    created_at: now,
    updated_at: now,
    ...partial,
  };
}

async function seed(node: NodeClient) {
  await node.createRecord({
    schemaHash: cfg.schemaHashes.board!,
    keyHash: "default",
    fields: boardToFields(board()),
  });
  await node.createRecord({
    schemaHash: cfg.schemaHashes.card!,
    keyHash: "claim-me",
    fields: cardToFields(card({})),
  });
}

async function seedBoardCard(node: NodeClient, c: Card) {
  await node.createRecord({
    schemaHash: cfgWithBoardCards.schemaHashes.board_cards!,
    keyHash: c.board,
    rangeKey: boardCardSk(c.column, c.position, c.slug),
    fields: boardCardFieldsFromCard(c),
  });
}

describe("move claim guard", () => {
  test("move --from is exactly-one-winner under a CAS-aware node", async () => {
    const node = fakeNode();
    await seed(node);

    const first = await moveCmd({ cfg, node, slug: "claim-me", column: "doing", expectColumn: "todo" });
    expect(first).toMatchObject({ slug: "claim-me", from: "todo", to: "doing" });

    await expect(
      moveCmd({ cfg, node, slug: "claim-me", column: "doing", expectColumn: "todo" }),
    ).rejects.toMatchObject({
      code: "claim_conflict",
      current: "doing",
      expected: "todo",
    });
    expect(await findCard(node, cfg, "claim-me")).toMatchObject({ column: "doing" });
  });

  test("plain move remains idempotent without a claim guard", async () => {
    const node = fakeNode();
    await seed(node);

    await moveCmd({ cfg, node, slug: "claim-me", column: "doing" });
    const second = await moveCmd({ cfg, node, slug: "claim-me", column: "doing" });

    expect(second).toMatchObject({ slug: "claim-me", from: "doing", to: "doing" });
  });

  test("move removes the old BoardCards row so column list previews follow show", async () => {
    const node = fakeNode();
    const initial = card({ column: "doing", position: "2" });
    await node.createRecord({
      schemaHash: cfgWithBoardCards.schemaHashes.board!,
      keyHash: "default",
      fields: boardToFields(board()),
    });
    await node.createRecord({
      schemaHash: cfgWithBoardCards.schemaHashes.card!,
      keyHash: initial.slug,
      fields: cardToFields(initial),
    });
    await seedBoardCard(node, initial);

    await moveCmd({ cfg: cfgWithBoardCards, node, slug: initial.slug, column: "done" });

    expect(await findCard(node, cfgWithBoardCards, initial.slug)).toMatchObject({ column: "done" });
    const doing = JSON.parse(await listCmd({ cfg: cfgWithBoardCards, node, column: "doing", json: true }));
    expect(doing.map((c: { slug: string }) => c.slug)).not.toContain(initial.slug);
  });

  test("list repairs a stale BoardCards row from point-read card truth", async () => {
    const node = fakeNode();
    const stale = card({ column: "doing", position: "2", updated_at: "2026-01-01T00:00:00.000Z" });
    const truth = card({ column: "done", position: "9", updated_at: "2026-01-02T00:00:00.000Z" });
    await node.createRecord({
      schemaHash: cfgWithBoardCards.schemaHashes.board!,
      keyHash: "default",
      fields: boardToFields(board()),
    });
    await node.createRecord({
      schemaHash: cfgWithBoardCards.schemaHashes.card!,
      keyHash: truth.slug,
      fields: cardToFields(truth),
    });
    await seedBoardCard(node, stale);

    const doing = JSON.parse(await listCmd({ cfg: cfgWithBoardCards, node, column: "doing", json: true }));
    expect(doing.map((c: { slug: string }) => c.slug)).not.toContain(truth.slug);

    const all = JSON.parse(await listCmd({ cfg: cfgWithBoardCards, node, json: true }));
    expect(all).toMatchObject([{ slug: truth.slug, column: "done", position: "9" }]);
  });

  test("move refuses an ambient DB that disagrees with the card home DB", async () => {
    const node = fakeNode();
    await seed(node);

    await moveCmd({ cfg, node, slug: "claim-me", column: "doing", dbLocator: "lastdb://personal" });
    const after = await findCard(node, cfg, "claim-me");
    expect(after?.db).toBe("lastdb://personal");
    expect(after?.body.startsWith("Db: lastdb://personal\n")).toBe(true);

    await expect(
      moveCmd({
        cfg,
        node,
        slug: "claim-me",
        column: "review",
        dbLocator: "lastdb://org/edgevector/company",
      }),
    ).rejects.toMatchObject({ code: "db_locator_mismatch" });
  });

  test("claim conflict exposes the current column", () => {
    const err = new ClaimConflictError({ slug: "claim-me", expected: "todo", current: "review" });
    expect(err.code).toBe("claim_conflict");
    expect(err.current).toBe("review");
    expect(err.expected).toBe("todo");
  });
});
