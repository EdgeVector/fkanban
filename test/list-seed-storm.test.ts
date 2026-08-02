// The membership-seed fallback in `listCardsWithFields` must be PROPORTIONATE.
//
// Why this file exists: the fallback ran
// `for (const c of cards) await upsertBoardCard(node, cfg, c)` — serial, no
// `previous`, no `skipOrphanPurge`, with its try/catch OUTSIDE the loop. That
// gave three separate defects in five lines:
//
//  1. It was entered when the BoardCards read THREW. On the live node the
//     ordinary cause of that is `service_timeout` / "too many concurrent
//     reads" — the node shedding load. So `kanban list` answered backpressure
//     with hundreds more operations.
//  2. Every card paid a whole-partition orphan scan on top of its own probe.
//     Measured on the primary 2026-07-31 (scripts/probe-seed-storm-cost.ts):
//     654ms + 657ms per card over 331 cards = ~7.2 min and ~1000 operations,
//     inside a command the user typed as `list`.
//  3. The catch sat outside the loop, so the first card that failed to write
//     abandoned the seed for every card after it — silently, under exactly the
//     conditions that trigger it.
//
// The governing rule, the same one the body and board scans already follow:
// only a read that SUCCEEDED may establish that something is absent.

import { describe, expect, test } from "bun:test";

import { listCards, boardToFields, cardToFields, emptyStructuredFields, type Board, type Card } from "../src/record.ts";
import { BOARD_CARDS_WRITE_BATCH, boardCardFieldsFromCard, boardCardSk } from "../src/board-cards.ts";
import type { NodeClient, QueryFilter, QueryResponse } from "../src/client.ts";
import type { Config } from "../src/config.ts";

// No `card_list_index` hash → readCardListIndex returns null → the scan
// fallback is reached. `board_cards` present → the rollup counts as superseded,
// which is the live primary's shape.
const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash", board_cards: "boardcardshash" },
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

type Write = { keyHash?: string; rangeKey?: string; schemaHash: string };
type BoardCardsMode = "throw" | "empty";

/**
 * Fake node whose BoardCards read either THROWS ONCE (a transient shed — the
 * node is busy, then recovers) or returns nothing (index genuinely absent).
 *
 * The single throw matters: if it threw for the whole run, the seed's own
 * BoardCards probes would fail too and the "writes nothing" assertion would
 * hold whether or not the guard existed. Modelling a real `service_timeout`
 * — one failed read, then a healthy node — is what makes the test able to see
 * the seed fire.
 */
