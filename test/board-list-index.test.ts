// `all_boards` rollup invariants — the one single-row rollup kanban still writes.
//
// It decides which BoardCards partitions `kanban list` queries at all, so drift
// is not cosmetic: a ghost keeps a deleted board listed forever, and a dropped
// board makes every card on it invisible to list while `show` still works.
//
// The fake node below reproduces a MEASURED LastDB behaviour on purpose: an
// unfiltered (full-scan) query returns only the KEY field for each row, while a
// HashKey point read returns the whole projection
// (papercut-lastdb-full-scan-drops-fields-on-conflicted-records). Any code that
// trusts a non-key field off a scan row is wrong, and these tests fail if it does.

import { describe, expect, test } from "bun:test";

import { boardCreateCmd, boardRmCmd } from "../src/commands/board.ts";
import { boardListHealResult } from "../src/commands/board_list_heal.ts";
import { patchBoardListIndex, BOARD_LIST_INDEX_KEY } from "../src/card-list-index.ts";
import { listBoards, scanBoardsForReconcile, boardToFields, type Board } from "../src/record.ts";
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

type Write = { op: "create" | "update" | "delete"; schemaHash: string; keyHash: string; expected?: unknown };

type Fake = {
  node: NodeClient;
  writes: Write[];
  /** Current all_boards entries, as the store holds them. */
  indexEntries(): Array<{ slug: string }> | null;
  setIndex(entries: unknown[] | null): void;
  /** Mutate the stored payload behind the caller's back, to force a CAS conflict. */
  onBeforeIndexUpdate?: () => void;
};

function fakeNode(opts: {
  boards: Board[];
  index?: unknown[] | null;
  scanKeyFieldOnly?: boolean;
  /**
   * Board slugs the full scan refuses to list even though they exist and point
   * read fine — the measured LastDB behaviour that makes "absent from scan"
   * useless as evidence of deletion.
   */
  scanOmits?: string[];
}): Fake {
  const boardStore = new Map<string, Board>(opts.boards.map((b) => [b.slug, b]));
  const omitted = new Set(opts.scanOmits ?? []);
  // CardListIndex is ONE schema holding several keyed rows (all_boards,
  // all_cards). Key them apart in the fake too — a fake that collapses them lets
  // an unrelated all_cards write clobber all_boards and hides real bugs.
  const indexStore = new Map<string, string>();
  if (opts.index !== undefined && opts.index !== null) {
    indexStore.set(BOARD_LIST_INDEX_KEY, JSON.stringify(opts.index));
  }
  const boardsRaw = () => indexStore.get(BOARD_LIST_INDEX_KEY) ?? null;
  const writes: Write[] = [];
  const scanKeyFieldOnly = opts.scanKeyFieldOnly !== false;
  const fake: Fake = {
    node: undefined as unknown as NodeClient,
    writes,
    indexEntries: () => {
      const raw = boardsRaw();
      return raw === null ? null : (JSON.parse(raw) as Array<{ slug: string }>);
    },
    setIndex: (entries) => {
      if (entries === null) indexStore.delete(BOARD_LIST_INDEX_KEY);
      else indexStore.set(BOARD_LIST_INDEX_KEY, JSON.stringify(entries));
    },
  };
  const stub = () => {
    throw new Error("not implemented in fake node");
  };
  const indexRows = () =>
    [...indexStore.entries()].map(([key, payload]) => ({
      fields: { key, payload_json: payload, updated_at: "2026-01-01T00:00:00.000Z" },
      key: { hash: key, range: null },
    }));

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
      writes.push({ op: "create", schemaHash, keyHash, expected });
      if (schemaHash === INDEX) {
        indexStore.set(keyHash, String((fields as Record<string, unknown>).payload_json ?? ""));
      }
      if (schemaHash === BOARD) boardStore.set(keyHash, board(fields as unknown as Partial<Board>));
    },
    async updateRecord({ schemaHash, keyHash, fields, expected }) {
      if (schemaHash === INDEX) {
        if (keyHash === BOARD_LIST_INDEX_KEY) fake.onBeforeIndexUpdate?.();
        if (expected !== undefined) {
          const exp = expected as { type: string; field: string; value: unknown };
          const actual = indexStore.get(keyHash) ?? null;
          if (exp.type === "value" && exp.field === "payload_json" && exp.value !== actual) {
            writes.push({ op: "update", schemaHash, keyHash, expected });
            throw new FkanbanError({ code: "cas_conflict", message: "CAS precondition failed." });
          }
        }
        indexStore.set(keyHash, String((fields as Record<string, unknown>).payload_json ?? ""));
      }
      writes.push({ op: "update", schemaHash, keyHash, expected });
    },
    async deleteRecord({ schemaHash, keyHash }) {
      writes.push({ op: "delete", schemaHash, keyHash });
      if (schemaHash === BOARD) boardStore.delete(keyHash);
    },
    async queryAll(q: { schemaHash: string; fields: string[]; filter?: QueryFilter }): Promise<QueryResponse> {
      if (q.schemaHash === INDEX) {
        return { ok: true, results: indexRows().filter((r) => !q.filter || r.key.hash === q.filter.HashKey) };
      }
      if (q.schemaHash === CARD) return { ok: true, results: [] };
      if (q.schemaHash !== BOARD) return { ok: true, results: [] };

      const rows = [...boardStore.values()].map((b) => ({
        fields: boardToFields(b) as Record<string, unknown>,
        key: { hash: b.slug, range: null },
      }));
      if (q.filter) {
        // Point read: full projection, like the real node.
        return { ok: true, results: rows.filter((r) => r.key.hash === q.filter!.HashKey) };
      }
      // Full scan: LastDB returns ONLY the key field for conflicted records, and
      // omits some live records entirely.
      const scanned = rows.filter((r) => !omitted.has(String(r.fields.slug)));
      return {
        ok: true,
        results: scanKeyFieldOnly
          ? scanned.map((r) => ({ fields: { slug: r.fields.slug }, key: r.key }))
          : scanned,
      };
    },
  };
  return fake;
}

