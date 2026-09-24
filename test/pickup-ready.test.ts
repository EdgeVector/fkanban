import { beforeEach, describe, expect, test } from "bun:test";

import { boardCardFieldsFromCard, boardCardSk } from "../src/board-cards.ts";
import type { CasExpectation, NodeClient, QueryFilter, QueryResponse, QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { pickupReadyResult } from "../src/commands/pickup_status.ts";
import { pickupStatusResult } from "../src/commands/pickup_status.ts";
import {
  boardToFields,
  cardToFields,
  emptyStructuredFields,
  nowIso,
  type Board,
  type Card,
} from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";
import { HUMAN_BOARD_COLUMNS, PICKUP_CATEGORIES } from "../src/pickup.ts";

// Same three schema hashes as pickup-claim-v2.test.ts: this is the only cfg
// shape where BOTH the full report (`listCards({activeOnly:true})`) and the
// cheap path (`listCardsByColumn`) read via BoardCards rather than falling
// back to a Card-schema scan — the comparison only means something when both
// sides exercise the same read family.
const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash", board_cards: "boardcardshash" },
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

function fakeNode(): NodeClient & { queries: QueryLog[] } {
  const store = new Map<string, Map<string, StoredRecord>>();
  const queries: QueryLog[] = [];
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
    const prefix = (filter as { HashRangePrefix?: { hash?: string; prefix?: string } } | undefined)
      ?.HashRangePrefix;
    let records: StoredRecord[];
    if (prefix?.hash && prefix.prefix !== undefined) {
      records = [...table.values()].filter(
        (record) =>
          record.keyHash === prefix.hash &&
          typeof record.rangeKey === "string" &&
          record.rangeKey.startsWith(prefix.prefix!),
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
      if (actual !== undefined && actual !== "") throw new Error("cas_conflict");
    } else if (actual !== expected.value) {
      throw new Error("cas_conflict");
    }
  };
  const notImplemented = (name: string) => async (): Promise<never> => {
    throw new Error(`fakeNode.${name} not implemented`);
  };
  return {
    baseUrl: cfg.nodeUrl,
    userHash: cfg.userHash,
    queries,
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
      checkExpected(table.get(key)?.fields ?? {}, expected);
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

function board(partial: Partial<Board>): Board {
  const now = nowIso();
  return {
    slug: "default",
    title: "Default",
    body: "Repo: EdgeVector/fold\nBase: main\n\n## GOAL\nfixture\n\n## END STATE\ndone\n",
    columns: [...DEFAULT_COLUMNS],
    created_at: now,
    updated_at: now,
    ...partial,
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
    block_status: partial.block_status ?? "none",
    created_at: partial.created_at ?? "2026-01-01T00:00:00.000Z",
    updated_at: partial.updated_at ?? "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

async function seedBoard(node: NodeClient, b: Board): Promise<void> {
  await node.createRecord({ schemaHash: cfg.schemaHashes.board!, keyHash: b.slug, fields: boardToFields(b) });
}

async function seedCard(node: NodeClient, value: Card): Promise<void> {
  await node.createRecord({ schemaHash: cfg.schemaHashes.card!, keyHash: value.slug, fields: cardToFields(value) });
  await node.createRecord({
    schemaHash: cfg.schemaHashes.board_cards!,
    keyHash: value.board,
    rangeKey: boardCardSk(value.column, value.position, value.slug),
    fields: boardCardFieldsFromCard(value),
  });
}

function readySlugs(cards: { slug: string; category: string }[]): string[] {
  return cards.filter((c) => c.category === "pickup-ready").map((c) => c.slug).sort();
}

describe("pickup ready (cheap gate path) agrees with pickup status (full report)", () => {
  let node: NodeClient & { queries: QueryLog[] };

  beforeEach(async () => {
    node = fakeNode();
    await seedBoard(node, board({ slug: "default", columns: [...DEFAULT_COLUMNS] }));
    await seedBoard(node, board({ slug: "human", title: "Human", columns: [...HUMAN_BOARD_COLUMNS] }));
  });

  test("ready count and ready slug set are identical across every pickup category", async () => {
    // One card per category classifyPickupCard can produce, spread across
    // both boards and every default column, so a cheap path that silently
    // read the wrong partition would disagree with the full report here.
    await seedCard(node, card({ slug: "ready-one", column: "todo" }));
    await seedCard(node, card({ slug: "ready-two", column: "todo", position: "2" }));
    await seedCard(node, card({ slug: "dep-target", column: "doing" }));
    await seedCard(node, card({ slug: "blocked", column: "todo", deps: ["dep-target"] }));
    await seedCard(node, card({ slug: "human-gated", board: "human", column: "todo", block_status: "needs_human" }));
    await seedCard(node, card({ slug: "malformed", column: "todo", repo: "", body: "no routing header" }));
    await seedCard(node, card({ slug: "tracker", column: "todo", kind: "tracker" }));
    await seedCard(node, card({ slug: "parked-backlog", column: "backlog" }));
    await seedCard(node, card({ slug: "collision-doing", column: "doing" }));
    await seedCard(node, card({ slug: "finished", column: "done" }));

    const full = await pickupStatusResult({ cfg, node });
    const cheap = await pickupReadyResult({ cfg, node, board: "default" });

    expect(cheap.report.ready).toBe(full.report.ready);
    expect(cheap.report.ready).toBe(2);
    expect(readySlugs(cheap.report.cards)).toEqual(readySlugs(full.report.cards));
    expect(readySlugs(cheap.report.cards)).toEqual(["ready-one", "ready-two"]);
  });

  test("a merged card reopened for validation is not ready, in the gate or the full report", async () => {
    const body =
      "Repo: EdgeVector/last-stack\n\n## GOAL\nx\n" +
      "PROOF[reopened-end-state-unmet]: reopened from CLOSED-ON-MERGE: live --list omits it\n";
    await seedCard(node, card({ slug: "reopened", column: "todo", body }));
    await seedCard(node, card({ slug: "real-work", column: "todo", position: "2" }));

    const full = await pickupStatusResult({ cfg, node });
    const cheap = await pickupReadyResult({ cfg, node, board: "default" });

    expect(cheap.report.ready).toBe(1);
    expect(full.report.ready).toBe(1);
    expect(readySlugs(cheap.report.cards)).toEqual(["real-work"]);
    expect(readySlugs(full.report.cards)).toEqual(["real-work"]);
    const row = cheap.report.cards.find((c) => c.slug === "reopened");
    expect(row?.category).toBe("parked/non-work");
    expect(row?.reason).toContain("validate-only");
    expect(cheap.report.counts["pickup-ready"]).toBe(1);
  });

  test("a dependency satisfied only outside the todo partition still reads ready", async () => {
    await seedCard(node, card({ slug: "done-elsewhere", column: "done" }));
    await seedCard(node, card({ slug: "dependent", column: "todo", deps: ["done-elsewhere"] }));

    const full = await pickupStatusResult({ cfg, node });
    const cheap = await pickupReadyResult({ cfg, node, board: "default" });

    expect(cheap.report.ready).toBe(full.report.ready);
    expect(cheap.report.ready).toBe(1);
    expect(readySlugs(cheap.report.cards)).toEqual(["dependent"]);
  });

  test("the cheap path reads only the default board's todo partition, not the whole board", async () => {
    await seedCard(node, card({ slug: "ready-one", column: "todo" }));
    await seedCard(node, card({ slug: "parked-backlog", column: "backlog" }));
    await seedCard(node, card({ slug: "collision-doing", column: "doing" }));
    await seedCard(node, card({ slug: "human-gated", board: "human", column: "todo", block_status: "needs_human" }));

    node.queries.length = 0;
    await pickupReadyResult({ cfg, node, board: "default" });

    const boardCardReads = node.queries.filter((q) => q.schemaHash === "boardcardshash");
    const prefixes = boardCardReads
      .map((q) => (q.filter as { HashRangePrefix?: { hash?: string; prefix?: string } } | undefined)?.HashRangePrefix)
      .filter((p): p is { hash?: string; prefix?: string } => p !== undefined);
    // Exactly the default board's todo# partition, plus its doing# range when
    // a card is ready (the overlap fence that decides `claimable`) — never
    // backlog#/done#, and never the human board.
    expect(prefixes.every((p) => p.hash === "default")).toBe(true);
    expect(prefixes.every((p) => p.prefix === "todo#" || p.prefix === "doing#")).toBe(true);
    expect(prefixes.some((p) => p.prefix === "todo#")).toBe(true);
    expect(prefixes.length).toBeGreaterThan(0);
    // A HashKey here is the whole-partition spine that used to ride along
    // every column list. Ready is the pickup gate; it must not hydrate ~365
    // BoardCards atoms to classify default/todo.
    expect(boardCardReads.some((q) => q.filter?.HashKey !== undefined)).toBe(false);
  });

  test("the cheap path does not call listCards({ activeOnly }) over every board", async () => {
    await seedCard(node, card({ slug: "ready-one", column: "todo" }));
    await seedCard(node, card({ slug: "collision-doing", column: "doing" }));
    await seedCard(node, card({ slug: "parked-backlog", column: "backlog" }));

    node.queries.length = 0;
    await pickupReadyResult({ cfg, node, board: "default" });

    const boardCardReads = node.queries.filter((q) => q.schemaHash === "boardcardshash");
    // listCards({ activeOnly: true }) walks every active column (HashRangeRange
    // or HashKey of the board). Ready must stay on one todo# prefix.
    expect(boardCardReads.length).toBeGreaterThan(0);
    for (const q of boardCardReads) {
      const prefix = (q.filter as { HashRangePrefix?: { prefix?: string } } | undefined)?.HashRangePrefix;
      expect(["todo#", "doing#"]).toContain(prefix?.prefix ?? "");
      expect(q.filter).not.toHaveProperty("HashKey");
      expect(q.filter).not.toHaveProperty("HashRangeRange");
    }
  });

  test("every pickup category is representable so the comparison is not vacuous", async () => {
    await seedCard(node, card({ slug: "ready", column: "todo" }));
    await seedCard(node, card({ slug: "dep-target", column: "doing" }));
    await seedCard(node, card({ slug: "blocked", column: "todo", deps: ["dep-target"] }));
    await seedCard(node, card({ slug: "human-gated", board: "human", column: "todo", block_status: "needs_human" }));
    await seedCard(node, card({ slug: "malformed", column: "todo", repo: "", body: "no routing header" }));
    await seedCard(node, card({ slug: "tracker", column: "todo", kind: "tracker" }));
    await seedCard(node, card({ slug: "collision-doing", column: "doing" }));

    const { report } = await pickupStatusResult({ cfg, node });
    const seen = new Set(report.cards.map((c) => c.category));
    for (const category of [
      "pickup-ready",
      "blocked-on-dependency",
      "human-gated",
      "malformed-routing",
      "parked/non-work",
      "collision",
    ] satisfies (typeof PICKUP_CATEGORIES)[number][]) {
      expect(seen.has(category)).toBe(true);
    }
  });

  test("MCP fkanban_pickup_status uses pickupReadyResult, not pickupStatusResult", async () => {
    const src = await Bun.file(new URL("../src/mcp/server.ts", import.meta.url)).text();
    expect(src).not.toMatch(/\bpickupStatusResult\b/);
    expect(src).toMatch(/\bpickupReadyResult\b/);
  });
});

describe("pickup ready reports claimable after the surface-overlap fence", () => {
  // papercut-kanban-pickup-gate-ready-overstates-eligible-20260922
  test("a ready card fenced by a live doing peer is ready but not claimable", async () => {
    const node = fakeNode();
    await seedBoard(node, board({ slug: "default", columns: [...DEFAULT_COLUMNS] }));
    const now = new Date().toISOString();
    await seedCard(node, card({ slug: "ready-fenced", column: "todo", surfaces: ["src/a.ts"] }));
    await seedCard(node, card({ slug: "ready-free", column: "todo", surfaces: ["src/b.ts"] }));
    await seedCard(
      node,
      card({
        slug: "peer",
        column: "doing",
        surfaces: ["src/a.ts"],
        first_doing_at: now,
        updated_at: now,
        position: String(Date.now()),
      }),
    );

    const { report, text } = await pickupReadyResult({ cfg, node, board: "default" });
    expect(report.ready).toBe(2);
    expect(report.claimable).toBe(1);
    expect(report.fenced).toEqual([{ slug: "ready-fenced", peers: ["peer"] }]);
    expect(text).toContain("claimable=1");
  });
});
