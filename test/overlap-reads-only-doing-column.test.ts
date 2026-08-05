// Read budget for `kanban overlap` — the BoardCards PARTITION read, which is
// the expensive one.
//
// Companion to `board-list-read-amplification.test.ts`. That file pins the
// CHEAP read (the `all_boards` rollup: 1 row, ~0-15ms) and proved the contract
// worth pinning. This file pins the read that actually costs: on the live
// `default` partition, `overlap` spent 208ms of its 211ms wall on ONE
// whole-partition BoardCards read — 115 rows, 19 projected fields — and then
// used the rows in `doing`, of which there was 1.
//
// Both consumers of that set always filtered to `doing`
// (`hydrateOverlapPeers`, `overlapAgainstCards`), and `hydrateOverlapPeers`'
// comment has said "only cards in `doing` can be an overlap peer" since it was
// written. The read was the last place that did not believe it.
//
// Measured, live `default` partition, same projection
// (`scripts/probe-column-prefix-selectivity.ts`):
//
//   HashKey (whole partition)   115 rows   214.0ms
//   HashRangePrefix doing#        1 row      8.8ms
//   HashRangePrefix zzzznone#     0 rows     0.5ms   <- the bound is REAL
//
// The zero-row arm is why this is a read narrowing rather than a payload trim:
// cost tracks rows MATCHED, not partition size.
//
// These tests assert the CONTRACT, not the implementation, and both FAIL on the
// pre-fix code — the first because it issued `HashKey`, the second because an
// empty column read fell through to the admin scan.

import { describe, expect, test } from "bun:test";

import { overlapResult } from "../src/commands/overlap.ts";
import type { NodeClient, QueryFilter, QueryResponse } from "../src/client.ts";
import {
  boardToFields,
  cardToFields,
  emptyStructuredFields,
  toBoardSummary,
  type Board,
  type Card,
} from "../src/record.ts";
import { boardCardFieldsFromCard, boardCardSk } from "../src/board-cards.ts";
import type { Config } from "../src/config.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: {
    card: "cardhash",
    board: "boardhash",
    board_cards: "boardcardshash",
    card_list_index: "cardlistindexhash",
  },
};