describe("all_boards rollup — board rm", () => {
  test("board rm removes the board from all_boards (no ghost left behind)", async () => {
    const scratch = board({ slug: "scratch" });
    const fake = fakeNode({ boards: [scratch], index: [summaryOf(board({ slug: "default" })), summaryOf(scratch)] });

    await boardRmCmd({ cfg, node: fake.node, slug: "scratch" });

    expect(fake.indexEntries()?.map((b) => b.slug)).toEqual(["default"]);
    // And the board is really gone from the listing the CLI renders.
    const listed = await listBoards(fake.node, cfg);
    expect(listed.map((b) => b.slug)).toEqual(["default"]);
  });

  test("a stale all_boards entry keeps a deleted board listed — heal reports it as a ghost", async () => {
    // Exactly the state the pre-fix `board rm` left on the primary: index entry
    // present, Board record gone.
    const fake = fakeNode({
      boards: [board({ slug: "default" })],
      index: [summaryOf(board({ slug: "default" })), summaryOf(board({ slug: "deleted-probe" }))],
    });

    const before = await listBoards(fake.node, cfg);
    expect(before.map((b) => b.slug)).toEqual(["default", "deleted-probe"]);

    const { report } = await boardListHealResult({ cfg, node: fake.node, json: true });
    expect(report.ghosts).toBe(1);
    expect(report.actions.find((a) => a.slug === "deleted-probe")?.action).toBe("drop-ghost");
  });
});

