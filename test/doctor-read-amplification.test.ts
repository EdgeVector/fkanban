// Read-amplification budget for `kanban doctor` — the third member of the
// family alongside `list-read-amplification.test.ts` (card list) and
// `board-list-read-amplification.test.ts` (board list).
//
// Why this file exists: doctor is the DESIGNATED FIRST MOVE when anything looks
// wrong — the fkanban MCP server instructions say "Discovery: if anything seems
// misconfigured, start with fkanban_doctor." It was measured at 35s on the live
// board (313 + 44 cards, 2 boards), which is long enough that agents skip it, or
// run it and then blame it for the slowness it was called to diagnose. On
// 2026-07-31 a chief-engineer run watched it blow a 120s timeout under
// contention and came within one measurement of filing the node as wedged.
//
// The cost was whole-board work repeated across independent checks: the
// "card multi-field smoke" check read the ENTIRE board just to pick one card
// slug to point-read, and the projection-parity check re-fetched the board list
// that the reachability check had already fetched.
//
// These tests assert the CONTRACT, not the implementation: one `doctor` run
// reads the card list at most once and the board list at most once. A read
// COUNT is the only thing that catches this class of bug — every duplicate read
// succeeds and returns the same answer, so nothing goes red when it regresses.
//
// Counting happens at the SOCKET, not against a hand-rolled fake object: the
// fixture is a real HTTP-over-unix-socket node, so what these tests count is
// genuine node round trips. That also makes the numbers meaningful on a loaded
// machine, where wall-clock timings are not.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { doctor } from "../src/commands/doctor.ts";
import { BOARD_CARDS_FIELDS, fieldsFor } from "../src/schemas.ts";
import { BOARD_LIST_INDEX_KEY, CARD_LIST_INDEX_KEY } from "../src/card-list-index.ts";

const CARD_HASH = "ampcardhash";
const BOARD_HASH = "ampboardhash";
const MILESTONE_HASH = "ampmilestonehash";
const BOARD_CARDS_HASH = "ampboardcardshash";
const CARD_LIST_INDEX_HASH = "ampcardlistindexhash";

type QueryLog = { schema: string; hashKey: string | null };

/**
 * A node fixture that serves over a Unix socket and LOGS every query.
 *
 * Bound in the production shape — `board_cards` AND `card_list_index` declared —
 * so `listBoards` takes the keyed `all_boards` rollup read rather than the
 * cold-seed full scan, and `listCards` takes the BoardCards partition path.
 * A fixture missing those indexes would exercise fallback paths that no real
 * install uses, and would count reads that never happen in production.
 */
