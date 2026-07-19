import { describe, expect, test } from "bun:test";

import type { NodeClient, QueryResponse, QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { listCmd } from "../src/commands/list.ts";
import { searchCmd } from "../src/commands/search.ts";
import { FIELD_NAMES, renderFieldProjection } from "../src/field_projection.ts";
import {
  boardToFields,
  cardToFields,
  emptyStructuredFields,
  nowIso,
  type Board,
  type Card,
} from "../src/record.ts";
import { DEFAULT_COLUMNS, fieldsFor } from "../src/schemas.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://stub",
  schemaServiceUrl: "http://stub",
  userHash: "stub",
  schemaHashes: { card: "cardhash", board: "boardhash", card_list_index: "cardlisthash" },
};

function card(partial: Partial<Card>): Card {
  const now = nowIso();
  return {
    slug: "card",
    title: "Card",
    body: "",
    board: "default",
    column: "todo",
    position: "10",
    assignee: "",
    tags: [],
    deps: [],
    created_at: now,
    updated_at: now,
    ...emptyStructuredFields(),
    ...partial,
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

function node(cards: Card[], boards: Board[] = [board()]): NodeClient {
  const rows = (schemaHash: string, key?: string): QueryRow[] => {
    if (schemaHash === "cardhash") {
      return cards.map((c) => ({ key: { hash: c.slug, range: null }, fields: cardToFields(c) }));
    }
    if (schemaHash === "boardhash") {
      return boards.map((b) => ({ key: { hash: b.slug, range: null }, fields: boardToFields(b) }));
    }
    if (schemaHash === "cardlisthash") {
      if (key === "all_boards") {
        return [
          {
            key: { hash: "all_boards", range: null },
            fields: {
              key: "all_boards",
              payload_json: JSON.stringify(boards),
              updated_at: "2026-01-01T00:00:00.000Z",
            },
          },
        ];
      }
      if (key !== undefined && key !== "all_cards") return [];
      return [
        {
          key: { hash: "all_cards", range: null },
          fields: {
            key: "all_cards",
            payload_json: JSON.stringify(cards.map((c) => ({ ...c, body: "" }))),
            updated_at: "2026-01-01T00:00:00.000Z",
          },
        },
      ];
    }
    return [];
  };
  return {
    baseUrl: "http://stub",
    userHash: "stub",
    autoIdentity: async () => ({ provisioned: true, userHash: "stub" }),
    bootstrap: async () => ({ userHash: "stub" }),
    loadSchemas: async () => ({ available_schemas_loaded: 0, schemas_loaded_to_db: 0, failed_schemas: [] }),
    listSchemas: async () => [],
    createRecord: async () => {},
    updateRecord: async () => {},
    deleteRecord: async () => {},
    queryAll: async (q: { schemaHash: string; filter?: { HashKey?: string } }): Promise<QueryResponse> => {
      const results = rows(q.schemaHash, q.filter?.HashKey);
      return { ok: true, results, returned_count: results.length, total_count: results.length };
    },
    rawCall: async () => ({ status: 200, body: "" }),
  } as unknown as NodeClient;
}

describe("--field projection", () => {
  const cards = [
    card({
      slug: "alpha",
      title: "Alpha",
      column: "todo",
      position: "10",
      pr_url: "https://github.com/EdgeVector/fkanban/pull/1",
      body: "mentions agent",
    }),
    card({
      slug: "beta",
      title: "Beta",
      column: "doing",
      position: "20",
      pr_url: "",
      body: "mentions agent too",
    }),
  ];

  test("list projects one field as newline-delimited values", async () => {
    const out = await listCmd({ cfg, node: node(cards), column: "todo", fields: ["slug"] });
    expect(out).toBe("alpha");
    expect(out).not.toContain("{");
  });

  test("list projects repeated fields as TSV and supports the public pr alias", async () => {
    const out = await listCmd({ cfg, node: node(cards), fields: ["slug", "pr"] });
    expect(out).toBe("alpha\thttps://github.com/EdgeVector/fkanban/pull/1\nbeta\t");
  });

  test("list projection honors explicit limit caps", async () => {
    const out = await listCmd({ cfg, node: node(cards), fields: ["slug"], limit: 1 });
    expect(out).toBe("alpha\nbeta");
  });

  test("search projects matches as TSV", async () => {
    const out = await searchCmd({ cfg, node: node(cards), query: "Alpha", fields: ["slug", "column"] });
    expect(out).toBe("alpha\ttodo");
    expect(out).not.toContain("match");
  });

  test("default search does not full-scan Card when display indexes are absent", async () => {
    const probe = card({ slug: "probe", title: "Probe", body: "needle body", position: "10" });
    const calls: Array<{ schemaHash: string; filter?: unknown; allowFullScan?: boolean }> = [];
    const noIndexCfg: Config = {
      ...cfg,
      schemaHashes: { card: "cardhash", board: "boardhash" },
    };
    const noScanNode: NodeClient = {
      baseUrl: "http://stub",
      userHash: "stub",
      autoIdentity: async () => ({ provisioned: true, userHash: "stub" }),
      bootstrap: async () => ({ userHash: "stub" }),
      loadSchemas: async () => ({ available_schemas_loaded: 0, schemas_loaded_to_db: 0, failed_schemas: [] }),
      listSchemas: async () => [],
      createRecord: async () => {},
      updateRecord: async () => {},
      deleteRecord: async () => {},
      queryAll: async (q: { schemaHash: string; filter?: unknown; allowFullScan?: boolean }): Promise<QueryResponse> => {
        calls.push(q);
        if (q.schemaHash === "boardhash") {
          return { ok: true, results: [board()].map((b) => ({ key: { hash: b.slug, range: null }, fields: boardToFields(b) })) };
        }
        if (q.schemaHash === "cardhash" && (q.filter as { HashKey?: string } | undefined)?.HashKey === "probe") {
          return { ok: true, results: [{ key: { hash: "probe", range: null }, fields: cardToFields(probe) }] };
        }
        if (q.schemaHash === "cardhash") {
          throw new Error("default search must not full-scan Card");
        }
        return { ok: true, results: [] };
      },
      rawCall: async () => ({
        status: 200,
        headers: new Headers(),
        body: "",
        json: {
          results: [
            {
              schema_name: "cardhash",
              key_value: { hash: "probe" },
            },
          ],
        },
      }),
      nodeTransport: () => ({ transport: "unavailable" }),
    };

    const out = JSON.parse(await searchCmd({ cfg: noIndexCfg, node: noScanNode, query: "needle", json: true })) as Array<{ slug: string }>;
    expect(out.map((c) => c.slug)).toEqual(["probe"]);
    expect(calls.filter((c) => c.schemaHash === "cardhash" && c.filter === undefined && c.allowFullScan === true)).toEqual([]);
  });

  test("projection allowlist is seeded from the card schema fields", () => {
    for (const field of fieldsFor("card")) {
      expect(FIELD_NAMES.has(field)).toBe(true);
      expect(() => renderFieldProjection(cards, [field])).not.toThrow();
    }
  });
});
