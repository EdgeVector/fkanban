import { beforeEach, describe, expect, test } from "bun:test";

import { FkanbanError, type CasExpectation, type NodeClient, type QueryFilter, type QueryResponse, type QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { pickupClaimResult } from "../src/commands/pickup_claim.ts";
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

function board(partial: Partial<Board> = {}): Board {
  const now = nowIso();
  return {
    slug: "default",
    title: "Default",
    body: "",
    columns: [...DEFAULT_COLUMNS],
    created_at: now,
    updated_at: now,
    ...partial,
  };
}

function card(partial: Partial<Card>): Card {
  const now = nowIso();
  return {
    slug: "card",
    title: "Card",
    body: "Repo: EdgeVector/fkanban\nBase: main\n\nWork unit.",
    board: "default",
    column: "todo",
    position: "10",
    assignee: "",
    tags: [],
    deps: [],
    created_at: now,
    updated_at: now,
    ...emptyStructuredFields(),
    kind: "pr",
    block_status: "none",
    repo: "EdgeVector/fkanban",
    base: "main",
    ...partial,
  };
}

async function seedBoard(node: NodeClient, b: Board) {
  await node.createRecord({
    schemaHash: cfg.schemaHashes.board!,
    keyHash: b.slug,
    fields: boardToFields(b),
  });
}

async function seedCard(node: NodeClient, c: Card) {
  await node.createRecord({
    schemaHash: cfg.schemaHashes.card!,
    keyHash: c.slug,
    fields: cardToFields(c),
  });
}

describe("pickup claim", () => {
  let node: NodeClient;

  beforeEach(async () => {
    node = fakeNode();
    await seedBoard(node, board());
  });

  test("claims the highest-priority ready card into doing", async () => {
    await seedCard(node, card({
      slug: "low",
      title: "Low",
      tags: ["p3"],
      created_at: "2026-01-01T00:00:00.000Z",
      body: "Repo: EdgeVector/fkanban\nBase: main\nPriority: P3\n\nLow.",
    }));
    await seedCard(node, card({
      slug: "high",
      title: "High",
      tags: ["p0"],
      created_at: "2026-01-02T00:00:00.000Z",
      body: "Repo: EdgeVector/fkanban\nBase: main\nPriority: P0\n\nHigh.",
    }));

    const result = await pickupClaimResult({
      cfg,
      node,
      worker: "worker-a",
    });

    expect(result.claimed).toBe(true);
    expect(result.reason).toBe("claimed");
    expect(result.card?.slug).toBe("high");
    expect(result.from).toBe("todo");
    expect(result.to).toBe("doing");
    expect(result.card?.assignee).toBe("worker-a");
    expect(result.card?.column).toBe("doing");

    const onBoard = await findCard(node, cfg, "high");
    expect(onBoard?.column).toBe("doing");
    expect(onBoard?.assignee).toBe("worker-a");
  });

  test("skips surface-overlapping in-flight work and claims the next card", async () => {
    await seedCard(node, card({
      slug: "inflight",
      column: "doing",
      repo: "EdgeVector/fold",
      surfaces: ["src/engine/**"],
      body: "Repo: EdgeVector/fold\nBase: main\nSurfaces: src/engine/**\n\nIn flight.",
    }));
    await seedCard(node, card({
      slug: "overlap-todo",
      repo: "EdgeVector/fold",
      surfaces: ["src/engine/foo.ts"],
      tags: ["p0"],
      body: "Repo: EdgeVector/fold\nBase: main\nPriority: P0\nSurfaces: src/engine/foo.ts\n\nOverlaps.",
      created_at: "2026-01-01T00:00:00.000Z",
    }));
    await seedCard(node, card({
      slug: "other-repo",
      repo: "EdgeVector/kanban",
      surfaces: ["src/cli.ts"],
      tags: ["p1"],
      body: "Repo: EdgeVector/kanban\nBase: main\nPriority: P1\nSurfaces: src/cli.ts\n\nOther.",
      created_at: "2026-01-02T00:00:00.000Z",
    }));

    const result = await pickupClaimResult({ cfg, node });
    expect(result.claimed).toBe(true);
    expect(result.card?.slug).toBe("other-repo");
    expect(result.skipped.some((s) => s.slug === "overlap-todo" && s.reason === "surface-overlap")).toBe(true);
  });

  test("dry-run selects without moving", async () => {
    await seedCard(node, card({ slug: "ready-one", tags: ["p1"] }));

    const result = await pickupClaimResult({ cfg, node, dryRun: true });
    expect(result.claimed).toBe(true);
    expect(result.reason).toBe("dry-run");
    expect(result.card?.slug).toBe("ready-one");

    const still = await findCard(node, cfg, "ready-one");
    expect(still?.column).toBe("todo");
  });

  test("exclude-repo and prefer-repo filter ordering", async () => {
    await seedCard(node, card({
      slug: "fold-card",
      repo: "EdgeVector/fold",
      tags: ["p0"],
      body: "Repo: EdgeVector/fold\nBase: main\nPriority: P0\n\nFold.",
      created_at: "2026-01-01T00:00:00.000Z",
    }));
    await seedCard(node, card({
      slug: "kanban-card",
      repo: "EdgeVector/kanban",
      tags: ["p2"],
      body: "Repo: EdgeVector/kanban\nBase: main\nPriority: P2\n\nKanban.",
      created_at: "2026-01-02T00:00:00.000Z",
    }));

    const excluded = await pickupClaimResult({
      cfg,
      node,
      excludeRepo: ["EdgeVector/fold"],
    });
    expect(excluded.card?.slug).toBe("kanban-card");
    expect(excluded.skipped.some((s) => s.reason === "exclude-repo")).toBe(true);

    // Reset fold card still in todo; re-seed kanban as doing so only fold remains
    node = fakeNode();
    await seedBoard(node, board());
    await seedCard(node, card({
      slug: "fold-card",
      repo: "EdgeVector/fold",
      tags: ["p2"],
      body: "Repo: EdgeVector/fold\nBase: main\nPriority: P2\n\nFold.",
      created_at: "2026-01-01T00:00:00.000Z",
    }));
    await seedCard(node, card({
      slug: "kanban-card",
      repo: "EdgeVector/kanban",
      tags: ["p0"],
      body: "Repo: EdgeVector/kanban\nBase: main\nPriority: P0\n\nKanban.",
      created_at: "2026-01-02T00:00:00.000Z",
    }));
    const preferred = await pickupClaimResult({
      cfg,
      node,
      preferRepo: ["EdgeVector/fold"],
    });
    // prefer-repo wins over pure priority: fold P2 before kanban P0
    expect(preferred.card?.slug).toBe("fold-card");
  });

  test("at-capacity when doing count hits max-doing", async () => {
    await seedCard(node, card({ slug: "already-doing", column: "doing" }));
    await seedCard(node, card({ slug: "ready", tags: ["p0"] }));

    const result = await pickupClaimResult({ cfg, node, maxDoing: 1 });
    expect(result.claimed).toBe(false);
    expect(result.reason).toBe("at-capacity");
  });

  test("no-eligible when queue empty of ready work", async () => {
    await seedCard(node, card({
      slug: "blocked",
      deps: ["missing-dep"],
      body: "Repo: EdgeVector/fkanban\nBase: main\n\nBlocked.",
    }));
    // missing dep card itself
    await seedCard(node, card({
      slug: "missing-dep",
      column: "todo",
      body: "Repo: EdgeVector/fkanban\nBase: main\n\nDep.",
    }));
    // Wait - if missing-dep is also ready, blocked isn't ready. claim might take missing-dep.
    // Seed only a human-gated card:
    node = fakeNode();
    await seedBoard(node, board());
    await seedCard(node, card({
      slug: "human",
      block_status: "needs_human",
      block_reason: "waiting on Tom",
    }));

    const result = await pickupClaimResult({ cfg, node });
    expect(result.claimed).toBe(false);
    expect(result.reason).toBe("no-eligible");
    expect(result.scanned_ready).toBe(0);
  });

  test("no-eligible when every ready candidate is skipped", async () => {
    await seedCard(node, card({
      slug: "fold-card",
      repo: "EdgeVector/fold",
      body: "Repo: EdgeVector/fold\nBase: main\nPriority: P1\n\nFold.",
    }));

    const result = await pickupClaimResult({
      cfg,
      node,
      excludeRepo: ["EdgeVector/fold"],
    });

    expect(result.claimed).toBe(false);
    expect(result.reason).toBe("no-eligible");
    expect(result.scanned_ready).toBe(1);
    expect(result.skipped).toContainEqual({
      slug: "fold-card",
      reason: "exclude-repo",
      detail: "EdgeVector/fold",
    });
  });

  test("claim_conflict on first candidate falls through to second", async () => {
    await seedCard(node, card({
      slug: "first",
      tags: ["p0"],
      created_at: "2026-01-01T00:00:00.000Z",
      body: "Repo: EdgeVector/a\nBase: main\nPriority: P0\n\nFirst.",
      repo: "EdgeVector/a",
    }));
    await seedCard(node, card({
      slug: "second",
      tags: ["p1"],
      created_at: "2026-01-02T00:00:00.000Z",
      body: "Repo: EdgeVector/b\nBase: main\nPriority: P1\n\nSecond.",
      repo: "EdgeVector/b",
    }));

    // Pre-move first to doing under CAS so claim sees conflict when it tries first
    // Simulate race: another worker already moved first between status and move.
    // Easiest: wrap updateRecord to fail CAS once for "first".
    const baseUpdate = node.updateRecord.bind(node);
    let firstAttempts = 0;
    node.updateRecord = async (args) => {
      if (args.keyHash === "first" && args.expected?.type === "value" && args.expected.value === "todo") {
        firstAttempts += 1;
        throw casError("doing");
      }
      return baseUpdate(args);
    };

    const result = await pickupClaimResult({ cfg, node });
    expect(firstAttempts).toBeGreaterThanOrEqual(1);
    expect(result.claimed).toBe(true);
    expect(result.card?.slug).toBe("second");
    expect(result.skipped.some((s) => s.slug === "first" && s.reason === "claim_conflict")).toBe(true);
  });
});