function makeCountingNode(opts: { boards: string[]; cardsPerBoard: number }) {
  const queries: QueryLog[] = [];
  const store = new Map<string, Record<string, unknown>>();
  const dir = mkdtempSync(join(tmpdir(), "fkanban-amp-node-"));
  const socketPath = join(dir, "folddb.sock");

  const boardSummaries = opts.boards.map((slug) => ({
    slug,
    title: `${slug} board`,
    body: "",
    columns: ["backlog", "todo", "doing", "done"],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  }));

  // Rollup rows: `all_boards` (board list) and the card-list index row.
  store.set(`${CARD_LIST_INDEX_HASH}::${BOARD_LIST_INDEX_KEY}`, {
    key: BOARD_LIST_INDEX_KEY,
    payload_json: JSON.stringify(boardSummaries),
    updated_at: "2026-01-01T00:00:00.000Z",
  });
  store.set(`${CARD_LIST_INDEX_HASH}::${CARD_LIST_INDEX_KEY}`, {
    key: CARD_LIST_INDEX_KEY,
    payload_json: JSON.stringify([]),
    updated_at: "2026-01-01T00:00:00.000Z",
  });

  // BoardCards rows, partitioned by board — the shape `listCards` reads.
  const boardCardRows: Array<{ board: string; fields: Record<string, unknown> }> = [];
  for (const b of opts.boards) {
    for (let i = 0; i < opts.cardsPerBoard; i += 1) {
      const slug = `${b}-card-${i}`;
      boardCardRows.push({
        board: b,
        fields: {
          board: b,
          sk: `todo#0000${i}#${slug}`,
          slug,
          title: `card ${i}`,
          column: "todo",
          position: String(i),
          assignee: "",
          tags: [],
          deps: [],
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      });
      // Card truth, so the multi-field smoke check's point-read resolves.
      store.set(`${CARD_HASH}::${slug}`, {
        slug,
        title: `card ${i}`,
        body: "",
        board: b,
        column: "todo",
        position: String(i),
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      });
    }
  }
  for (const b of boardSummaries) {
    store.set(`${BOARD_HASH}::${b.slug}`, { ...b, columns: b.columns });
  }

  const server = Bun.serve({
    unix: socketPath,
    async fetch(req) {
      const url = new URL(req.url);
      let body: Record<string, unknown> | undefined;
      if (req.method === "POST") {
        const text = await req.text();
        body = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
      }
      if (url.pathname === "/api/system/auto-identity") return Response.json({ user_hash: "u" });
      if (url.pathname === "/api/schemas") {
        return Response.json({
          schemas: [
            { name: CARD_HASH, descriptive_name: "Card", owner_app_id: "fkanban", fields: fieldsFor("card") },
            { name: BOARD_HASH, descriptive_name: "Board", owner_app_id: "fkanban", fields: fieldsFor("board") },
            { name: MILESTONE_HASH, descriptive_name: "Milestone", owner_app_id: "fkanban", fields: fieldsFor("milestone") },
          ],
        });
      }
      if (url.pathname === "/api/mutation") {
        const schema = body!.schema as string;
        const fields = (body!.fields_and_values ?? {}) as Record<string, unknown>;
        const keyHash = (body!.key_value as { hash: string }).hash;
        const mtype = body!.mutation_type as string;
        if (mtype === "delete") store.delete(`${schema}::${keyHash}`);
        else store.set(`${schema}::${keyHash}`, fields);
        return Response.json({ ok: true, success: true });
      }
      if (url.pathname === "/api/query") {
        const schema = body!.schema_name as string;
        const filter = body!.filter as
          | { HashKey?: string; HashRange?: { hash?: string } }
          | undefined;
        const hashKey = filter?.HashKey ?? filter?.HashRange?.hash ?? null;
        queries.push({ schema, hashKey });

        if (schema === BOARD_CARDS_HASH) {
          const rows = boardCardRows
            .filter((r) => hashKey === null || r.board === hashKey)
            .map((r) => ({ fields: r.fields, key: { hash: r.board, range: String(r.fields.sk) } }));
          return Response.json({ ok: true, results: rows, has_more: false });
        }
        const rows = [...store.entries()]
          .filter(([key]) => key.startsWith(`${schema}::`))
          .map(([key, f]) => ({ fields: f, key: { hash: key.split("::")[1]!, range: null } }))
          .filter((r) => hashKey === null || r.key.hash === hashKey);
        return Response.json({ ok: true, results: rows, has_more: false });
      }
      return Response.json({ error: "unexpected", path: url.pathname }, { status: 500 });
    },
  });

  return {
    socketPath,
    queries,
    stop: () => {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const tmp = mkdtempSync(join(tmpdir(), "fkanban-doctor-amp-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function closedTcpUrl(): string {
  const server = Bun.serve({ port: 0, fetch: () => Response.json({}) });
  const url = `http://127.0.0.1:${server.port}`;
  server.stop(true);
  return url;
}

function writeCfg(name: string, socketPath: string, nodeUrl = closedTcpUrl()): string {
  const p = join(tmp, name);
  writeFileSync(
    p,
    JSON.stringify({
      configVersion: 1,
      nodeUrl,
      schemaServiceUrl: "http://unused.invalid",
      userHash: "u",
      schemaHashes: {
        card: CARD_HASH,
        board: BOARD_HASH,
        milestone: MILESTONE_HASH,
        board_cards: BOARD_CARDS_HASH,
        card_list_index: CARD_LIST_INDEX_HASH,
      },
      nodeSocketPath: socketPath,
    }),
  );
  return p;
}

/** Queries that read the board-list rollup row (`all_boards`). */
function boardListReads(queries: QueryLog[]): QueryLog[] {
  return queries.filter(
    (q) => q.schema === CARD_LIST_INDEX_HASH && q.hashKey === BOARD_LIST_INDEX_KEY,
  );
}

/**
 * Queries that read a whole BoardCards partition — i.e. "read the card list".
 * One per board per card-list fetch, so a second `listCards` in the same run
 * shows up as a second read of EVERY board's partition.
 */
function cardListReads(queries: QueryLog[]): QueryLog[] {
  return queries.filter((q) => q.schema === BOARD_CARDS_HASH);
}

describe("doctor read amplification", () => {
  test("reads the board list at most once per run", async () => {
    const node = makeCountingNode({ boards: ["default", "second"], cardsPerBoard: 3 });
    const cfgPath = writeCfg("boardlist.json", node.socketPath);
    try {
      await doctor({ configPath: cfgPath, print: () => {} });
      expect(boardListReads(node.queries).length).toBe(1);
    } finally {
      node.stop();
    }
  });

  test("reads the card list at most once per run", async () => {
    const node = makeCountingNode({ boards: ["default", "second"], cardsPerBoard: 3 });
    const cfgPath = writeCfg("cardlist.json", node.socketPath);
    try {
      await doctor({ configPath: cfgPath, print: () => {} });
      // The projection-parity check reads each partition once WIDE and once per
      // FIELD — that is the check, not amplification, and the per-field half is
      // not optional. A projection filters on its leading field, so the old
      // spine-vs-wide comparison put the same blind spot on both sides of the
      // subtraction and netted to zero: a row carrying neither `board` nor
      // `slug` was missing from both reads and the check printed green over it.
      // The union over leading fields is the only input here that is not itself
      // a projection (see `listBoardCardsPartitionComplete`).
      //
      // Budget: 1 card-list fetch + 1 wide + one lead per BoardCards field, per
      // board. Derived from the field list rather than hard-coded so adding a
      // field cannot silently shrink the sweep — but the invariant that matters
      // is what this does NOT contain: nothing here scales with cards per board.
      const boards = 2;
      const perBoard = 1 + 1 + BOARD_CARDS_FIELDS.length;
      expect(cardListReads(node.queries).length).toBe(boards * perBoard);
    } finally {
      node.stop();
    }
  });

  test("the multi-field smoke check still passes while reusing the card set", async () => {
    // The smoke check needs ONE live card slug to point-read. It must take that
    // from the card set doctor already has in hand rather than re-listing — but
    // reusing the set must not weaken the check, which is the 2026-07-24 Mini
    // slug-only-projection canary. Assert BOTH halves: the read budget for a
    // single board (1 card-list fetch + parity's spine+wide), and that the
    // check still reports green off the reused set.
    //
    // cardsPerBoard is 4 here and 3 in the test above, and both land on the same
    // per-board budget — which is the point of asserting it at all.
    const node = makeCountingNode({ boards: ["default"], cardsPerBoard: 4 });
    const lines: string[] = [];
    try {
      await doctor({
        configPath: writeCfg("smoke.json", node.socketPath),
        print: (l) => lines.push(l),
      });
      expect(cardListReads(node.queries).length).toBe(1 + 1 + BOARD_CARDS_FIELDS.length);
      expect(lines.join("\n")).toContain("✓ card multi-field smoke");
    } finally {
      node.stop();
    }
  });

  test("no socket means doctor stops before the board reads, not after them", async () => {
    // The client is socket-only: the loopback TCP control plane is retired, so
    // a config whose socket is absent cannot reach the node at all. Doctor must
    // bail at "node reachable + provisioned" — BEFORE any whole-board read —
    // rather than grinding through list reads that are all going to fail.
    //
    // This also pins why the `else` arm of the round-trip check is NOT a TCP
    // fallback (it looks like one): it is unreachable via a missing socket,
    // because doctor has already returned by then.
    const node = makeCountingNode({ boards: ["default"], cardsPerBoard: 3 });
    const missingSocket = join(tmp, "no-such-socket.sock");
    try {
      const lines: string[] = [];
      const ok = await doctor({
        configPath: writeCfg("nosocket.json", missingSocket),
        print: (l) => lines.push(l),
      });
      expect(ok).toBe(false);
      expect(lines.join("\n")).toContain("✗ node reachable + provisioned");
      expect(node.queries.length).toBe(0);
    } finally {
      node.stop();
    }
  });
});
