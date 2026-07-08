import { beforeEach, describe, expect, test } from "bun:test";

import type { Config } from "../src/config.ts";
import type { NodeClient, QueryFilter, QueryResponse, QueryRow } from "../src/client.ts";
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
import { pickupStatusResult } from "../src/commands/pickup_status.ts";
import { groomStaleBlockersResult } from "../src/commands/groom.ts";
import { HUMAN_BOARD_COLUMNS, PICKUP_CATEGORIES } from "../src/pickup.ts";

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
    let table = store.get(schemaHash);
    if (!table) {
      table = new Map();
      store.set(schemaHash, table);
    }
    return table;
  };
  const rowsFor = (schemaHash: string, filter?: QueryFilter, wantedFields?: string[]): QueryRow[] => {
    const table = tableFor(schemaHash);
    const entries = filter?.HashKey
      ? (table.has(filter.HashKey) ? [[filter.HashKey, table.get(filter.HashKey)!] as const] : [])
      : [...table.entries()].filter(([, fields]) =>
          !filter || Object.entries(filter).every(([field, value]) => fields[field] === value)
        );
    return entries.map(([hash, fields]) => ({
      fields: wantedFields
        ? Object.fromEntries(wantedFields.filter((field) => field in fields).map((field) => [field, fields[field]]))
        : fields,
      key: { hash, range: null },
    }));
  };
  const notImpl = (method: string) => async (): Promise<never> => {
    throw new Error(`fakeNode.${method} not implemented`);
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
    async queryAll({ schemaHash, fields, filter }): Promise<QueryResponse> {
      const results = rowsFor(schemaHash, filter, fields);
      return { ok: true, results, returned_count: results.length, total_count: results.length };
    },
    rawCall: notImpl("rawCall") as NodeClient["rawCall"],
    nodeTransport: () => ({ transport: "unavailable" as const }),
  };
}

