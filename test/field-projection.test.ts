import { describe, expect, test } from "bun:test";
import { cardsFromJson } from "./json_page.ts";

import type { NodeClient, QueryFilter, QueryResponse, QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { boardCardFieldsFromCard } from "../src/board-cards.ts";
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
  schemaHashes: { card: "cardhash", board: "boardhash", board_cards: "boardcardshash", card_list_index: "cardlisthash" },
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
  const rows = (schemaHash: string, filter?: QueryFilter): QueryRow[] => {
    if (schemaHash === "cardhash") {
      return cards.map((c) => ({ key: { hash: c.slug, range: null }, fields: cardToFields(c) }));
    }
    if (schemaHash === "boardhash") {
      return boards.map((b) => ({ key: { hash: b.slug, range: null }, fields: boardToFields(b) }));
    }
    if (schemaHash === "boardcardshash") {
      const rangePrefix = (filter as unknown as { HashRangePrefix?: { hash?: string; prefix?: string } } | undefined)
        ?.HashRangePrefix;
      let out = cards.map((c) => {
        const fields = boardCardFieldsFromCard(c);
        return { key: { hash: String(fields.board), range: String(fields.sk) }, fields };
      });
      if (rangePrefix?.hash && rangePrefix.prefix !== undefined) {
        out = out.filter((r) =>
          r.key.hash === rangePrefix.hash &&
          r.key.range !== null &&
          r.key.range.startsWith(rangePrefix.prefix!)
        );
      } else if (filter?.HashKey) {
        out = out.filter((r) => r.key.hash === filter.HashKey);
      }
      return out;
    }
    if (schemaHash === "cardlisthash") {
      const key = filter?.HashKey;
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
    queryAll: async (q: { schemaHash: string; filter?: QueryFilter }): Promise<QueryResponse> => {
      const results = rows(q.schemaHash, q.filter);
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

  // The DEGRADED configuration: no display indexes AND a node that refuses the
  // Card scan outright (this stub throws for any non-point-read Card query,
  // even an unfiltered Card query). Search still has to answer, so the
  // semantic-index candidate path is retained as the fallback for exactly this
  // case — it is the only way to reach a body match here.
  test("search still answers via native candidates when the Card scan is refused", async () => {
    // This test is about the NATIVE candidate path. Left enabled, the LastSeek
    // plane answers first from the host index — which knows nothing about this
    // stub node's `probe` card — so the assertion got [] after ~7s of real
    // subprocess work. LASTSEEK_DISABLE is the plane's own documented switch
    // (checked in both queryLastSeek and the availability probe); using it
    // makes the test hermetic instead of dependent on host index contents.
    //
    // LASTSEEK_DISABLE alone did NOT make it hermetic. `querySearchPlane`
    // falls through from LastSeek to the INCUMBENT plane, which `spawnSync`s
    // the host's `search` binary with a 60s timeout — so the test still paid
    // for a real semantic query over the host index, and blew its own 10s
    // budget on a loaded machine (measured 2026-08-23: 12.5s, failing both
    // with and without the change under test). Point that spawn at a binary
    // that cannot exist: the incumbent returns null immediately, which is the
    // "no search plane installed" answer this test wants anyway.
    const prevDisable = process.env.LASTSEEK_DISABLE;
    const prevSearchBin = process.env.LASTDB_SEARCH_BIN;
    process.env.LASTSEEK_DISABLE = "1";
    process.env.LASTDB_SEARCH_BIN = "fkanban-test-absent-search-binary";
    try {
    const probe = card({ slug: "probe", title: "Probe", body: "needle body", position: "10" });
    const calls: Array<{ schemaHash: string; filter?: unknown }> = [];
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
      queryAll: async (q: { schemaHash: string; filter?: unknown }): Promise<QueryResponse> => {
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

    const out = cardsFromJson(await searchCmd({ cfg: noIndexCfg, node: noScanNode, query: "needle", json: true })) as Array<{ slug: string }>;
    expect(out.map((c) => c.slug)).toEqual(["probe"]);
    // The body match came from the point-read candidate, NOT from a scan: this
    // node refused every scan it was offered. Asserting the result rather than
    // the absence of an attempt — a refused attempt costs one round trip and
    // degrades correctly, whereas never attempting would cost every healthy
    // node the recall that scan buys.
    expect(calls.some((c) => c.schemaHash === "cardhash" && c.filter !== undefined)).toBe(true);
    } finally {
      if (prevDisable === undefined) delete process.env.LASTSEEK_DISABLE;
      else process.env.LASTSEEK_DISABLE = prevDisable;
      if (prevSearchBin === undefined) delete process.env.LASTDB_SEARCH_BIN;
      else process.env.LASTDB_SEARCH_BIN = prevSearchBin;
    }
    // Removing the 60s-timeout `search` spawn took this from 12.5s to 4.2s
    // standalone, but it still does real subprocess work and still measured
    // 11.4s inside the full suite on a loaded host. Say what the work costs
    // rather than leaving the budget at a number it beats only when idle.
  }, 30_000);

  test("projection allowlist is seeded from the card schema fields", () => {
    for (const field of fieldsFor("card")) {
      expect(FIELD_NAMES.has(field)).toBe(true);
      expect(() => renderFieldProjection(cards, [field])).not.toThrow();
    }
  });
});
