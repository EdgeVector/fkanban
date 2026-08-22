import { describe, expect, test } from "bun:test";

import { boardCardFieldsFromCard, boardCardSk } from "../src/board-cards.ts";
import { FkanbanError, type CasExpectation, type NodeClient, type QueryFilter, type QueryResponse, type QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { pickupClaimV2Result } from "../src/commands/pickup_claim_v2.ts";
import { claimCard } from "../src/commands/move.ts";
import { cardToFields, emptyStructuredFields, findCard, type Card } from "../src/record.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: {
    card: "cardhash",
    board: "boardhash",
    board_cards: "boardcardshash",
  },
};

type StoredRecord = {
  keyHash: string;
  rangeKey: string | null;
  fields: Record<string, unknown>;
};

type QueryLog = {
  schemaHash: string;
  fields: string[];
  filter?: QueryFilter;
};

type MutationLog = {
  schemaHash: string;
  keyHash: string;
  fields: Record<string, unknown>;
  expected?: CasExpectation;
};

function casError(actual: unknown): FkanbanError {
  return new FkanbanError({
    code: "cas_conflict",
    message: "CAS precondition failed.",
    cause: { field: "column", expected: "todo", actual },
  });
}

function fakeNode(opts: { conflictSlug?: string } = {}): NodeClient & {
  queries: QueryLog[];
  mutations: MutationLog[];
} {
  const store = new Map<string, Map<string, StoredRecord>>();
  const queries: QueryLog[] = [];
  const mutations: MutationLog[] = [];
  let injectedConflict = false;
  const storeKey = (keyHash: string, rangeKey?: string | null) => `${keyHash}\0${rangeKey ?? ""}`;
  const tableFor = (schemaHash: string) => {
    let table = store.get(schemaHash);
    if (!table) {
      table = new Map();
      store.set(schemaHash, table);
    }
    return table;
  };
  const rowsFor = (schemaHash: string, filter?: QueryFilter): QueryRow[] => {
    const table = tableFor(schemaHash);
    const prefix = (filter as { HashRangePrefix?: { hash?: string; prefix?: string } } | undefined)?.HashRangePrefix;
    let records: StoredRecord[];
    if (prefix?.hash && prefix.prefix !== undefined) {
      records = [...table.values()].filter((record) =>
        record.keyHash === prefix.hash &&
        typeof record.rangeKey === "string" &&
        record.rangeKey.startsWith(prefix.prefix!)
      );
    } else if (filter?.HashKey) {
      records = [...table.values()].filter((record) => record.keyHash === filter.HashKey);
    } else {
      records = [...table.values()];
    }
    return records.map((record) => ({
      fields: record.fields,
      key: { hash: record.keyHash, range: record.rangeKey },
    }));
  };
  const checkExpected = (fields: Record<string, unknown>, expected?: CasExpectation) => {
    if (!expected) return;
    const actual = fields[expected.field];
    if (expected.type === "absent") {
      if (actual !== undefined && actual !== "") throw casError(actual);
    } else if (actual !== expected.value) {
      throw casError(actual);
    }
  };
  const notImplemented = (name: string) => async (): Promise<never> => {
    throw new Error(`fakeNode.${name} not implemented`);
  };

  return {
    baseUrl: cfg.nodeUrl,
    userHash: cfg.userHash,
    queries,
    mutations,
    autoIdentity: notImplemented("autoIdentity"),
    bootstrap: notImplemented("bootstrap"),
    loadSchemas: notImplemented("loadSchemas"),
    listSchemas: notImplemented("listSchemas"),
    async createRecord({ schemaHash, fields, keyHash, rangeKey, expected }) {
      const table = tableFor(schemaHash);
      const key = storeKey(keyHash, rangeKey);
      checkExpected(table.get(key)?.fields ?? {}, expected);
      table.set(key, { keyHash, rangeKey: rangeKey ?? null, fields });
    },
    async updateRecord({ schemaHash, fields, keyHash, rangeKey, expected }) {
      const table = tableFor(schemaHash);
      const key = storeKey(keyHash, rangeKey);
      if (!injectedConflict && schemaHash === "cardhash" && keyHash === opts.conflictSlug) {
        const previous = table.get(key);
        if (previous) previous.fields = { ...previous.fields, column: "doing" };
        injectedConflict = true;
      }
      checkExpected(table.get(key)?.fields ?? {}, expected);
      mutations.push({ schemaHash, keyHash, fields, expected });
      table.set(key, {
        keyHash,
        rangeKey: rangeKey ?? null,
        fields: { ...table.get(key)?.fields, ...fields },
      });
    },
    async deleteRecord({ schemaHash, keyHash, rangeKey }) {
      tableFor(schemaHash).delete(storeKey(keyHash, rangeKey));
    },
    async queryAll({ schemaHash, fields, filter }): Promise<QueryResponse> {
      queries.push({ schemaHash, fields, filter });
      const results = rowsFor(schemaHash, filter);
      return { ok: true, results, returned_count: results.length, total_count: results.length };
    },
    rawCall: notImplemented("rawCall") as NodeClient["rawCall"],
    nodeTransport: () => ({ transport: "unavailable" as const }),
  };
}

