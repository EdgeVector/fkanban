import { describe, expect, test } from "bun:test";

import { FkanbanError, type CasExpectation, type NodeClient, type QueryFilter, type QueryResponse, type QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { ClaimConflictError, moveCmd } from "../src/commands/move.ts";
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

function casError(actual: unknown): FkanbanError {
  return new FkanbanError({
    code: "cas_conflict",
    message: "CAS precondition failed.",
    cause: { error: "cas_conflict", field: "column", expected: "todo", actual },
  });
}

function fakeNode(): NodeClient {
  const store = new Map<string, Map<string, Record<string, unknown>>>();
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
      ? (t.has(filter.HashKey) ? [[filter.HashKey, t.get(filter.HashKey)!] as const] : [])
      : [...t.entries()].filter(([, fields]) =>
          !filter || Object.entries(filter).every(([field, value]) => fields[field] === value)
        );
    return entries.map(([hash, fields]) => ({ fields, key: { hash, range: null } }));
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
    async createRecord({ schemaHash, fields, keyHash, expected }) {
      const table = tableFor(schemaHash);
      checkExpected(table.get(keyHash) ?? {}, expected);
      table.set(keyHash, fields);
    },
    async updateRecord({ schemaHash, fields, keyHash, expected }) {
      const table = tableFor(schemaHash);
      checkExpected(table.get(keyHash) ?? {}, expected);
      table.set(keyHash, fields);
    },
    async deleteRecord({ schemaHash, keyHash }) {
      tableFor(schemaHash).delete(keyHash);
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
    body: "Repo: EdgeVector/fkanban\nBase: main\n\nClaim fixture.",
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
