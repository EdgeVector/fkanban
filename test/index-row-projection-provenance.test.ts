// A projected read may SUPPLY the `all_boards` payload. It may not establish
// that the row is ABSENT.
//
// LastDB returns a row only when EVERY projected field has an atom (stated at
// board-cards.ts:105, measured on the primary 2026-07-23 when one unbackfilled
// field hid 135 BoardCards rows from every wide read). `readIndexRow` used to
// project all three CardListIndex fields while consuming exactly one, so a row
// missing an atom on `updated_at` — the shape a timed-out write leaves behind,
// measured on the primary 2026-07-28 — came back as "no row".
//
// Both consumers then did the wrong thing with that, and neither could tell:
//
//   - `patchBoardListIndex` rebuilt the rollup from an empty base AND lost its
//     CAS witness in the same step (the witness is derived from the read), so
//     one board survived and every other board's cards vanished from `list`;
//   - `groom board-list-heal` — the verb that exists to repair exactly this —
//     reported `index_absent` and declined to write.
//
// The fake node below models the projection rule for the index row, which is
// the only reason these tests can fail.

import { describe, expect, test } from "bun:test";

import { boardListHealResult } from "../src/commands/board_list_heal.ts";
import { patchBoardListIndex, BOARD_LIST_INDEX_KEY } from "../src/card-list-index.ts";
import { listBoards, boardToFields, type Board } from "../src/record.ts";
import { FkanbanError, type NodeClient, type QueryFilter, type QueryResponse } from "../src/client.ts";
import type { Config } from "../src/config.ts";

const CARD = "cardhash";
const BOARD = "boardhash";
const INDEX = "cardlistindexhash";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: CARD, board: BOARD, card_list_index: INDEX },
};

