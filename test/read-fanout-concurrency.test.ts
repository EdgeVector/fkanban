// The two hot-path reads that used to be serial for no reason.
//
// `kanban list` and `kanban pickup status` are what the routine fleet runs
// constantly, and on this node what they cost is ROUND TRIPS, not rows —
// measured 2026-08-02 by `probe-pickup-active-vs-whole.ts` (avoiding 83% of the
// rows LOST, 797ms vs 522ms, because it took six queries to do it) and
// `probe-pickup-projection-width.ts` (cost flat in projection width at 169
// rows). `probe-read-fanout-serial-vs-concurrent.ts` then measured the two
// independent read pairs at 1.35x and 1.29x when overlapped, 6/7 and 7/7 reps.
//
// These tests pin the SHAPE, not the timing: a wall-clock assertion would be
// flaky, so each fake holds its reads open until every expected one has
// arrived. A serial implementation can never satisfy that — it deadlocks and
// the test times out — which is exactly the regression signal wanted.

import { describe, expect, test } from "bun:test";

import { listAllBoardCards, boardCardFieldsFromCard, boardCardSk } from "../src/board-cards.ts";
import { listResult } from "../src/commands/list.ts";
import { overlapResult } from "../src/commands/overlap.ts";
import type { NodeClient, QueryFilter, QueryResponse } from "../src/client.ts";
import { boardToFields, emptyStructuredFields, type Board, type Card } from "../src/record.ts";
import type { Config } from "../src/config.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash", board_cards: "boardcardshash" },
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
    body: "",
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
 * A gate that only opens once `expected` readers are waiting at it.
 *
 * This is the whole trick: it turns "were these reads concurrent?" into a
 * question with a deterministic answer instead of a stopwatch. Serial code
 * parks the first reader forever and the test fails on timeout.
 */
function rendezvous(expected: number) {
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return {
    get arrived() {
      return arrived;
    },
    async wait(): Promise<void> {
      arrived += 1;
      if (arrived >= expected) open();
      await gate;
    },
  };
}

const stub = () => {
  throw new Error("not implemented in fake node");
};

function baseNode(queryAll: NodeClient["queryAll"]): NodeClient {
  return {
    baseUrl: "http://fake",
    userHash: "test-user",
    autoIdentity: stub as never,
    bootstrap: stub as never,
    loadSchemas: stub as never,
    listSchemas: stub as never,
    rawCall: stub as never,
    nodeTransport: stub as never,
    createRecord: stub as never,
    updateRecord: stub as never,
    deleteRecord: stub as never,
    queryAll,
  } as unknown as NodeClient;
}

describe("listAllBoardCards reads board partitions concurrently", () => {
  test("all partitions are in flight at once", async () => {
    const boards = [{ slug: "default" }, { slug: "second" }, { slug: "third" }];
    const gate = rendezvous(boards.length);
    const rows = [
      card({ slug: "a", board: "default" }),
      card({ slug: "b", board: "second" }),
      card({ slug: "c", board: "third" }),
    ].map((c) => ({
      fields: boardCardFieldsFromCard(c),
      key: { hash: c.board, range: boardCardSk(c.column, c.position, c.slug) },
    }));

    const node = baseNode(async (q): Promise<QueryResponse> => {
      // Every partition read parks here. Serial code never gets past the first.
      await gate.wait();
      const hash = (q.filter as QueryFilter | undefined)?.HashKey;
      return { ok: true, results: rows.filter((r) => r.fields.board === hash) };
    });

    const out = await listAllBoardCards(node, cfg, boards);
    expect(gate.arrived).toBe(3);
    expect(out?.map((c) => c.slug).sort()).toEqual(["a", "b", "c"]);
  });

  test("cross-board duplicate resolution still walks boards in caller order", async () => {
    // Concurrency must not reorder the dedupe. The SAME slug sits on two boards
    // with the SAME `updated_at`, so `preferFresherBoardCard` ties and keeps the
    // one it saw FIRST — which, with the reads overlapped, has to mean first in
    // the caller's board list and not whichever partition answered first.
    //
    // Asserted in both board orders: a race-order-dependent implementation
    // cannot pass both, and one direction alone would pass by luck.
    const dup = (b: string) => card({ slug: "shared", board: b, title: `on-${b}` });
    const rows = [dup("first"), dup("second")].map((c) => ({
      fields: boardCardFieldsFromCard(c),
      key: { hash: c.board, range: boardCardSk(c.column, c.position, c.slug) },
    }));

    const readIn = async (order: string[]) => {
      const gate = rendezvous(order.length);
      const node = baseNode(async (q): Promise<QueryResponse> => {
        await gate.wait();
        const hash = (q.filter as QueryFilter | undefined)?.HashKey;
        return { ok: true, results: rows.filter((r) => r.fields.board === hash) };
      });
      const out = await listAllBoardCards(node, cfg, order.map((slug) => ({ slug })));
      expect(out).toHaveLength(1);
      return out?.[0]?.board;
    };

    expect(await readIn(["first", "second"])).toBe("first");
    expect(await readIn(["second", "first"])).toBe("second");
  });
});

