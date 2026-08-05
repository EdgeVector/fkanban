// The second index seeded by the same scan, guarded by the same contract.
//
// `seed-writes-only-what-the-list-projected.test.ts` pins the BoardCards half:
// `listCardsWithFields`' full-scan fall-through runs at the CALLER's projection,
// and a caller narrow enough for its own renderer must not turn that narrowness
// into membership truth. The fall-through issues TWO writes from that one scan,
// and only the second was guarded — `writeCardListIndex(node, cfg,
// cards.map(toCardSummary))` sits one line above `seedBoardCards` and inherited
// the identical defect.
//
// The mechanism is not merely similar, it is the same: `CardSummary` carries
// `repo`, `base`, `pr_url`, `branch`, `north_star`, `block_status`,
// `block_reason` and `updated_at`, and `toCardSummary` is a spread of whatever
// `rowToCard` built — which is `""` for every field the projection omitted.
// Nothing downstream can tell "not read" from "not set".
//
// The blast radius is the part that differs, and it is worse. A blanked
// BoardCards row is audited (`groom parity-check`) and repaired
// (`board-cards-heal`). A blanked `all_cards` rollup is SERVED: on a legacy node
// the read path returns any non-null payload before it reaches the scan, so one
// narrow list poisons every later list until something clears the row, and
// nothing audits it.
//
// Reaching this needs the configuration below and no other: `board_cards`
// UNBOUND (so the partition read throws and the fall-through runs) and the
// `all_cards` row ABSENT (so the rollup cannot answer first). Both halves are
// pinned, because a guard that simply stopped writing would pass the narrow test
// alone — and stopping the seed outright is a real regression on the one node
// type that still depends on this index.

import { describe, expect, test } from "bun:test";

import type { NodeClient, QueryFilter, QueryResponse } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { CARD_LIST_INDEX_KEY, type CardSummary } from "../src/card-list-index.ts";
import {
  boardToFields,
  cardToFields,
  emptyStructuredFields,
  listCards,
  listCardsForDisplay,
  type Board,
  type Card,
} from "../src/record.ts";

/**
 * A legacy node: `board_cards` UNBOUND, `card_list_index` bound. With
 * `board_cards` bound `writeCardListIndex` returns early on
 * `cardListIndexIsSuperseded` and this file could not fail whatever the guard
 * did — the configuration IS the test's reach.
 */
const LEGACY: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash", card_list_index: "cardlistindexhash" },
};

const ROUTED = {
  repo: "EdgeVector/fkanban",
  base: "release-2026",
  pr_url: "lastdb:///fkanban/cr/cr-abc123",
  branch: "kanban/keep-my-routing",
  north_star: "north-star-kanban-works",
  block_status: "needs_human",
  block_reason: "waiting on a venue decision",
  updated_at: "2026-08-05T00:00:00.000Z",
};

