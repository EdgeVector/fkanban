// A read narrow enough for its own renderer must not become the whole board's
// membership row.
//
// `body-omitted-projection.test.ts` pinned this class for ONE field: a
// body-free list returns `body: ""`, which is indistinguishable by value from a
// card whose body really is empty, and six call sites wrote that "" back. The
// same shape exists one field over, on the routing fields, and it is not
// guarded by `BODY_OMITTED`:
//
//   `listCardsForDisplay` reads CARD_DISPLAY_FIELDS — no `repo`, `base`,
//   `pr_url`, `branch`, `north_star`, `block_status`, `block_reason`,
//   `updated_at`. When the BoardCards partitions come back EMPTY and no
//   CardListIndex answers (the post-`init` / pre-backfill state the fall-through
//   at `listCardsWithFields` exists for), that read takes one admin full scan of
//   Card AT THE CALLER'S PROJECTION and then SEEDS BoardCards from it.
//
// `cardFromBoardCardFields` builds a complete Card with `""` defaults for every
// unprojected field, so nothing downstream can tell "not read" from "not set" —
// the seeded rows are well-formed and wrong. A card with no `repo`/`base` is
// `malformed-routing` to the pickup gate, so the failure mode is the whole
// board going unpickupable after a plain `kanban list`.
//
// The guard is "never write a field this scan did not read" — the seed declines
// rather than the scan widening, because the narrow reads here were measured and
// are load-bearing (`PICKUP_AREA_PEER_FIELDS`, `CARD_DISPLAY_FIELDS`), and the
// list is served from the scan whether or not the seed runs. Both halves are
// pinned below: the narrow read must not seed, and the wide read still must —
// a guard that simply stopped seeding would pass the first test alone.
//
// The fake here serves projections (a fake that returns every stored field
// cannot fail this test) and persists writes, so the assertion is on the STORED
// BoardCards row — the only place the narrowing is visible.

import { describe, expect, test } from "bun:test";

import type { NodeClient, QueryFilter, QueryResponse } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import {
  boardToFields,
  cardToFields,
  emptyStructuredFields,
  listCards,
  listCardsForDisplay,
  type Board,
  type Card,
} from "../src/record.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  // `board_cards` bound and `card_list_index` absent is the state that reaches
  // the seed: the rollup is superseded, so it is never served or rewritten, and
  // the fall-through has nothing left but the Card scan.
  schemaHashes: { card: "cardhash", board: "boardhash", board_cards: "boardcardshash" },
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
 * Like the fake in `body-omitted-projection.test.ts`, with the one difference
 * this file is about: the BoardCards table starts EMPTY. Cards exist only on
 * the Card schema, which is the pre-backfill state.
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
  rowsOf("boardcardshash"); // exists, empty — bound schema, no rows

  const project = (fields: Record<string, unknown>, requested?: string[]) => {
    if (!requested || requested.length === 0) return { ...fields };
    const out: Record<string, unknown> = {};
    for (const f of requested) if (f in fields) out[f] = fields[f];
    return out;
  };

  const stub = () => {
    throw new Error("not implemented in fake node");
  };

  const write = (schemaHash: string, fields: Record<string, unknown>, hash: string, range: string | null, merge = false) => {
    const t = rowsOf(schemaHash);
    const idx = t.findIndex((r) => r.hash === hash && r.range === range);
    if (idx >= 0) t[idx] = { fields: merge ? { ...t[idx]!.fields, ...fields } : fields, hash, range };
    else t.push({ fields, hash, range });
  };

  const node = {
    baseUrl: "http://fake",
    userHash: "test-user",
    /** Every BoardCards row the run seeded, by slug. */
    seeded(slug: string): Record<string, unknown> | null {
      return rowsOf("boardcardshash").find((r) => r.fields.slug === slug)?.fields ?? null;
    },
    seededCount(): number {
      return rowsOf("boardcardshash").length;
    },
    autoIdentity: stub as never,
    bootstrap: stub as never,
    loadSchemas: stub as never,
    listSchemas: stub as never,
    rawCall: stub as never,
    nodeTransport: stub as never,
    async createRecord({ schemaHash, fields, keyHash, rangeKey }: {
      schemaHash: string; fields: Record<string, unknown>; keyHash: string; rangeKey?: string;
    }) {
      write(schemaHash, fields, keyHash, rangeKey ?? null);
    },
    async updateRecord({ schemaHash, fields, keyHash, rangeKey }: {
      schemaHash: string; fields: Record<string, unknown>; keyHash: string; rangeKey?: string;
    }) {
      write(schemaHash, fields, keyHash, rangeKey ?? null, true);
    },
    async deleteRecord() {},
    async queryAll(q: { schemaHash: string; fields?: string[]; filter?: QueryFilter }): Promise<QueryResponse> {
      const all = rowsOf(q.schemaHash);
      const prefix = (q.filter as unknown as { HashRangePrefix?: { hash?: string; prefix?: string } } | undefined)
        ?.HashRangePrefix;
      let rows = all;
      if (prefix?.hash !== undefined && prefix.prefix !== undefined) {
        rows = all.filter((r) => r.hash === prefix.hash && (r.range ?? "").startsWith(prefix.prefix!));
      } else if (q.filter?.HashKey) {
        rows = all.filter((r) => r.hash === q.filter!.HashKey);
      }
      const results = rows.map((r) => ({
        fields: project(r.fields, q.fields),
        key: { hash: r.hash, range: r.range },
      }));
      return { ok: true, results, returned_count: results.length, total_count: results.length };
    },
  };
  return node as unknown as NodeClient & {
    seeded(slug: string): Record<string, unknown> | null;
    seededCount(): number;
  };
}

describe("the BoardCards seed must not inherit the reader's projection", () => {
  test("a text list that never reads the routing fields does not seed them away", async () => {
    const node = fakeNode([card()]);

    // The text board render — CARD_DISPLAY_FIELDS. It has every right to be
    // this narrow; it renders none of the routing fields. What it must not do
    // is turn that narrowness into membership truth.
    const listed = await listCardsForDisplay(node, cfg, { boards: [board()] });

    expect(node.seededCount()).toBe(0);
    // Declining the seed must not cost the caller its answer — the list is
    // served from the scan either way. Without this the guard could "pass" by
    // breaking `list`.
    expect(listed.map((c) => c.slug)).toEqual(["routed"]);
  });

  test("a list wide enough to state a row seeds it, with the routing truth intact", async () => {
    const node = fakeNode([card({ slug: "a" }), card({ slug: "b", position: "2" })]);

    // CARD_LIST_FIELDS — the product list. This is the read that is allowed to
    // seed, and asserting it still DOES is what stops the guard above from
    // being a silent "never seed again" regression.
    await listCards(node, cfg, { boards: [board()] });

    expect(node.seededCount()).toBe(2);
    for (const slug of ["a", "b"]) {
      const row = node.seeded(slug)!;
      for (const [field, expected] of Object.entries(ROUTED)) {
        expect({ slug, field, value: row[field] }).toEqual({ slug, field, value: expected });
      }
    }
  });
});