function fakeNode(
  cards: Card[],
  mode: BoardCardsMode,
  opts: { failWritesFor?: string[]; noBatchVerb?: boolean } = {},
): NodeClient & {
  writes: Write[];
  batchRequests: number[];
  partitionScans: number;
  cardScans: number;
} {
  const writes: Write[] = [];
  const batchRequests: number[] = [];
  const state = { partitionScans: 0, cardScans: 0, boardCardsReads: 0 };
  const stub = () => {
    throw new Error("not implemented in fake node");
  };
  const boardRows = [{ fields: boardToFields(board()), key: { hash: "default", range: null } }];
  const cardRows = cards.map((c) => ({ fields: cardToFields(c), key: { hash: c.slug, range: null } }));

  const write = async (q: { schemaHash: string; keyHash?: string; rangeKey?: string }) => {
    const slug = String(q.rangeKey ?? "").split("#").pop() ?? "";
    if (opts.failWritesFor?.includes(slug)) throw new Error(`write refused for ${slug}`);
    writes.push({ schemaHash: q.schemaHash, keyHash: q.keyHash, rangeKey: q.rangeKey });
  };

  // All-or-nothing, exactly as the node is: `write_mutations_batch_async`
  // rejects the whole batch on any item's failure and never reports WHICH item.
  // Modelling that faithfully is what makes the fallback test below real — a
  // fake that let the good rows through would prove the opposite of the truth.
  const writeBatch = async (
    rows: Array<{ schemaHash: string; keyHash: string; rangeKey?: string | null }>,
  ) => {
    const slugOf = (r: { rangeKey?: string | null }) => String(r.rangeKey ?? "").split("#").pop() ?? "";
    if (rows.some((r) => opts.failWritesFor?.includes(slugOf(r)))) {
      throw new Error("batch refused");
    }
    batchRequests.push(rows.length);
    for (const r of rows) {
      writes.push({ schemaHash: r.schemaHash, keyHash: r.keyHash, rangeKey: r.rangeKey ?? undefined });
    }
  };

  return {
    baseUrl: "http://fake",
    userHash: "test-user",
    get writes() {
      return writes;
    },
    /** Row count per `updateRecords` REQUEST — empty when nothing batched. */
    get batchRequests() {
      return batchRequests;
    },
    get partitionScans() {
      return state.partitionScans;
    },
    get cardScans() {
      return state.cardScans;
    },
    autoIdentity: stub as never,
    bootstrap: stub as never,
    loadSchemas: stub as never,
    listSchemas: stub as never,
    rawCall: stub as never,
    nodeTransport: stub as never,
    createRecord: write as never,
    updateRecord: write as never,
    deleteRecord: write as never,
    // `noBatchVerb` models the ad-hoc fakes and any client predating the batch
    // route: the wrapper must still write every row, just slower.
    ...(opts.noBatchVerb ? {} : { updateRecords: writeBatch as never }),
    async queryAll(q: { schemaHash: string; fields: string[]; filter?: QueryFilter }): Promise<QueryResponse> {
      if (q.schemaHash === "boardcardshash") {
        const prefix = (q.filter as unknown as { HashRangePrefix?: unknown } | undefined)?.HashRangePrefix;
        if (prefix === undefined) {
          // Whole-partition read — the shape `purgeOtherBoardCardRows` uses.
          state.partitionScans += 1;
        }
        state.boardCardsReads += 1;
        if (mode === "throw" && state.boardCardsReads === 1) {
          throw new Error("service_timeout: too many concurrent reads");
        }
        return { ok: true, results: [] };
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
  } as unknown as NodeClient & {
    writes: Write[];
    batchRequests: number[];
    partitionScans: number;
    cardScans: number;
  };
}

const someCards = (n: number): Card[] =>
  Array.from({ length: n }, (_, i) => card({ slug: `card-${i}`, position: String(i + 1) }));

describe("list membership seed — a failed read is not evidence of a missing index", () => {
  test("BoardCards THREW: list still answers, and writes NOTHING", async () => {
    const node = fakeNode(someCards(12), "throw");

    const out = await listCards(node, cfg);

    // The command still has to answer — that is why the scan fallback exists.
    expect(out.map((c) => c.slug)).toContain("card-0");
    expect(node.cardScans).toBe(1);
    // The regression this file exists for: answering backpressure with a
    // hundreds-of-operations rebuild.
    expect(node.writes).toHaveLength(0);
  });

  test("BoardCards genuinely EMPTY: the seed still runs", async () => {
    const node = fakeNode(someCards(12), "empty");

    await listCards(node, cfg);

    // One membership write per card — the seed is the whole point of this path.
    expect(node.writes.length).toBeGreaterThanOrEqual(12);
  });

  test("EMPTY under activeOnly is 'everything is finished', and seeds nothing", async () => {
    // `activeOnly` deliberately excludes the terminal column, so an empty
    // result says nothing whatsoever about dual-write coverage. Reading it as
    // "the index is missing" would make FINISHING THE LAST CARD trigger an
    // admin full scan of Card, an index rewrite and a full BoardCards reseed —
    // on every `pickup status`, for as long as the board stayed drained.
    const node = fakeNode(someCards(12), "empty");

    const out = await listCards(node, cfg, { activeOnly: true });

    expect(out).toEqual([]);
    expect(node.writes).toHaveLength(0);
    expect(node.cardScans).toBe(0);
  });

  test("the seed does not pay a whole-partition orphan scan per card", async () => {
    const node = fakeNode(someCards(25), "empty");

    await listCards(node, cfg);

    // `skipOrphanPurge`: a repair that writes every card's truth cannot learn
    // anything from re-listing the partition once per card. Before the fix this
    // was 25 whole-partition reads; the only ones left are the list's own.
    expect(node.partitionScans).toBeLessThanOrEqual(2);
  });

  test("one card that will not write does not abandon the rest of the seed", async () => {
    const node = fakeNode(someCards(10), "empty", { failWritesFor: ["card-0", "card-1"] });

    await listCards(node, cfg);

    const seeded = new Set(node.writes.map((w) => String(w.rangeKey ?? "").split("#").pop()));
    // The catch used to sit outside the loop: card-0 failing meant cards 1..9
    // were never seeded at all. Now the BATCH carrying card-0 is rejected whole
    // — the node never says which row was at fault — so the same guarantee has
    // to survive a different failure shape: the chunk retries per row.
    expect(seeded.has("card-9")).toBe(true);
    expect(seeded.size).toBeGreaterThanOrEqual(8);
    expect(seeded.has("card-0")).toBe(false);
  });
});

describe("list membership seed — writes go in BATCHES, because the partition is a lock", () => {
  // Every card seeded here lands in one board partition, and the node gates a
  // write per `(molecule, hash)` — `acquire_molecule_write_locks` builds its key
  // from `ChangedKey::disk_hash()`, so the range half of a HashRange key is not
  // in it. Measured on the live primary
  // (`scripts/probe-boardcards-write-lock-contention.ts`, 12 rows, identical
  // payload): serial 1.00x, concurrent-x3-same-partition **0.91x**, one batch
  // 2.10x. The fan-out this replaced was slower than not fanning out at all.
  //
  // These assertions are on the REQUEST COUNT, not the row count, because that
  // is the only thing that distinguishes the two: 12 rows written one at a time
  // and 12 rows in one request produce identical `writes`.

  test("N cards under one chunk are seeded in ONE request, not N", async () => {
    const node = fakeNode(someCards(12), "empty");

    await listCards(node, cfg);

    expect(node.batchRequests).toEqual([12]);
  });

  test("a seed larger than one chunk is split, and every card still lands", async () => {
    const n = BOARD_CARDS_WRITE_BATCH + 7;
    const node = fakeNode(someCards(n), "empty");

    await listCards(node, cfg);

    // Chunked, not one unbounded request: a batch is all-or-nothing and holds
    // the partition gate for its whole duration, so the chunk bounds both the
    // blast radius of a failure and how long other writers queue.
    expect(node.batchRequests).toEqual([BOARD_CARDS_WRITE_BATCH, 7]);
    const seeded = new Set(node.writes.map((w) => String(w.rangeKey ?? "").split("#").pop()));
    expect(seeded.size).toBe(n);
  });

  test("a rejected chunk falls back to per-row, sparing only the bad row", async () => {
    const node = fakeNode(someCards(6), "empty", { failWritesFor: ["card-3"] });

    await listCards(node, cfg);

    // The batch never landed — all-or-nothing — so nothing was recorded as a
    // batch, and the five good rows arrived one at a time.
    expect(node.batchRequests).toEqual([]);
    const seeded = new Set(node.writes.map((w) => String(w.rangeKey ?? "").split("#").pop()));
    expect(seeded.size).toBe(5);
    expect(seeded.has("card-3")).toBe(false);
  });

  test("a client with no batch verb still seeds every card", async () => {
    const node = fakeNode(someCards(9), "empty", { noBatchVerb: true });

    await listCards(node, cfg);

    expect(node.batchRequests).toEqual([]);
    const seeded = new Set(node.writes.map((w) => String(w.rangeKey ?? "").split("#").pop()));
    expect(seeded.size).toBe(9);
  });

  test("a scan's duplicate slug-only row never displaces the real row", async () => {
    // The Card scan returns a second, atom-less row for some slugs (the
    // 2026-07-18..23 ghost era). Seeding from that row would write a membership
    // sk with no column — the repair corrupting the index it exists to rebuild.
    const real = card({ slug: "dupe", column: "doing", position: "7" });
    const ghost = card({ slug: "dupe", column: "", position: "", board: "" });
    const node = fakeNode([real, ghost], "empty");

    await listCards(node, cfg);

    const membership = node.writes.filter((w) => w.schemaHash === "boardcardshash");
    expect(membership).toHaveLength(1);
    expect(membership[0]!.rangeKey).toBe(boardCardSk("doing", "7", "dupe"));
    expect(boardCardFieldsFromCard(real).sk).toBe(membership[0]!.rangeKey);
  });
});