function board(): Board {
  return {
    slug: "default",
    title: "Default board",
    body: "",
    columns: ["backlog", "todo", "doing", "done"],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function card(partial: Partial<Card> = {}): Card {
  return {
    slug: "routed",
    title: "A card that knows where it ships",
    body: "## GOAL\nShip it.\n",
    board: "default",
    column: "todo",
    position: "1",
    assignee: "agent",
    tags: [],
    deps: [],
    ...emptyStructuredFields(),
    kind: "pr",
    created_at: "2026-01-01T00:00:00.000Z",
    ...ROUTED,
    ...partial,
  };
}

type Row = { fields: Record<string, unknown>; hash: string; range: string | null };

/**
 * Cards live only on the Card schema. `card_list_index` is BOUND AND EMPTY —
 * the state that matters and the one a fake most easily gets wrong: "the schema
 * exists and holds no row" sends the read down the fall-through, while "the
 * schema is unbound" would make `readCardListIndex` throw and never reach it.
 *
 * The fake serves PROJECTIONS (one that returned every stored field could not
 * fail this test) and persists writes, so the assertion is on the stored rollup
 * payload — the only place the narrowing is visible.
 */
function fakeNode(cards: Card[]) {
  const tables = new Map<string, Row[]>();
  const rowsOf = (schemaHash: string): Row[] => {
    let t = tables.get(schemaHash);
    if (!t) {
      t = [];
      tables.set(schemaHash, t);
    }
    return t;
  };

  rowsOf("boardhash").push({ fields: boardToFields(board()), hash: "default", range: null });
  for (const c of cards) {
    rowsOf("cardhash").push({ fields: cardToFields(c), hash: c.slug, range: null });
  }
  rowsOf("cardlistindexhash"); // bound, no row — `all_cards` has never been written

  const project = (fields: Record<string, unknown>, requested?: string[]) => {
    if (!requested || requested.length === 0) return { ...fields };
    const out: Record<string, unknown> = {};
    for (const f of requested) if (f in fields) out[f] = fields[f];
    return out;
  };

  const stub = () => {
    throw new Error("not implemented in fake node");
  };

  const write = (schemaHash: string, fields: Record<string, unknown>, hash: string) => {
    const t = rowsOf(schemaHash);
    const idx = t.findIndex((r) => r.hash === hash);
    if (idx >= 0) t[idx] = { fields: { ...t[idx]!.fields, ...fields }, hash, range: null };
    else t.push({ fields, hash, range: null });
  };

  const node = {
    baseUrl: "http://fake",
    userHash: "test-user",
    /** The stored `all_cards` entries, or null when the row was never written. */
    rollup(): CardSummary[] | null {
      const row = rowsOf("cardlistindexhash").find((r) => r.hash === CARD_LIST_INDEX_KEY);
      if (!row) return null;
      return JSON.parse(String(row.fields.payload_json)) as CardSummary[];
    },
    autoIdentity: stub as never,
    bootstrap: stub as never,
    loadSchemas: stub as never,
    listSchemas: stub as never,
    rawCall: stub as never,
    nodeTransport: stub as never,
    async createRecord({ schemaHash, fields, keyHash }: {
      schemaHash: string; fields: Record<string, unknown>; keyHash: string;
    }) {
      write(schemaHash, fields, keyHash);
    },
    async updateRecord({ schemaHash, fields, keyHash }: {
      schemaHash: string; fields: Record<string, unknown>; keyHash: string;
    }) {
      write(schemaHash, fields, keyHash);
    },
    async deleteRecord() {},
    async queryAll(q: { schemaHash: string; fields?: string[]; filter?: QueryFilter }): Promise<QueryResponse> {
      // An UNBOUND schema is not an empty table — the node rejects the query,
      // and that rejection is what sets `boardCardsThrew` and drives the
      // legacy fall-through this file tests.
      if (!tables.has(q.schemaHash)) throw new Error(`unbound schema ${q.schemaHash}`);
      const all = rowsOf(q.schemaHash);
      const rows = q.filter?.HashKey ? all.filter((r) => r.hash === q.filter!.HashKey) : all;
      const results = rows.map((r) => ({
        fields: project(r.fields, q.fields),
        key: { hash: r.hash, range: r.range },
      }));
      return { ok: true, results, returned_count: results.length, total_count: results.length };
    },
  };
  return node as unknown as NodeClient & { rollup(): CardSummary[] | null };
}

describe("the CardListIndex seed must not inherit the reader's projection", () => {
  test("a text list that never reads the routing fields does not write a blanked rollup", async () => {
    const node = fakeNode([card()]);

    // CARD_DISPLAY_FIELDS — no repo/base/pr_url/branch/north_star/block_*/
    // updated_at. Legitimately narrow: it renders none of them.
    const listed = await listCardsForDisplay(node, LEGACY, { boards: [board()] });

    expect(node.rollup()).toBeNull();
    // Declining must not cost the caller its answer — the list is served from
    // the scan either way. Without this the guard could "pass" by breaking
    // `list` on exactly the node type that has no other index.
    expect(listed.map((c) => c.slug)).toEqual(["routed"]);
  });

  test("a list wide enough to state a summary still writes it, routing intact", async () => {
    const node = fakeNode([card({ slug: "a" }), card({ slug: "b", position: "2" })]);

    // CARD_LIST_FIELDS — the product list, and the read that is allowed to
    // seed. Asserting it still DOES is what stops the guard above from being a
    // silent "never seed again" regression.
    await listCards(node, LEGACY, { boards: [board()] });

    const rollup = node.rollup();
    expect(rollup?.map((c) => c.slug).sort()).toEqual(["a", "b"]);
    for (const entry of rollup!) {
      for (const [field, expected] of Object.entries(ROUTED)) {
        expect({ slug: entry.slug, field, value: entry[field] }).toEqual({
          slug: entry.slug,
          field,
          value: expected,
        });
      }
    }
  });
});
