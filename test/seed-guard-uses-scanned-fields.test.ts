// The seed guards must be told what the scan READ, not what the caller ASKED FOR.
//
// `listCardsWithFields`' full-scan fall-through seeds two indexes, and both are
// gated on the same contract — "never write a field this scan did not read".
// `seedBoardCards` even names its parameter `scannedFields`. But the scan above
// it can silently narrow itself: `isOnlyOptionalFieldMiss` catches a node that
// rejects an optional field and retries at a reduced projection. Before this
// fix both guards were still handed `fields`, so the contract described a read
// that had not happened.
//
// The gap is reachable because the retry is all-or-nothing across a set that is
// not all-or-nothing on the node. The catch fires when the node names ANY ONE
// of `CARD_OPTIONAL_SCHEMA_FIELDS` (`surfaces`, `db`, `created_by`,
// `milestone`) and the retry then drops ALL FOUR. Three of them are in
// `CARD_SEED_FIELDS`, so a node that is merely missing `surfaces` stops reading
// `created_by` and `milestone` — fields it holds, populated — while
// `scanCoversSeed(fields)` still answers "covered" because the caller asked for
// them. The seed then states a whole membership row and writes `""` over each.
//
// `milestone` is why this is a correctness bug and not bookkeeping: membership
// drives `milestone portfolio`, MilestoneCards parity and the live-PR milestone
// gate, so blanking it is the "board that stops being pickupable after a READ"
// symptom the guard was written to prevent — caused by the guard's own input.

import { describe, expect, test } from "bun:test";

import { FkanbanError, type NodeClient, type QueryFilter, type QueryResponse } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { CARD_LIST_INDEX_KEY, type CardSummary } from "../src/card-list-index.ts";
import {
  boardToFields,
  cardToFields,
  emptyStructuredFields,
  listCards,
  type Board,
  type Card,
} from "../src/record.ts";

/**
 * `board_cards` UNBOUND so the partition read throws and the legacy
 * fall-through runs; `card_list_index` BOUND AND EMPTY so the rollup cannot
 * answer before the scan. This is the only configuration that reaches the seed.
 */
const LEGACY: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash", card_list_index: "cardlistindexhash" },
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

function card(): Card {
  return {
    slug: "milestoned",
    title: "A card that belongs to a milestone",
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
    created_by: "tomtang",
    milestone: "milestone-kanban-works",
    repo: "EdgeVector/fkanban",
    base: "main",
    pr_url: "lastdb:///fkanban/cr/cr-abc123",
    branch: "kanban/keep-my-milestone",
    north_star: "north-star-kanban-works",
    block_status: "",
    block_reason: "",
    updated_at: "2026-08-05T00:00:00.000Z",
  };
}

type Row = { fields: Record<string, unknown>; hash: string; range: string | null };

/**
 * A node that holds `created_by` and `milestone` but has no atom for
 * `surfaces` — the ordinary older-node shape, and the one that makes the retry
 * drop two fields it did NOT need to drop.
 */
function fakeNode(cards: Card[], opts: { rejectSurfaces?: boolean } = {}) {
  const rejectSurfaces = opts.rejectSurfaces ?? true;
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
  rowsOf("cardlistindexhash"); // bound, no row

  /** Every projection the scan actually issued, in order. */
  const projections: string[][] = [];

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
    projections,
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
      if (!tables.has(q.schemaHash)) throw new Error(`unbound schema ${q.schemaHash}`);
      if (q.schemaHash === "cardhash") {
        projections.push([...(q.fields ?? [])]);
        // ONE missing atom, named alone. The node has `created_by` and
        // `milestone` and would have served both.
        if (rejectSurfaces && (q.fields ?? []).includes("surfaces")) {
          throw new FkanbanError({
            code: "unknown_fields",
            message: "unknown fields for schema cardhash: surfaces",
          });
        }
      }
      const all = rowsOf(q.schemaHash);
      const rows = q.filter?.HashKey ? all.filter((r) => r.hash === q.filter!.HashKey) : all;
      const results = rows.map((r) => ({
        fields: project(r.fields, q.fields),
        key: { hash: r.hash, range: r.range },
      }));
      return { ok: true, results, returned_count: results.length, total_count: results.length };
    },
  };
  return node as unknown as NodeClient & {
    rollup(): CardSummary[] | null;
    projections: string[][];
  };
}

describe("the seed guard is evaluated against the scan that ran", () => {
  test("an optional-field retry that drops `milestone` refuses the seed", async () => {
    const node = fakeNode([card()]);

    // `listCards` asks for CARD_LIST_FIELDS, which covers the seed. The RETRY
    // is what narrows it, after the caller has already made a wide request.
    const listed = await listCards(node, LEGACY, { boards: [board()] });

    // The premise: the scan really did retry, and really did stop reading
    // fields this node holds. Without this the assertion below could pass on a
    // node that never narrowed anything.
    expect(node.projections.length).toBe(2);
    expect(node.projections[0]).toContain("milestone");
    expect(node.projections[1]).not.toContain("milestone");
    expect(node.projections[1]).not.toContain("created_by");

    // The guard must decline: the scan cannot state a membership row it did not
    // read. Before the fix `scanCoversSeed(fields)` saw the caller's wide
    // request, wrote the rollup, and blanked `milestone` on it.
    expect(node.rollup()).toBeNull();

    // Declining must not cost the caller its answer — on a legacy node this
    // scan IS the list. A guard that "passes" by breaking `list` is not a fix.
    expect(listed.map((c) => c.slug)).toEqual(["milestoned"]);
  });

  test("no retry: a wide scan that read everything still seeds, milestone intact", async () => {
    // Same card, same caller, but a node that HAS `surfaces` — so nothing
    // narrows and the seed is allowed. This is what stops the fix above from
    // being "never seed again", which would disable index repair on exactly the
    // node type that has no other index.
    const node = fakeNode([card()], { rejectSurfaces: false });

    const listed = await listCards(node, LEGACY, { boards: [board()] });

    expect(node.projections.length).toBe(1); // no retry
    const rollup = node.rollup();
    expect(rollup).not.toBeNull();
    expect(rollup!.map((c) => c.slug)).toEqual(["milestoned"]);
    expect(listed.map((c) => c.slug)).toEqual(["milestoned"]);
  });
});
