import { describe, expect, test } from "bun:test";

import type { NodeClient, QueryResponse, QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { listCmd } from "../src/commands/list.ts";
import { searchCmd } from "../src/commands/search.ts";
import {
  boardToFields,
  cardToFields,
  emptyStructuredFields,
  nowIso,
  type Board,
  type Card,
} from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://stub",
  schemaServiceUrl: "http://stub",
  userHash: "stub",
  schemaHashes: { card: "cardhash", board: "boardhash" },
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
  const rows = (schemaHash: string): QueryRow[] => {
    if (schemaHash === "cardhash") {
      return cards.map((c) => ({ key: { hash: c.slug, range: null }, fields: cardToFields(c) }));
    }
    if (schemaHash === "boardhash") {
      return boards.map((b) => ({ key: { hash: b.slug, range: null }, fields: boardToFields(b) }));
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
    queryAll: async (q: { schemaHash: string }): Promise<QueryResponse> => {
      const results = rows(q.schemaHash);
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
});
