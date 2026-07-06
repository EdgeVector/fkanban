// Priority ranking: the signal (`Priority:` body header or a p0..p3 tag) and
// the `rank` command that turns it into the `position` field fkanban-pickup
// already drains by (lowest first). These unit-test the pure read/order core
// plus the `rank` command against the same in-memory fake NodeClient the other
// command tests use — so the whole groom→pickup priority path is covered with
// no live node.

import { beforeEach, describe, expect, test } from "bun:test";

import { FkanbanError } from "../src/client.ts";
import type { NodeClient, QueryFilter, QueryResponse, QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import {
  DEFAULT_PRIORITY,
  boardToFields,
  emptyStructuredFields,
  findCard,
  isPriorityTag,
  normalizePriority,
  priorityOf,
  priorityRank,
  priorityTag,
  rankCards,
  withPriorityTag,
  type Card,
} from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";
import { addCmd } from "../src/commands/add.ts";
import { rankCmd } from "../src/commands/rank.ts";

// ── Pure signal: priorityOf + helpers ───────────────────────────────────────

describe("priorityOf", () => {
  const card = (body: string, tags: string[] = []) => ({ body, tags });

  test("a line-anchored Priority: header wins", () => {
    expect(priorityOf(card("Priority: P0\n\nbody"))).toBe("P0");
    expect(priorityOf(card("Repo: x/y\nBase: main\nPriority: P1\n\nbody"))).toBe("P1");
    // Case-insensitive on label + token.
    expect(priorityOf(card("priority: p3\n\nbody"))).toBe("P3");
  });

  test("a P-mention mid-prose does NOT count as the header", () => {
    // Not line-anchored → falls through to default (no tag either).
    expect(priorityOf(card("see Priority: P0 in the linked doc"))).toBe(DEFAULT_PRIORITY);
  });

  test("falls back to a p0..p3 tag when no header", () => {
    expect(priorityOf(card("body", ["auth", "p0"]))).toBe("P0");
    expect(priorityOf(card("body", ["P2"]))).toBe("P2");
    // Leading # tolerated.
    expect(priorityOf(card("body", ["#p1"]))).toBe("P1");
  });

  test("header beats a conflicting tag", () => {
    expect(priorityOf(card("Priority: P0\n\nbody", ["p3"]))).toBe("P0");
  });

  test("no signal → DEFAULT_PRIORITY (P2)", () => {
    expect(priorityOf(card("just a body", ["auth", "bug"]))).toBe("P2");
    expect(DEFAULT_PRIORITY).toBe("P2");
    // p4 is not a tier — ignored.
    expect(priorityOf(card("body", ["p4"]))).toBe("P2");
  });
});

describe("priority tag helpers", () => {
  test("normalizePriority canonicalizes accepted spellings, else null", () => {
    expect(normalizePriority("p1")).toBe("P1");
    expect(normalizePriority(" P0 ")).toBe("P0");
    expect(normalizePriority("p4")).toBeNull();
    expect(normalizePriority("high")).toBeNull();
  });

  test("priorityTag / isPriorityTag round-trip", () => {
    expect(priorityTag("P1")).toBe("p1");
    expect(isPriorityTag("p0")).toBe(true);
    expect(isPriorityTag("#p3")).toBe(true);
    expect(isPriorityTag("auth")).toBe(false);
    expect(isPriorityTag("p9")).toBe(false);
  });

  test("withPriorityTag replaces any existing priority tag, keeps the rest in order", () => {
    expect(withPriorityTag(["auth", "p3", "bug"], "P0")).toEqual(["auth", "bug", "p0"]);
    expect(withPriorityTag(["auth"], "P2")).toEqual(["auth", "p2"]);
    // Idempotent on the same tier.
    expect(withPriorityTag(["p1", "x"], "P1")).toEqual(["x", "p1"]);
  });

  test("priorityRank orders P0 < P1 < P2 < P3", () => {
    expect(priorityRank("P0")).toBeLessThan(priorityRank("P1"));
    expect(priorityRank("P3")).toBeGreaterThan(priorityRank("P2"));
  });
});

// ── Pure order: rankCards ────────────────────────────────────────────────────

describe("rankCards", () => {
  const mk = (slug: string, created_at: string, tags: string[] = [], body = ""): Card => ({
    slug,
    title: slug,
    body,
    board: "default",
    column: "todo",
    position: "",
    assignee: "",
    tags,
    deps: [],
    ...emptyStructuredFields(),
    created_at,
    updated_at: created_at,
  });

  test("sorts by priority ascending, created_at as the tiebreak", () => {
    const cards = [
      mk("c", "2026-01-03", ["p2"]),
      mk("a", "2026-01-01", ["p0"]),
      mk("b", "2026-01-02", ["p0"]),
      mk("d", "2026-01-04"), // no signal → P2
      mk("e", "2026-01-05", ["p3"]),
    ];
    expect(rankCards(cards).map((c) => c.slug)).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("a Priority: header outranks a p-tag on another card", () => {
    const cards = [mk("tagged", "2026-01-01", ["p1"]), mk("headed", "2026-01-02", [], "Priority: P0\n\nx")];
    expect(rankCards(cards).map((c) => c.slug)).toEqual(["headed", "tagged"]);
  });

  test("is pure — input array is not mutated", () => {
    const cards = [mk("b", "2026-01-02", ["p3"]), mk("a", "2026-01-01", ["p0"])];
    const before = cards.map((c) => c.slug);
    rankCards(cards);
    expect(cards.map((c) => c.slug)).toEqual(before);
  });
});

// ── rank command (against a fake node) ───────────────────────────────────────

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash" },
};

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
    async createRecord({ schemaHash, fields, keyHash }) {
      tableFor(schemaHash).set(keyHash, fields);
    },
    async updateRecord({ schemaHash, fields, keyHash }) {
      tableFor(schemaHash).set(keyHash, fields);
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

function seedBoard(node: NodeClient, slug: string, columns: string[]) {
  const now = "2026-01-01T00:00:00Z";
  return node.createRecord({
    schemaHash: cfg.schemaHashes.board!,
    keyHash: slug,
    fields: boardToFields({ slug, title: slug, body: "", columns, created_at: now, updated_at: now }),
  });
}

describe("rank command", () => {
  let node: NodeClient;

  beforeEach(async () => {
    node = fakeNode();
    await seedBoard(node, "default", [...DEFAULT_COLUMNS]);
  });

  // Add cards with explicit created_at ordering so the tiebreak is deterministic.
  async function seedTodo(): Promise<void> {
    // Created oldest→newest: c1, c2, c3, c4. Priorities scrambled vs age.
    await addCmd({ cfg, node, slug: "c1", column: "todo", priority: "P2", tags: ["fold"] });
    await addCmd({ cfg, node, slug: "c2", column: "todo", priority: "P0", tags: ["fold"] });
    await addCmd({ cfg, node, slug: "c3", column: "todo", tags: ["fold"] }); // no priority → P2
    await addCmd({ cfg, node, slug: "c4", column: "todo", priority: "P0", tags: ["fold"] });
  }

  test("assigns gap-spaced positions in priority order (default todo)", async () => {
    await seedTodo();
    const res = await rankCmd({ cfg, node });
    expect(res.board).toBe("default");
    expect(res.column).toBe("todo");
    expect(res.total).toBe(4);
    // Both P0s first (c2 before c4 by created order), then the two P2s (c1, c3).
    expect(res.order.map((o) => o.slug)).toEqual(["c2", "c4", "c1", "c3"]);
    expect(res.order.map((o) => o.position)).toEqual([10, 20, 30, 40]);

    // Positions actually persisted.
    expect((await findCard(node, cfg, "c2"))?.position).toBe("10");
    expect((await findCard(node, cfg, "c4"))?.position).toBe("20");
    expect((await findCard(node, cfg, "c1"))?.position).toBe("30");
    expect((await findCard(node, cfg, "c3"))?.position).toBe("40");
  });

  test("is idempotent — a second run reorders nothing", async () => {
    await seedTodo();
    const first = await rankCmd({ cfg, node });
    expect(first.reordered).toBe(4);
    const second = await rankCmd({ cfg, node });
    expect(second.reordered).toBe(0);
    expect(second.order.map((o) => o.slug)).toEqual(first.order.map((o) => o.slug));
  });

  test("only ranks the requested column", async () => {
    await seedTodo();
    await addCmd({ cfg, node, slug: "done1", column: "done", priority: "P0", tags: ["fold"] });
    const res = await rankCmd({ cfg, node }); // todo only
    expect(res.order.map((o) => o.slug)).not.toContain("done1");
    // The done card's position is untouched (still its append epoch-millis).
    const done = await findCard(node, cfg, "done1");
    expect(done?.position).not.toBe("10");
  });

  test("skips meta/grouping cards in the ranked column", async () => {
    await addCmd({ cfg, node, slug: "work", column: "todo", priority: "P1", tags: ["fold"] });
    await addCmd({ cfg, node, slug: "umbrella", column: "todo", priority: "P0", tags: ["fold"], kind: "umbrella" });
    const before = (await findCard(node, cfg, "umbrella"))?.position;
    const res = await rankCmd({ cfg, node });

    expect(res.total).toBe(1);
    expect(res.order.map((o) => o.slug)).toEqual(["work"]);
    expect((await findCard(node, cfg, "work"))?.position).toBe("10");
    expect((await findCard(node, cfg, "umbrella"))?.position).toBe(before);
  });

  test("an empty column ranks cleanly (total 0, nothing written)", async () => {
    const res = await rankCmd({ cfg, node, column: "review" });
    expect(res.total).toBe(0);
    expect(res.reordered).toBe(0);
    expect(res.order).toEqual([]);
  });

  test("a non-existent column on the board is rejected", async () => {
    await expect(rankCmd({ cfg, node, column: "nope" })).rejects.toBeInstanceOf(FkanbanError);
  });

  test("a non-existent board is rejected", async () => {
    await expect(rankCmd({ cfg, node, board: "ghost" })).rejects.toBeInstanceOf(FkanbanError);
  });
});

// ── add --priority sets the tag without disturbing others ────────────────────

describe("add --priority", () => {
  let node: NodeClient;

  beforeEach(async () => {
    node = fakeNode();
    await seedBoard(node, "default", [...DEFAULT_COLUMNS]);
  });

  test("create stamps the priority tag alongside other tags", async () => {
    await addCmd({ cfg, node, slug: "x", column: "todo", priority: "P1", tags: ["auth", "fold"] });
    const card = await findCard(node, cfg, "x");
    expect(card?.tags).toContain("p1");
    expect(card?.tags).toEqual(expect.arrayContaining(["auth", "fold"]));
    expect(priorityOf({ body: card!.body, tags: card!.tags })).toBe("P1");
  });

  test("update --priority replaces the old tier, keeps the rest", async () => {
    await addCmd({ cfg, node, slug: "y", column: "todo", priority: "P3", tags: ["fold"] });
    await addCmd({ cfg, node, slug: "y", priority: "P0" });
    const card = await findCard(node, cfg, "y");
    expect(card?.tags).toContain("p0");
    expect(card?.tags).not.toContain("p3");
    expect(card?.tags).toContain("fold");
  });

  test("omitting --priority on update leaves the existing priority tag intact", async () => {
    await addCmd({ cfg, node, slug: "z", column: "todo", priority: "P1", tags: ["fold"] });
    await addCmd({ cfg, node, slug: "z", title: "renamed" }); // no priority
    const card = await findCard(node, cfg, "z");
    expect(card?.tags).toContain("p1");
    expect(card?.title).toBe("renamed");
  });
});
