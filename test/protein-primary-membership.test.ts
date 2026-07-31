/**
 * Protein-primary membership: hot-path card writes dual-write BoardCards only
 * for payload; MilestoneCards is updated by Mini tip fold. The app only retires
 * obsolete MilestoneCards keys (deletes), never full dual-writes payload on
 * create/update.
 */
import { describe, expect, test } from "bun:test";
import type {
  NodeClient,
  QueryFilter,
  QueryResponse,
  QueryRow,
} from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { emptyStructuredFields, type Card } from "../src/record.ts";

const BOARD_CARDS = "board-cards-hash";
const MILESTONE_CARDS = "milestone-cards-hash";
const CARD = "card-hash";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://127.0.0.1:9",
  userHash: "user",
  schemaServiceUrl: "http://127.0.0.1:9",
  schemaHashes: {
    board: "board-hash",
    card: CARD,
    board_cards: BOARD_CARDS,
    milestone_cards: MILESTONE_CARDS,
  },
};

function card(partial: Partial<Card> = {}): Card {
  return {
    slug: "protein-card",
    title: "Protein primary",
    body: "body",
    board: "default",
    column: "todo",
    position: "1",
    assignee: "",
    tags: [],
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

type Op = {
  op: "create" | "update" | "delete";
  schemaHash: string;
  keyHash: string;
  rangeKey?: string | null;
  fields?: Record<string, unknown>;
};

function recordingNode(): NodeClient & { ops: Op[] } {
  type StoredRecord = { keyHash: string; rangeKey: string | null; fields: Record<string, unknown> };
  const ops: Op[] = [];
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
    throw new Error(`recordingNode.${m} not implemented`);
  };
  return {
    baseUrl: cfg.nodeUrl,
    userHash: cfg.userHash,
    autoIdentity: notImpl("autoIdentity"),
    bootstrap: notImpl("bootstrap"),
    loadSchemas: notImpl("loadSchemas"),
    listSchemas: notImpl("listSchemas"),
    async createRecord({ schemaHash, fields, keyHash, rangeKey }) {
      ops.push({ op: "create", schemaHash, keyHash, rangeKey: rangeKey ?? null, fields: { ...fields } });
      tableFor(schemaHash).set(storeKey(keyHash, rangeKey), {
        keyHash,
        rangeKey: rangeKey ?? null,
        fields: { ...fields },
      });
    },
    async updateRecord({ schemaHash, fields, keyHash, rangeKey }) {
      ops.push({ op: "update", schemaHash, keyHash, rangeKey: rangeKey ?? null, fields: { ...fields } });
      const key = storeKey(keyHash, rangeKey);
      tableFor(schemaHash).set(key, {
        keyHash,
        rangeKey: rangeKey ?? null,
        fields: { ...tableFor(schemaHash).get(key)?.fields, ...fields },
      });
    },
    async deleteRecord({ schemaHash, keyHash, rangeKey }) {
      ops.push({ op: "delete", schemaHash, keyHash, rangeKey: rangeKey ?? null });
      tableFor(schemaHash).delete(storeKey(keyHash, rangeKey));
    },
    async queryAll({ schemaHash, filter }): Promise<QueryResponse> {
      const results = rowsFor(schemaHash, filter);
      return { ok: true, results, returned_count: results.length, total_count: results.length };
    },
    rawCall: (async () => {
      return { status: 404, headers: new Headers(), body: "", json: null };
    }) as unknown as NodeClient["rawCall"],
    nodeTransport: () => ({ transport: "unavailable" as const }),
    ops,
  };
}

describe("protein-primary membership writes", () => {
  test("createCardRecord writes BoardCards payload, not MilestoneCards create/update", async () => {
    const node = recordingNode();
    const { createCardRecord } = await import("../src/record.ts");
    await createCardRecord({ cfg, node }, card());

    const msWrites = node.ops.filter(
      (o) =>
        o.schemaHash === MILESTONE_CARDS && (o.op === "create" || o.op === "update"),
    );
    expect(msWrites).toEqual([]);

    const boardWrites = node.ops.filter(
      (o) => o.schemaHash === BOARD_CARDS && (o.op === "create" || o.op === "update"),
    );
    expect(boardWrites.length).toBeGreaterThan(0);
    const payload = boardWrites[boardWrites.length - 1]!;
    expect(payload.fields?.milestone).toBe("ms-1");
    expect(payload.fields?.board).toBe("default");
    expect(payload.fields?.sk).toMatch(/^todo#/);
    expect(payload.fields?.title).toBe("Protein primary");
  });

  test("update that moves sk retires old MilestoneCards tip without dual-writing payload", async () => {
    const node = recordingNode();
    const { createCardRecord, updateCardRecord } = await import("../src/record.ts");
    const prev = card({ column: "todo", position: "1", milestone: "ms-1" });
    await createCardRecord({ cfg, node }, prev);

    // Seed a prior MilestoneCards row as if Mini had folded it earlier.
    await node.createRecord({
      schemaHash: MILESTONE_CARDS,
      keyHash: "ms-1",
      rangeKey: "todo#00000001#protein-card",
      fields: { milestone: "ms-1", sk: "todo#00000001#protein-card", slug: "protein-card" },
    });
    node.ops.length = 0;

    const next = card({ column: "doing", position: "9", milestone: "ms-1" });
    await updateCardRecord({ cfg, node }, next, undefined, prev);

    const msCreates = node.ops.filter(
      (o) => o.schemaHash === MILESTONE_CARDS && (o.op === "create" || o.op === "update"),
    );
    expect(msCreates).toEqual([]);

    const msDeletes = node.ops.filter((o) => o.schemaHash === MILESTONE_CARDS && o.op === "delete");
    expect(msDeletes.some((d) => d.rangeKey === "todo#00000001#protein-card")).toBe(true);

    const boardWrites = node.ops.filter(
      (o) => o.schemaHash === BOARD_CARDS && (o.op === "create" || o.op === "update"),
    );
    expect(boardWrites.length).toBeGreaterThan(0);
  });

  test("shared membership field descriptions match except layout", async () => {
    const { boardCardsSchema, milestoneCardsSchema } = await import("../src/schemas.ts");
    const board = boardCardsSchema.schema.field_descriptions;
    const ms = milestoneCardsSchema.schema.field_descriptions;
    const shared = Object.keys(board).filter((k) => k !== "layout" && k in ms);
    for (const k of shared) {
      expect(ms[k]).toBe(board[k]);
    }
    expect(board.layout).not.toBe(ms.layout);
    expect(board.layout).toContain("board membership");
    expect(ms.layout).toContain("milestone membership");
  });
});
