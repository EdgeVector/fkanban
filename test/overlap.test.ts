import { beforeEach, describe, expect, test } from "bun:test";

import type { NodeClient, QueryFilter, QueryResponse, QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { boardToFields, cardToFields, emptyStructuredFields, nowIso, type Card } from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";
import { overlapResult, surfacesMayOverlap } from "../src/commands/overlap.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash" },
};

function card(partial: Partial<Card>): Card {
  return {
    slug: "c",
    title: "C",
    body: "Repo: EdgeVector/fkanban\nBase: main\n",
    board: "default",
    column: "todo",
    position: "1",
    assignee: "",
    tags: [],
    deps: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...emptyStructuredFields(),
    repo: "EdgeVector/fkanban",
    base: "main",
    kind: "pr",
    ...partial,
  };
}

function fakeNode(cards: Card[]): NodeClient {
  const cardRows = new Map(cards.map((c) => [c.slug, cardToFields(c)]));
  const now = nowIso();
  const boardFields = boardToFields({
    slug: "default",
    title: "Default",
    body: "",
    columns: [...DEFAULT_COLUMNS],
    created_at: now,
    updated_at: now,
  });
  const rowsFor = (schemaHash: string, filter?: QueryFilter): QueryRow[] => {
    const fields = schemaHash === cfg.schemaHashes.card ? cardRows : new Map([["default", boardFields]]);
    const entries = filter?.HashKey
      ? (fields.has(filter.HashKey) ? [[filter.HashKey, fields.get(filter.HashKey)!] as const] : [])
      : [...fields.entries()];
    return entries.map(([hash, rowFields]) => ({ fields: rowFields, key: { hash, range: null } }));
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
    createRecord: notImpl("createRecord") as NodeClient["createRecord"],
    updateRecord: notImpl("updateRecord") as NodeClient["updateRecord"],
    deleteRecord: notImpl("deleteRecord") as NodeClient["deleteRecord"],
    async queryAll({ schemaHash, filter }): Promise<QueryResponse> {
      const results = rowsFor(schemaHash, filter);
      return { ok: true, results, returned_count: results.length, total_count: results.length };
    },
    rawCall: notImpl("rawCall") as NodeClient["rawCall"],
    nodeTransport: () => ({ transport: "unavailable" as const }),
  };
}

describe("surface overlap scoring", () => {
  test("matches exact paths, glob prefixes, wildcard prefixes, and bare subsystem names", () => {
    expect(surfacesMayOverlap("src/cli.ts", "src/cli.ts")).toBe(true);
    expect(surfacesMayOverlap("src/mcp/**", "src/mcp/server.ts")).toBe(true);
    expect(surfacesMayOverlap("fold_db_node/src/server/uds_*", "fold_db_node/src/server/uds_client.rs")).toBe(true);
    expect(surfacesMayOverlap("mcp", "src/mcp/server.ts")).toBe(true);
  });

  test("does not match clearly disjoint paths", () => {
    expect(surfacesMayOverlap("docs/**", "src/mcp/server.ts")).toBe(false);
    expect(surfacesMayOverlap("src/cli.ts", "src/mcp/server.ts")).toBe(false);
  });
});

describe("overlapResult", () => {
  let baseCards: Card[];

  beforeEach(() => {
    baseCards = [
      card({ slug: "candidate", column: "todo", surfaces: ["src/mcp/server.ts"] }),
      card({ slug: "peer", title: "Peer", column: "doing", surfaces: ["src/mcp/**"] }),
    ];
  });

  test("reports doing cards in the same repo with intersecting surfaces", async () => {
    const result = await overlapResult({ cfg, node: fakeNode(baseCards), slug: "candidate" });
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.slug).toBe("peer");
    expect(result.conflicts[0]?.matches).toEqual([{ candidate: "src/mcp/server.ts", other: "src/mcp/**" }]);
    expect(result.warnings).toEqual([]);
  });

  test("ignores disjoint surfaces and other repos", async () => {
    const cards = [
      card({ slug: "candidate", column: "todo", surfaces: ["docs/**"] }),
      card({ slug: "peer", column: "doing", surfaces: ["src/mcp/**"] }),
      card({ slug: "other-repo", column: "doing", repo: "EdgeVector/fold", body: "Repo: EdgeVector/fold\nBase: main", surfaces: ["docs/**"] }),
    ];
    const result = await overlapResult({ cfg, node: fakeNode(cards), slug: "candidate" });
    expect(result.conflicts).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("warns and stays non-conflicting when surfaces are missing", async () => {
    const cards = [
      card({ slug: "candidate", column: "todo", surfaces: [] }),
      card({ slug: "peer", column: "doing", surfaces: [] }),
    ];
    const result = await overlapResult({ cfg, node: fakeNode(cards), slug: "candidate" });
    expect(result.conflicts).toEqual([]);
    expect(result.warnings).toContain("candidate candidate has no surfaces; overlap unknown");
  });

  test("uses Surfaces body headers for incremental adoption", async () => {
    const cards = [
      card({
        slug: "candidate",
        column: "todo",
        surfaces: [],
        body: "Repo: EdgeVector/fkanban\nBase: main\nSurfaces: src/mcp/server.ts\n",
      }),
      card({ slug: "peer", column: "doing", surfaces: [], body: "Repo: EdgeVector/fkanban\nBase: main\nSurfaces: src/mcp/**\n" }),
    ];
    const result = await overlapResult({ cfg, node: fakeNode(cards), slug: "candidate" });
    expect(result.conflicts[0]?.slug).toBe("peer");
    expect(result.warnings).toEqual([]);
  });
});