describe("all_boards rollup — heal", () => {
  test("dry run writes nothing", async () => {
    const fake = fakeNode({
      boards: [board({ slug: "default" })],
      index: [summaryOf(board({ slug: "default" })), summaryOf(board({ slug: "gone" }))],
    });
    const { report } = await boardListHealResult({ cfg, node: fake.node });
    expect(report.dryRun).toBe(true);
    expect(report.healed).toBe(0);
    expect(fake.writes.filter((w) => w.schemaHash === INDEX)).toHaveLength(0);
    expect(fake.indexEntries()?.map((b) => b.slug)).toEqual(["default", "gone"]);
  });

  test("--apply rewrites all_boards from Board truth: ghost dropped, missing board restored", async () => {
    const fake = fakeNode({
      boards: [board({ slug: "default" }), board({ slug: "live-but-unindexed" })],
      index: [summaryOf(board({ slug: "default" })), summaryOf(board({ slug: "ghost" }))],
    });

    const { report } = await boardListHealResult({ cfg, node: fake.node, apply: true });

    expect(report.ghosts).toBe(1);
    expect(report.missing).toBe(1);
    expect(report.healed).toBe(2);
    expect(fake.indexEntries()?.map((b) => b.slug)).toEqual(["default", "live-but-unindexed"]);
  });

  test("a live board missing from the index hides its cards from list until healed", async () => {
    const fake = fakeNode({
      boards: [board({ slug: "default" }), board({ slug: "orphaned" })],
      index: [summaryOf(board({ slug: "default" }))],
    });
    // `listBoards` trusts the rollup, so `orphaned` is not even queried for cards.
    expect((await listBoards(fake.node, cfg)).map((b) => b.slug)).toEqual(["default"]);

    await boardListHealResult({ cfg, node: fake.node, apply: true });
    expect((await listBoards(fake.node, cfg)).map((b) => b.slug)).toEqual(["default", "orphaned"]);
  });

  test("an absent all_boards row is not drift — list re-seeds it", async () => {
    const fake = fakeNode({ boards: [board({ slug: "default" })], index: null });
    const { report } = await boardListHealResult({ cfg, node: fake.node, apply: true });
    expect(report.index_absent).toBe(true);
    expect(report.healed).toBe(0);
  });

  test("reports nothing to heal when the index schema is not bound", async () => {
    const unbound: Config = { ...cfg, schemaHashes: { card: CARD, board: BOARD } };
    const fake = fakeNode({ boards: [board({ slug: "default" })], index: null });
    const { text, report } = await boardListHealResult({ cfg: unbound, node: fake.node });
    expect(report.drifted).toBe(0);
    expect(text).toContain("not bound");
  });
});

describe("all_boards rollup — CAS", () => {
  test("patch carries the payload it read as the CAS witness", async () => {
    const existing = [summaryOf(board({ slug: "default" }))];
    const fake = fakeNode({ boards: [board({ slug: "default" })], index: existing });

    await patchBoardListIndex(fake.node, cfg, summaryOf(board({ slug: "new" })), "upsert");

    const update = fake.writes.find((w) => w.schemaHash === INDEX && w.op === "update");
    expect(update?.expected).toEqual({
      type: "value",
      field: "payload_json",
      value: JSON.stringify(existing),
    });
  });

  test("a concurrent board write is not silently dropped — the patch re-reads and re-applies", async () => {
    const first = board({ slug: "aaa" });
    const fake = fakeNode({ boards: [first], index: [summaryOf(first)] });

    // Someone else's board lands between our read and our write, exactly once.
    let raced = false;
    fake.onBeforeIndexUpdate = () => {
      if (raced) return;
      raced = true;
      fake.setIndex([summaryOf(first), summaryOf(board({ slug: "concurrent" }))]);
    };

    await patchBoardListIndex(fake.node, cfg, summaryOf(board({ slug: "mine" })), "upsert");

    // Both survive: the loser re-read and re-applied instead of overwriting.
    expect(fake.indexEntries()?.map((b) => b.slug)).toEqual(["aaa", "concurrent", "mine"]);
  });

  test("an endlessly conflicting patch throws cas_conflict instead of looping", async () => {
    const fake = fakeNode({ boards: [], index: [] });
    let n = 0;
    fake.onBeforeIndexUpdate = () => {
      n += 1;
      fake.setIndex([summaryOf(board({ slug: `racer-${n}` }))]);
    };
    const err = await patchBoardListIndex(fake.node, cfg, summaryOf(board({ slug: "mine" })), "upsert").catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(FkanbanError);
    expect((err as FkanbanError).code).toBe("cas_conflict");
    expect(n).toBeLessThanOrEqual(4);
  });
});