function card(partial: Partial<Card> & { slug: string }): Card {
  const { slug, ...overrides } = partial;
  return {
    slug,
    title: partial.title ?? slug,
    body: partial.body ?? "## GOAL\nfixture\n\n## END STATE\ndone\n",
    board: partial.board ?? "default",
    column: partial.column ?? "todo",
    position: partial.position ?? "1",
    assignee: partial.assignee ?? "",
    tags: partial.tags ?? [],
    deps: partial.deps ?? [],
    ...emptyStructuredFields(),
    repo: partial.repo ?? "EdgeVector/fkanban",
    base: partial.base ?? "main",
    kind: partial.kind ?? "pr",
    surfaces: partial.surfaces ?? ["src/a.ts"],
    created_at: partial.created_at ?? "2026-01-01T00:00:00.000Z",
    updated_at: partial.updated_at ?? "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

async function seedCard(node: NodeClient, value: Card, membership = true): Promise<void> {
  await node.createRecord({
    schemaHash: cfg.schemaHashes.card!,
    keyHash: value.slug,
    fields: cardToFields(value),
  });
  if (!membership) return;
  await node.createRecord({
    schemaHash: cfg.schemaHashes.board_cards!,
    keyHash: value.board,
    rangeKey: boardCardSk(value.column, value.position, value.slug),
    fields: boardCardFieldsFromCard(value),
  });
}

function prefixOf(query: QueryLog): string | undefined {
  return (query.filter as { HashRangePrefix?: { prefix?: string } } | undefined)?.HashRangePrefix?.prefix;
}

describe("pickup claim v2 LastDB adapter", () => {
  test("uses two column reads and point-reads an unresolved dependency", async () => {
    const node = fakeNode();
    await seedCard(node, card({ slug: "candidate", deps: ["done-dep"] }));
    await seedCard(node, card({ slug: "done-dep", column: "done" }), false);

    const result = await pickupClaimV2Result({ cfg, node, dryRun: true });

    expect(result).toMatchObject({ result: "claimed", dry_run: true, card: { slug: "candidate" } });
    const boardReads = node.queries.filter((query) => query.schemaHash === "boardcardshash");
    expect(boardReads.map(prefixOf)).toEqual(["todo#", "doing#"]);
    expect(boardReads.every((query) => !query.filter || !("HashKey" in query.filter))).toBe(true);
    const dependencyReads = node.queries.filter((query) =>
      query.schemaHash === "cardhash" && query.filter?.HashKey === "done-dep"
    );
    expect(dependencyReads).toHaveLength(1);
  });

  test("the Card CAS write moves and stamps the worker together", async () => {
    const node = fakeNode();
    await seedCard(node, card({ slug: "candidate" }));

    const result = await pickupClaimV2Result({ cfg, node, worker: "worker-a" });

    expect(result).toMatchObject({
      result: "claimed",
      worker: "worker-a",
      card: { slug: "candidate", column: "doing", assignee: "worker-a" },
    });
    const cardWrites = node.mutations.filter((mutation) => mutation.schemaHash === "cardhash");
    expect(cardWrites).toHaveLength(1);
    expect(cardWrites[0]).toMatchObject({
      keyHash: "candidate",
      fields: { column: "doing", assignee: "worker-a" },
      expected: { type: "value", field: "column", value: "todo" },
    });
    expect(await findCard(node, cfg, "candidate")).toMatchObject({
      column: "doing",
      assignee: "worker-a",
    });
  });

  test("a missing surface reserves the repository", async () => {
    const node = fakeNode();
    await seedCard(node, card({ slug: "candidate", surfaces: [] }));
    await seedCard(node, card({ slug: "peer", column: "doing", surfaces: ["README.md"] }));

    await expect(pickupClaimV2Result({ cfg, node, dryRun: true })).resolves.toEqual({
      result: "none",
      dry_run: true,
    });
  });

  test("a claim conflict continues to the next eligible card", async () => {
    const node = fakeNode({ conflictSlug: "first" });
    await seedCard(node, card({ slug: "first", position: "1", surfaces: ["src/a.ts"] }));
    await seedCard(node, card({ slug: "second", position: "2", surfaces: ["src/b.ts"] }));

    const result = await pickupClaimV2Result({ cfg, node, worker: "worker-a" });

    expect(result).toMatchObject({ result: "claimed", card: { slug: "second" } });
  });

  test("the atomic primitive rejects an empty worker", async () => {
    const node = fakeNode();
    await seedCard(node, card({ slug: "candidate" }));
    await expect(claimCard({ cfg, node, slug: "candidate", worker: "" })).rejects.toMatchObject({
      code: "missing_worker",
    });
  });

  test("concurrent requests produce one winner for one card", async () => {
    const node = fakeNode();
    await seedCard(node, card({ slug: "candidate" }));

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        pickupClaimV2Result({ cfg, node, worker: `worker-${index}` })
      ),
    );

    const claimed = results.filter((result) => result.result === "claimed");
    expect(claimed).toHaveLength(1);
    expect(results.filter((result) => result.result === "none")).toHaveLength(19);
    const stored = await findCard(node, cfg, "candidate");
    expect(stored).toMatchObject({
      column: "doing",
      assignee: claimed[0]?.result === "claimed" ? claimed[0].worker : "unreachable",
    });
  });

  test("concurrent conflicts continue until each available card has one winner", async () => {
    const node = fakeNode();
    await seedCard(node, card({ slug: "first", position: "1", surfaces: ["src/a.ts"] }));
    await seedCard(node, card({ slug: "second", position: "2", surfaces: ["src/b.ts"] }));

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        pickupClaimV2Result({ cfg, node, worker: `worker-${index}` })
      ),
    );

    const winners = results.flatMap((result) => result.result === "claimed" ? [result.card.slug] : []);
    expect(winners.sort()).toEqual(["first", "second"]);
    expect(new Set(winners).size).toBe(2);
  });
});