describe("list overlaps the board lookup with the board-list read", () => {
  test("both reads are in flight at once", async () => {
    const gate = rendezvous(2);
    const b = board();
    const node = baseNode(async (q): Promise<QueryResponse> => {
      if (q.schemaHash === "boardhash") {
        // findBoard(default) and listBoards' rollup seed both land here; the
        // BoardCards partition read must NOT, or the gate count is wrong.
        await gate.wait();
        return { ok: true, results: [{ fields: boardToFields(b), key: { hash: b.slug, range: null } }] };
      }
      if (q.schemaHash === "cardlistindexhash") {
        await gate.wait();
        return { ok: true, results: [] };
      }
      return { ok: true, results: [] };
    });

    // No card_list_index hash configured, so listBoards falls through to its
    // Board scan — still a second, independent read off the Board schema.
    const res = await listResult({ node, cfg, displayOnly: true });
    expect(gate.arrived).toBeGreaterThanOrEqual(2);
    expect(res.board.slug).toBe("default");
  });

  // REGRESSION GUARD, not evidence: this one passes against the pre-change
  // serial code too, because serial code could not get the precedence wrong.
  // It is here to stop a later `Promise.all` "simplification" from silently
  // swapping which error a caller sees. The other three tests in this file were
  // verified RED against the serial implementation (they time out on it).
  test("the BoardCards read is in flight with them, not a second stage after", async () => {
    // The board pair already overlapped with each other, but the BoardCards
    // read was awaited AFTER both settled — so a list paid two serial round
    // trips. Nothing the board resolution returns feeds that read: `boardSlug`,
    // the column and the projection are all known before any read is issued,
    // and the board results are consumed only afterwards by `ensureColumn` and
    // `boardTerminalMap`.
    //
    // Measured live (`probe-list-boardcards-overlap.ts`, 7 interleaved reps,
    // median): bare `list` 552ms serial -> 291ms overlapped, 0.53x, 7/7 reps.
    //
    // Three readers must arrive before the gate opens: findBoard's point read,
    // listBoards' scan, and the BoardCards partition. Serial code only ever
    // gets two of them there — it is still awaiting the pair — so it parks
    // forever and this test times out. That is the regression signal.
    const gate = rendezvous(3);
    const b = board();
    const node = baseNode(async (q): Promise<QueryResponse> => {
      await gate.wait();
      if (q.schemaHash === "boardhash") {
        return { ok: true, results: [{ fields: boardToFields(b), key: { hash: b.slug, range: null } }] };
      }
      return { ok: true, results: [] };
    });

    const res = await listResult({ node, cfg, displayOnly: true });
    expect(gate.arrived).toBeGreaterThanOrEqual(3);
    expect(res.board.slug).toBe("default");
  });

  test("a typo'd --column still errors on the column, though its read already went out", async () => {
    // Issuing the BoardCards read before the board resolves means a bad column
    // now costs one discarded read. What it must NOT change is which error the
    // caller sees: `ensureColumn` still runs against the resolved board's
    // columns, and still wins over anything the early read did.
    const b = board();
    const node = baseNode(async (q): Promise<QueryResponse> => {
      if (q.schemaHash === "boardhash") {
        return { ok: true, results: [{ fields: boardToFields(b), key: { hash: b.slug, range: null } }] };
      }
      // The speculative BoardCards read for a column that does not exist.
      return { ok: true, results: [] };
    });

    await expect(
      listResult({ node, cfg, column: "nosuchcolumn", displayOnly: true }),
    ).rejects.toThrow(/nosuchcolumn/);
  });

  test("a missing --board still reports itself, not whatever the board list did", async () => {
    // With `Promise.all` the FIRST rejection wins, so a flaky rollup read could
    // mask "no such board" on a typo. Both reads fail here; the board error is
    // the one a caller must see, exactly as when the reads were serial.
    const node = baseNode(async (q): Promise<QueryResponse> => {
      if (q.schemaHash === "boardhash") {
        const hash = (q.filter as QueryFilter | undefined)?.HashKey;
        // The point-read (requireBoard) returns nothing → board_not_found.
        if (hash) return { ok: true, results: [] };
        // The unfiltered read is listBoards' scan → make it fail.
        throw new Error("rollup read blew up");
      }
      return { ok: true, results: [] };
    });

    await expect(listResult({ node, cfg, board: "nope", displayOnly: true })).rejects.toThrow(
      /nope/,
    );
  });
});