function board(partial: Partial<Board>): Board {
  return {
    slug: "b",
    title: "B",
    body: "",
    columns: ["backlog", "todo", "doing", "done"],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

function summaryOf(b: Board) {
  return {
    slug: b.slug,
    title: b.title,
    body: b.body,
    columns: b.columns,
    created_at: b.created_at,
    updated_at: b.updated_at,
  };
}

type Fake = {
  node: NodeClient;
  indexEntries(): Array<{ slug: string }> | null;
  indexWrites: Array<{ op: string; expected: unknown }>;
};

/**
 * @param missingAtoms CardListIndex fields the all_boards row has NO atom for.
 *   The row is withheld from any query projecting one of them — the measured
 *   LastDB rule. `key` is the filter, never a projected result, so a read of
 *   `["key"]` alone still finds the row: that asymmetry is the whole bug.
 */
function fakeNode(opts: {
  boards: Board[];
  index?: unknown[] | null;
  missingAtoms?: string[];
}): Fake {
  const boardStore = new Map<string, Board>(opts.boards.map((b) => [b.slug, b]));
  const indexStore = new Map<string, string>();
  if (opts.index !== undefined && opts.index !== null) {
    indexStore.set(BOARD_LIST_INDEX_KEY, JSON.stringify(opts.index));
  }
  const missing = new Set(opts.missingAtoms ?? []);
  const indexWrites: Array<{ op: string; expected: unknown }> = [];
  const stub = () => {
    throw new Error("not implemented in fake node");
  };

  const fake: Fake = {
    node: undefined as unknown as NodeClient,
    indexEntries: () => {
      const raw = indexStore.get(BOARD_LIST_INDEX_KEY) ?? null;
      return raw === null ? null : (JSON.parse(raw) as Array<{ slug: string }>);
    },
    indexWrites,
  };

  fake.node = {
    baseUrl: "http://fake",
    userHash: "test-user",
    autoIdentity: stub as never,
    bootstrap: stub as never,
    loadSchemas: stub as never,
    listSchemas: stub as never,
    rawCall: stub as never,
    nodeTransport: stub as never,
    async createRecord({ schemaHash, keyHash, fields, expected }) {
      if (schemaHash === INDEX) {
        indexWrites.push({ op: "create", expected });
        indexStore.set(keyHash, String((fields as Record<string, unknown>).payload_json ?? ""));
        // A complete write restores every atom.
        missing.clear();
      }
      if (schemaHash === BOARD) boardStore.set(keyHash, board(fields as unknown as Partial<Board>));
    },
    async updateRecord({ schemaHash, keyHash, fields, expected }) {
      if (schemaHash === INDEX) {
        indexWrites.push({ op: "update", expected });
        indexStore.set(keyHash, String((fields as Record<string, unknown>).payload_json ?? ""));
        missing.clear();
      }
    },
    async deleteRecord({ schemaHash, keyHash }) {
      if (schemaHash === BOARD) boardStore.delete(keyHash);
    },
    async queryAll(q: { schemaHash: string; fields: string[]; filter?: QueryFilter }): Promise<QueryResponse> {
      if (q.schemaHash === INDEX) {
        const raw = indexStore.get(BOARD_LIST_INDEX_KEY);
        if (raw === undefined) return { ok: true, results: [] };
        if (q.filter && q.filter.HashKey !== BOARD_LIST_INDEX_KEY) return { ok: true, results: [] };
        // THE RULE: withhold the row if any projected field lacks an atom.
        if (q.fields.some((f) => missing.has(f))) return { ok: true, results: [] };
        return {
          ok: true,
          results: [
            {
              fields: { key: BOARD_LIST_INDEX_KEY, payload_json: raw, updated_at: "2026-01-01T00:00:00.000Z" },
              key: { hash: BOARD_LIST_INDEX_KEY, range: null },
            },
          ],
        };
      }
      if (q.schemaHash !== BOARD) return { ok: true, results: [] };
      const rows = [...boardStore.values()].map((b) => ({
        fields: boardToFields(b) as Record<string, unknown>,
        key: { hash: b.slug, range: null },
      }));
      if (q.filter) return { ok: true, results: rows.filter((r) => r.key.hash === q.filter!.HashKey) };
      return { ok: true, results: rows };
    },
  };
  return fake;
}

const DEFAULT = board({ slug: "default", title: "Default board" });
const SCRATCH = board({ slug: "scratch", title: "Scratch" });

describe("readIndexRow projection width", () => {
  test("the read projects only the field it consumes, so a missing sibling atom cannot hide the row", async () => {
    // `updated_at` has no atom. The row must still be readable, because nothing
    // reads `updated_at` off it.
    const fake = fakeNode({
      boards: [DEFAULT, SCRATCH],
      index: [summaryOf(DEFAULT), summaryOf(SCRATCH)],
      missingAtoms: ["updated_at"],
    });
    const boards = await listBoards(fake.node, cfg);
    expect(boards.map((b) => b.slug).sort()).toEqual(["default", "scratch"]);
    // And it did NOT need to re-seed: the row was readable on the first query.
    expect(fake.indexWrites).toHaveLength(0);
  });
});

describe("patchBoardListIndex — absence must be proven, not inferred", () => {
  test("refuses to rebuild the rollup when the row is present but its payload is unreadable", async () => {
    const fake = fakeNode({
      boards: [DEFAULT, SCRATCH],
      index: [summaryOf(DEFAULT), summaryOf(SCRATCH)],
      missingAtoms: ["payload_json"],
    });
    const added = board({ slug: "third", title: "Third" });

    await expect(patchBoardListIndex(fake.node, cfg, summaryOf(added), "upsert")).rejects.toThrow(
      /refusing to rebuild/i,
    );

    // The stored rollup is untouched — both original boards still listed.
    expect(fake.indexEntries()!.map((b) => b.slug).sort()).toEqual(["default", "scratch"]);
    expect(fake.indexWrites).toHaveLength(0);
  });

  test("the refusal is an index_unreadable FkanbanError, not a generic throw", async () => {
    const fake = fakeNode({
      boards: [DEFAULT],
      index: [summaryOf(DEFAULT)],
      missingAtoms: ["payload_json"],
    });
    const err = await patchBoardListIndex(fake.node, cfg, summaryOf(SCRATCH), "upsert").catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(FkanbanError);
    expect((err as FkanbanError).code).toBe("index_unreadable");
  });

  test("a genuinely absent row still seeds normally — the guard must not block cold start", async () => {
    const fake = fakeNode({ boards: [DEFAULT], index: null });
    await patchBoardListIndex(fake.node, cfg, summaryOf(DEFAULT), "upsert");
    expect(fake.indexEntries()!.map((b) => b.slug)).toEqual(["default"]);
  });

  test("a readable rollup still patches, with its CAS witness intact", async () => {
    const fake = fakeNode({ boards: [DEFAULT], index: [summaryOf(DEFAULT)] });
    await patchBoardListIndex(fake.node, cfg, summaryOf(SCRATCH), "upsert");
    expect(fake.indexEntries()!.map((b) => b.slug).sort()).toEqual(["default", "scratch"]);
    // The witness is what makes the concurrent-board-write guard real.
    expect(fake.indexWrites.at(-1)!.expected).toMatchObject({ field: "payload_json" });
  });
});

describe("groom board-list-heal — a broken row is drift, not absence", () => {
  test("repairs a present-but-unreadable rollup instead of reporting index_absent", async () => {
    const fake = fakeNode({
      boards: [DEFAULT, SCRATCH],
      index: [summaryOf(DEFAULT), summaryOf(SCRATCH)],
      missingAtoms: ["payload_json"],
    });
    const { report } = await boardListHealResult({ cfg, node: fake.node, apply: true });

    expect(report.index_absent).toBe(false);
    expect(report.missing).toBe(2);
    expect(report.healed).toBe(2);
    expect(fake.indexEntries()!.map((b) => b.slug).sort()).toEqual(["default", "scratch"]);
  });

  test("a genuinely absent row is still reported absent and left for the list re-seed", async () => {
    const fake = fakeNode({ boards: [DEFAULT], index: null });
    const { report } = await boardListHealResult({ cfg, node: fake.node, apply: true });

    expect(report.index_absent).toBe(true);
    expect(report.healed).toBe(0);
    expect(fake.indexWrites).toHaveLength(0);
  });
});