describe("all_boards rollup — a scan that omits live records must not create ghosts", () => {
  // The state measured on the primary 2026-07-28: nine boards in the index that
  // the Board full scan does not list, but that point-read live. Calling them
  // ghosts and applying would drop them and hide every card on them.
  test("an indexed board the scan omits is verified by point read, not declared a ghost", async () => {
    const live = board({ slug: "invisible-to-scan", title: "Live" });
    const fake = fakeNode({
      boards: [board({ slug: "default" }), live],
      index: [summaryOf(board({ slug: "default" })), summaryOf(live)],
      scanOmits: ["invisible-to-scan"],
    });

    const { report } = await boardListHealResult({ cfg, node: fake.node, json: true });

    expect(report.ghosts).toBe(0);
    expect(report.drifted).toBe(0);
    expect(report.actions.find((a) => a.slug === "invisible-to-scan")?.action).toBe("noop-match");
  });

  test("--apply keeps a scan-omitted live board in the index", async () => {
    const live = board({ slug: "invisible-to-scan" });
    const fake = fakeNode({
      boards: [board({ slug: "default" }), live],
      // `stale-entry` is in the index and genuinely deleted, so there IS drift to apply.
      index: [summaryOf(board({ slug: "default" })), summaryOf(live), summaryOf(board({ slug: "stale-entry" }))],
      scanOmits: ["invisible-to-scan"],
    });

    const { report } = await boardListHealResult({ cfg, node: fake.node, apply: true });

    expect(report.ghosts).toBe(1);
    expect(fake.indexEntries()?.map((b) => b.slug)).toEqual(["default", "invisible-to-scan"]);
  });
});

describe("Board truth discovery does not trust scan projections", () => {
  test("scanBoardsForReconcile hydrates by point read when the scan returns slug only", async () => {
    // scanKeyFieldOnly (the default) drops every non-key field from scan rows.
    const fake = fakeNode({ boards: [board({ slug: "a", title: "Alpha" }), board({ slug: "b", title: "Beta" })] });

    const boards = await scanBoardsForReconcile(fake.node, cfg);

    expect(boards.map((b) => b.slug)).toEqual(["a", "b"]);
    // The titles/columns could only have come from the point reads.
    expect(boards.map((b) => b.title)).toEqual(["Alpha", "Beta"]);
    for (const b of boards) expect(b.columns).toEqual(["backlog", "todo", "doing", "done"]);
  });

  test("the cold-seed path never writes hollow, column-less boards into all_boards", async () => {
    const fake = fakeNode({ boards: [board({ slug: "a", title: "Alpha" })], index: null });

    const listed = await listBoards(fake.node, cfg);

    expect(listed.map((b) => b.slug)).toEqual(["a"]);
    const seeded = fake.indexEntries() as Array<{ slug: string; title: string; columns: string[] }> | null;
    expect(seeded).not.toBeNull();
    expect(seeded![0]!.title).toBe("Alpha");
    expect(seeded![0]!.columns).toEqual(["backlog", "todo", "doing", "done"]);
  });

  test("board create then rm round-trips the index with no residue", async () => {
    const fake = fakeNode({ boards: [], index: [] });
    await boardCreateCmd({ cfg, node: fake.node, slug: "tmp", title: "Temp" });
    expect(fake.indexEntries()?.map((b) => b.slug)).toEqual(["tmp"]);
    await boardRmCmd({ cfg, node: fake.node, slug: "tmp" });
    expect(fake.indexEntries()).toEqual([]);
  });
});