describe("overlap reads the candidate and the board list in one wave", () => {
  test("both reads are in flight at once", async () => {
    // `overlap` is what `pickup claim` runs on every candidate it considers,
    // and it awaited the candidate point-read before it even started the board
    // list — two ~190ms round trips for two reads that share no input. The
    // candidate is NOT taken from the list (it may sit in a column the list
    // drops), so nothing sequenced them.
    //
    // Two readers must arrive: the Card point read and listBoards' scan. (The
    // BoardCards partition genuinely waits on the board set, so it is a second
    // wave inside `listCards` and not part of this gate.) Serial code parks the
    // candidate read forever and never issues the second.
    const gate = rendezvous(2);
    const b = board();
    const node = baseNode(async (q): Promise<QueryResponse> => {
      await gate.wait();
      if (q.schemaHash === "boardhash") {
        return { ok: true, results: [{ fields: boardToFields(b), key: { hash: b.slug, range: null } }] };
      }
      if (q.schemaHash === "cardhash") {
        const c = card({ slug: "candidate", repo: "EdgeVector/fkanban", surfaces: ["src/a.ts"] });
        return { ok: true, results: [{ fields: { ...c, tags: c.tags, deps: c.deps }, key: { hash: c.slug, range: null } }] };
      }
      return { ok: true, results: [] };
    });

    const res = await overlapResult({ node, cfg, slug: "candidate" });
    expect(gate.arrived).toBeGreaterThanOrEqual(2);
    expect(res.slug).toBe("candidate");
  });

  test("a missing card still reports itself, not whatever the board list did", async () => {
    // The precedence guard for the overlap above: with `Promise.all` the first
    // rejection wins, so a flaky board read could mask "no such card" on a
    // typo'd slug. `allSettled` keeps the candidate's error first.
    const node = baseNode(async (q): Promise<QueryResponse> => {
      if (q.schemaHash === "cardhash") return { ok: true, results: [] };
      if (q.schemaHash === "boardhash") throw new Error("rollup read blew up");
      return { ok: true, results: [] };
    });

    await expect(overlapResult({ node, cfg, slug: "nosuchcard" })).rejects.toThrow(/nosuchcard/);
  });
});