function board(partial: Partial<Board>): Board {
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
    body: "",
    board: "default",
    column: "todo",
    position: String(Date.now()),
    assignee: "",
    tags: [],
    deps: [],
    created_at: now,
    updated_at: now,
    ...emptyStructuredFields(),
    kind: "pr",
    block_status: "none",
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

describe("pickup-status", () => {
  let node: NodeClient;

  beforeEach(async () => {
    node = fakeNode();
    await seedBoard(node, board({ slug: "default", columns: [...DEFAULT_COLUMNS] }));
    await seedBoard(node, board({ slug: "human", title: "Human", columns: [...HUMAN_BOARD_COLUMNS] }));
  });

  test("classifies ready, dependency-blocked, human-gated, malformed, parked, and collision cards", async () => {
    await seedCard(node, card({ slug: "ready", repo: "EdgeVector/fkanban", base: "main" }));
    await seedCard(node, card({ slug: "dep", repo: "EdgeVector/fkanban", base: "main", column: "doing" }));
    await seedCard(node, card({ slug: "blocked", repo: "EdgeVector/fkanban", base: "main", deps: ["dep"] }));
    await seedCard(node, card({ slug: "human", board: "human", repo: "EdgeVector/fkanban", base: "main", block_status: "needs_human" }));
    await seedCard(node, card({ slug: "malformed", repo: "", base: "main", body: "No routing header" }));
    await seedCard(node, card({ slug: "tracker", kind: "tracker", repo: "EdgeVector/fkanban", base: "main" }));
    await seedCard(node, card({ slug: "inflight", repo: "EdgeVector/fkanban", base: "main", column: "doing", branch: "fkanban/inflight" }));

    const { report } = await pickupStatusResult({ cfg, node });
    const bySlug = new Map(report.cards.map((c) => [c.slug, c]));

    expect(bySlug.get("ready")?.category).toBe("pickup-ready");
    expect(bySlug.get("blocked")?.category).toBe("blocked-on-dependency");
    expect(bySlug.get("human")?.category).toBe("human-gated");
    expect(bySlug.get("malformed")?.category).toBe("malformed-routing");
    expect(bySlug.get("tracker")?.category).toBe("parked/non-work");
    expect(bySlug.get("inflight")?.category).toBe("collision");
    for (const category of PICKUP_CATEGORIES) {
      expect(report.counts[category]).toBeGreaterThanOrEqual(0);
    }
  });

  test("reports stale generated blocker metadata separately from real human gates", async () => {
    await seedCard(node, card({
      slug: "stale",
      repo: "EdgeVector/fkanban",
      base: "main",
      body: "Repo: EdgeVector/fkanban\nBase: main\n\nBLOCKED: fkanban-pickup cannot resolve Repo header.",
    }));
    await seedCard(node, card({
      slug: "real-human",
      repo: "EdgeVector/fkanban",
      base: "main",
      block_status: "needs_human",
      block_reason: "waiting on Tom",
    }));

    const { report } = await pickupStatusResult({ cfg, node });
    const bySlug = new Map(report.cards.map((c) => [c.slug, c.category]));
    expect(bySlug.get("stale")).toBe("stale-metadata");
    expect(bySlug.get("real-human")).toBe("human-gated");
  });
});

describe("groom stale-blockers", () => {
  let node: NodeClient;

  beforeEach(async () => {
    node = fakeNode();
    await seedBoard(node, board({ slug: "default", columns: [...DEFAULT_COLUMNS] }));
  });

  test("dry-run reports applyable generated cleanup without writing", async () => {
    await seedCard(node, card({
      slug: "routing-fixed",
      body:
        "Repo: EdgeVector/fkanban  # stale inline note\nBase: main\n\n" +
        "BLOCKED: fkanban-pickup cannot resolve Repo header.\nKeep this context.",
    }));

    const { report } = await groomStaleBlockersResult({ cfg, node });
    expect(report.dryRun).toBe(true);
    expect(report.changed).toBe(1);
    expect(report.cards[0]?.issues.map((i) => i.kind)).toContain("malformed-repo-header");
    expect(report.cards[0]?.issues.map((i) => i.kind)).toContain("stale-blocked-prose");

    const after = await findCard(node, cfg, "routing-fixed");
    expect(after?.body).toContain("# stale inline note");
    expect(after?.body).toContain("BLOCKED:");
  });

  test("apply rewrites only generated blocker artifacts", async () => {
    await seedCard(node, card({
      slug: "routing-fixed",
      body:
        "Repo: EdgeVector/fkanban  # stale inline note\nBase: main\n\n" +
        "BLOCKED: fkanban-pickup cannot resolve Repo header.\nKeep this context.",
    }));
    await seedCard(node, card({
      slug: "overlap-stale",
      repo: "EdgeVector/fkanban",
      base: "main",
      block_status: "needs_human",
      block_reason: "Pickup area overlap: shares area:fkanban-list with old-peer in doing; serialize or retag one card.",
    }));
    await seedCard(node, card({
      slug: "real-human",
      repo: "EdgeVector/fkanban",
      base: "main",
      block_status: "needs_human",
      block_reason: "waiting on Tom",
    }));

    const { report } = await groomStaleBlockersResult({ cfg, node, apply: true });
    expect(report.dryRun).toBe(false);
    expect(report.changed).toBe(2);

    const routing = await findCard(node, cfg, "routing-fixed");
    expect(routing?.body).toContain("Repo: EdgeVector/fkanban\n");
    expect(routing?.body).not.toContain("BLOCKED:");
    expect(routing?.body).toContain("Keep this context.");

    const overlap = await findCard(node, cfg, "overlap-stale");
    expect(overlap?.block_status).toBe("none");
    expect(overlap?.block_reason).toBe("");
    const overlapReport = report.cards.find((c) => c.slug === "overlap-stale");
    expect(overlapReport?.issues.map((i) => i.kind)).not.toContain("block-status-mismatch");

    const human = await findCard(node, cfg, "real-human");
    expect(human?.block_status).toBe("needs_human");
    expect(human?.block_reason).toBe("waiting on Tom");
    const humanReport = report.cards.find((c) => c.slug === "real-human");
    expect(humanReport?.changed).toBe(false);
    expect(humanReport?.issues.map((i) => i.kind)).toContain("human-parking-candidate");
  });
});
