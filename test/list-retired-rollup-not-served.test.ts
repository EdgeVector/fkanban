// A RETIRED rollup must never be served as truth, empty or not.
//
// Since 2026-07-28 the write path does not maintain `all_cards` at all: both
// `patchCardListIndex` and its seed return early on `cardListIndexIsSuperseded`
// (board_cards bound). So on any node with BoardCards, a NON-EMPTY `all_cards`
// is by definition frozen — every entry in it describes where a card was on the
// day the writes stopped, and nothing has corrected it since.
//
// The read path used to trust it anyway. Its guard was
//
//   !(indexed.length === 0 && cardListIndexIsSuperseded(cfg))
//
// which declines the rollup only when it is superseded AND ALREADY EMPTY — i.e.
// exactly when it has nothing to give. A superseded rollup that still held its
// legacy payload was served in full, as truth, on the one path that reaches it:
// a BoardCards read that THREW.
//
// Measured on the live primary 2026-08-02 before
// `groom card-list-index-retire --apply`: `all_cards` held 721 entries (299 KB),
// of which **714 had no Card record at all** and 7 duplicated BoardCards rows.
// So a single transient `service_timeout` on BoardCards — the node shedding
// under load, which is the documented busy signal, not an outage — made
// `kanban list` answer with 714 deleted cards. Agents read that board.
//
// The fix makes the read path's trust symmetric with the write path's refusal:
// when board_cards is bound, the rollup is not consulted at all and the
// fall-through seeds from Card truth. When board_cards is NOT bound the rollup
// is still the live read model and is served exactly as before — that is the
// legacy-node case, and it is unchanged.

import { describe, expect, test } from "bun:test";

import {
  listCards,
  boardToFields,
  cardToFields,
  emptyStructuredFields,
  type Board,
  type Card,
} from "../src/record.ts";
import type { NodeClient, QueryFilter, QueryResponse } from "../src/client.ts";
import type { Config } from "../src/config.ts";

/** The live primary's shape: BOTH indexes bound, so the rollup is superseded. */
const supersededCfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: {
    card: "cardhash",
    board: "boardhash",
    board_cards: "boardcardshash",
    card_list_index: "indexhash",
  },
};

/** A legacy node that never got BoardCards — the rollup is still the read model. */
const legacyCfg: Config = {
  ...supersededCfg,
  schemaHashes: { card: "cardhash", board: "boardhash", card_list_index: "indexhash" },
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

function card(partial: Partial<Card>): Card {
  return {
    slug: "c",
    title: "C",
    body: "brief",
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

/**
 * Fake node where BoardCards throws once (a transient shed) and `all_cards`
 * still holds `staleSlugs` — cards with NO Card record, i.e. the 714-tombstone
 * shape measured on the primary.
 */
function fakeNode(liveCards: Card[], staleSlugs: string[]) {
  const state = { cardScans: 0, boardCardsReads: 0 };
  const stub = () => {
    throw new Error("not implemented in fake node");
  };
  const boardRows = [{ fields: boardToFields(board()), key: { hash: "default", range: null } }];
  const cardRows = liveCards.map((c) => ({ fields: cardToFields(c), key: { hash: c.slug, range: null } }));
  const rollup = staleSlugs.map((slug) => ({
    ...cardToFields(card({ slug, title: `stale ${slug}` })),
    body: "",
  }));

  return {
    baseUrl: "http://fake",
    userHash: "test-user",
    get cardScans() {
      return state.cardScans;
    },
    autoIdentity: stub as never,
    bootstrap: stub as never,
    loadSchemas: stub as never,
    listSchemas: stub as never,
    rawCall: stub as never,
    nodeTransport: stub as never,
    createRecord: (async () => {}) as never,
    updateRecord: (async () => {}) as never,
    updateRecords: (async () => {}) as never,
    deleteRecord: (async () => {}) as never,
    async queryAll(q: { schemaHash: string; fields: string[]; filter?: QueryFilter }): Promise<QueryResponse> {
      if (q.schemaHash === "boardcardshash") {
        state.boardCardsReads += 1;
        // One transient shed, then healthy — so the seed can still fire and the
        // assertions below are about the ROLLUP, not about a dead node.
        if (state.boardCardsReads === 1) {
          throw new Error("service_timeout: too many concurrent reads");
        }
        return { ok: true, results: [] };
      }
      if (q.schemaHash === "indexhash") {
        const key = (q.filter as unknown as { HashKey?: string } | undefined)?.HashKey ?? null;
        const payload = key === "all_boards" ? [] : rollup;
        return {
          ok: true,
          results: [{ fields: { key, payload_json: JSON.stringify(payload) }, key: { hash: key, range: null } }],
        };
      }
      if (q.schemaHash === "cardhash") {
        if (q.filter?.HashKey) {
          return { ok: true, results: cardRows.filter((r) => r.key.hash === q.filter!.HashKey) };
        }
        state.cardScans += 1;
        return { ok: true, results: cardRows };
      }
      if (q.schemaHash === "boardhash") return { ok: true, results: boardRows };
      return { ok: true, results: [] };
    },
  } as unknown as NodeClient & { cardScans: number };
}

describe("a superseded card_list_index is never the answer", () => {
  test("BoardCards THREW: the frozen rollup's deleted cards are not served", async () => {
    const live = [card({ slug: "live-1" }), card({ slug: "live-2", position: "2" })];
    const node = fakeNode(live, ["deleted-a", "deleted-b", "deleted-c"]);

    const out = await listCards(node, supersededCfg);
    const slugs = out.map((c) => c.slug);

    // The regression this file exists for: a transient shed on BoardCards must
    // not resurrect cards that no longer exist.
    expect(slugs).not.toContain("deleted-a");
    expect(slugs).not.toContain("deleted-b");
    expect(slugs).not.toContain("deleted-c");

    // And `list` still has to ANSWER — from Card truth, which is what the scan
    // fallback is for. Asserting only the absence above would also pass for a
    // change that returned nothing at all.
    expect(slugs).toContain("live-1");
    expect(slugs).toContain("live-2");
    expect(node.cardScans).toBe(1);
  });

  test("a legacy node with no BoardCards still gets the rollup", async () => {
    // The other half of the guard, and the reason this is a narrowing of TRUST
    // rather than a deletion: without board_cards bound the rollup is not
    // superseded, it is the only card index there is, and it must still answer.
    const node = fakeNode([], ["legacy-1", "legacy-2"]);

    const out = await listCards(node, legacyCfg);

    expect(out.map((c) => c.slug).sort()).toEqual(["legacy-1", "legacy-2"]);
    // Served from the rollup, so no full scan of Card was needed.
    expect(node.cardScans).toBe(0);
  });
});