function board(partial: Partial<Board> = {}): Board {
  return {
    slug: "default",
    title: "Default board",
    body: "",
    columns: ["backlog", "todo", "doing", "done"],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

function card(partial: Partial<Card>): Card {
  return {
    slug: "c",
    title: "C",
    body: "Repo: EdgeVector/fkanban\n\n## GOAL\nfixture\n\n## END STATE\ndone\n",
    board: "default",
    column: "todo",
    position: "1",
    assignee: "",
    tags: [],
    deps: [],
    ...emptyStructuredFields(),
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

type QueryLog = {
  schemaHash: string;
  filter?: QueryFilter;
  fields: string[];
  allowFullScan?: boolean;
};

function fakeNode(
  cards: Card[],
  boards: Board[] = [board()],
): NodeClient & { queries: QueryLog[]; writes: string[] } {
  const queries: QueryLog[] = [];
  const writes: string[] = [];
  const stub = () => {
    throw new Error("not implemented in fake node");
  };
  const boardRows = boards.map((b) => ({ fields: boardToFields(b), key: { hash: b.slug, range: null } }));
  const cardRows = cards.map((c) => ({ fields: cardToFields(c), key: { hash: c.slug, range: null } }));
  const boardCardRows = cards.map((c) => ({
    fields: boardCardFieldsFromCard(c),
    key: { hash: c.board, range: boardCardSk(c.column, c.position, c.slug) },
  }));
  const indexRows: Record<string, { fields: Record<string, unknown>; key: { hash: string; range: null } }> = {
    all_boards: {
      fields: { key: "all_boards", payload_json: JSON.stringify(boards.map(toBoardSummary)) },
      key: { hash: "all_boards", range: null },
    },
  };

  return {
    baseUrl: "http://fake",
    userHash: "test-user",
    queries,
    writes,
    autoIdentity: stub as never,
    bootstrap: stub as never,
    loadSchemas: stub as never,
    listSchemas: stub as never,
    rawCall: stub as never,
    nodeTransport: stub as never,
    createRecord: (async (schemaHash: string) => {
      writes.push(`create:${schemaHash}`);
    }) as never,
    updateRecord: (async (schemaHash: string) => {
      writes.push(`update:${schemaHash}`);
    }) as never,
    deleteRecord: (async (schemaHash: string) => {
      writes.push(`delete:${schemaHash}`);
    }) as never,
    async queryAll(q: {
      schemaHash: string;
      fields: string[];
      filter?: QueryFilter;
      allowFullScan?: boolean;
    }): Promise<QueryResponse> {
      queries.push({
        schemaHash: q.schemaHash,
        filter: q.filter,
        fields: q.fields,
        allowFullScan: q.allowFullScan,
      });
      if (q.schemaHash === "cardlistindexhash") {
        const key = q.filter?.HashKey;
        const row = typeof key === "string" ? indexRows[key] : undefined;
        return { ok: true, results: row ? [row] : [] };
      }
      if (q.schemaHash === "boardcardshash") {
        const prefix = (
          q.filter as unknown as { HashRangePrefix?: { hash?: string; prefix?: string } } | undefined
        )?.HashRangePrefix;
        if (prefix?.hash && prefix.prefix !== undefined) {
          return {
            ok: true,
            results: boardCardRows.filter(
              (r) => r.fields.board === prefix.hash && String(r.fields.sk).startsWith(prefix.prefix!),
            ),
          };
        }
        if (q.filter?.HashKey) {
          return { ok: true, results: boardCardRows.filter((r) => r.fields.board === q.filter!.HashKey) };
        }
        return { ok: true, results: boardCardRows };
      }
      if (q.schemaHash === "cardhash") {
        if (q.filter?.HashKey) {
          return { ok: true, results: cardRows.filter((r) => r.key.hash === q.filter!.HashKey) };
        }
        return { ok: true, results: cardRows };
      }
      if (q.schemaHash === "boardhash") {
        if (q.filter?.HashKey) {
          return { ok: true, results: boardRows.filter((r) => r.key.hash === q.filter!.HashKey) };
        }
        return { ok: true, results: boardRows };
      }
      return { ok: true, results: [] };
    },
  } as unknown as NodeClient & { queries: QueryLog[]; writes: string[] };
}

const boardCardsReads = (node: { queries: QueryLog[] }) =>
  node.queries.filter((q) => q.schemaHash === "boardcardshash");

const prefixOf = (q: QueryLog): string | undefined =>
  (q.filter as unknown as { HashRangePrefix?: { prefix?: string } } | undefined)?.HashRangePrefix?.prefix;

describe("overlap reads only the doing column", () => {
  test("the BoardCards read is column-scoped, never the whole partition", async () => {
    // A board whose `doing` set is a small fraction of the partition — the live
    // shape (1 of 115), scaled down.
    const cards = [
      card({ slug: "candidate", column: "todo", surfaces: ["src/a.ts"] }),
      card({ slug: "peer", column: "doing", position: "1", surfaces: ["src/a.ts"] }),
      card({ slug: "far-1", column: "done", position: "2" }),
      card({ slug: "far-2", column: "backlog", position: "3" }),
      card({ slug: "far-3", column: "todo", position: "4" }),
    ];
    const node = fakeNode(cards);

    await overlapResult({ cfg, node, slug: "candidate" });

    const reads = boardCardsReads(node);
    expect(reads.length).toBeGreaterThan(0);
    // Every BoardCards read overlap issues must name the column it wants.
    // A `HashKey` read here is the pre-fix whole-partition read.
    for (const r of reads) {
      expect(prefixOf(r)).toBe("doing#");
      expect(r.filter).not.toHaveProperty("HashKey");
    }
  });

  test("narrowing the read does not change the verdict", async () => {
    // The point of a read NARROWING is that the answer is identical. A peer in
    // `doing` with a matching surface must still be found, and a card with the
    // same matching surface parked in another column must still be ignored —
    // which is what makes this a narrowing rather than a new filter.
    const cards = [
      card({ slug: "candidate", column: "todo", repo: "EdgeVector/fkanban", surfaces: ["src/a.ts"] }),
      card({
        slug: "peer",
        column: "doing",
        position: "1",
        repo: "EdgeVector/fkanban",
        surfaces: ["src/a.ts"],
      }),
      card({
        slug: "decoy-done",
        column: "done",
        position: "2",
        repo: "EdgeVector/fkanban",
        surfaces: ["src/a.ts"],
      }),
    ];
    const node = fakeNode(cards);

    const result = await overlapResult({ cfg, node, slug: "candidate" });

    expect(result.conflicts.map((c) => c.slug)).toEqual(["peer"]);
    expect(result.candidateUndeclared).toBe(false);
  });

  test("an empty doing column returns clean — it never falls through to the admin scan", async () => {
    // The hazard this guard exists for. An empty `doing` is the ORDINARY state
    // of a quiet board, and the fall-through it would otherwise reach is an
    // admin full scan of Card plus an index rewrite and a BoardCards reseed —
    // a WRITE storm, on the `pickup claim` path, triggered by nothing being in
    // flight. `activeOnly` needed the same guard for the same reason.
    const cards = [
      card({ slug: "candidate", column: "todo", repo: "EdgeVector/fkanban", surfaces: ["src/a.ts"] }),
      card({ slug: "parked", column: "todo", position: "2" }),
      card({ slug: "finished", column: "done", position: "3" }),
    ];
    const node = fakeNode(cards);

    const result = await overlapResult({ cfg, node, slug: "candidate" });

    expect(result.conflicts).toEqual([]);
    expect(node.queries.filter((q) => q.allowFullScan === true)).toEqual([]);
    expect(node.writes).toEqual([]);
  });
});
