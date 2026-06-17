// Regression: `add` doubles as create AND update. Updating a card (e.g. just
// the title) must NOT silently move it to the `default` board. The bug was that
// the update path forced `board = opts.board ?? "default"`, clobbering a card
// that lived on a non-default board to `default` (silent data-integrity loss),
// and validated `--column` against the wrong board's columns. The fix resolves
// the existing card BEFORE the board context: `opts.board ?? existing?.board ??
// "default"`. Explicit `--board` still moves the card; the create path is
// unchanged.
//
// Backed by the same in-memory fake NodeClient used in mcp.test.ts /
// read-board-validation.test.ts — exercises the real addCmd with no live node.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { FkanbanError } from "../src/client.ts";
import type { NodeClient, QueryResponse, QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { boardToFields, findCard, nowIso } from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";
import { addCmd } from "../src/commands/add.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash" },
};

function fakeNode(): NodeClient {
  const store = new Map<string, Map<string, Record<string, unknown>>>();
  const tableFor = (schemaHash: string) => {
    let t = store.get(schemaHash);
    if (!t) {
      t = new Map();
      store.set(schemaHash, t);
    }
    return t;
  };
  const rowsFor = (schemaHash: string, filter?: { HashKey: string }): QueryRow[] => {
    const t = tableFor(schemaHash);
    const entries = filter
      ? t.has(filter.HashKey)
        ? [[filter.HashKey, t.get(filter.HashKey)!] as const]
        : []
      : [...t.entries()];
    return entries.map(([hash, fields]) => ({ fields, key: { hash, range: null } }));
  };
  const notImpl = (m: string) => async (): Promise<never> => {
    throw new Error(`fakeNode.${m} not implemented`);
  };
  return {
    baseUrl: cfg.nodeUrl,
    userHash: cfg.userHash,
    autoIdentity: notImpl("autoIdentity"),
    bootstrap: notImpl("bootstrap"),
    loadSchemas: notImpl("loadSchemas"),
    listSchemas: notImpl("listSchemas"),
    async createRecord({ schemaHash, fields, keyHash }) {
      tableFor(schemaHash).set(keyHash, fields);
    },
    async updateRecord({ schemaHash, fields, keyHash }) {
      tableFor(schemaHash).set(keyHash, fields);
    },
    async deleteRecord({ schemaHash, keyHash }) {
      tableFor(schemaHash).delete(keyHash);
    },
    async queryAll({ schemaHash, filter }): Promise<QueryResponse> {
      const results = rowsFor(schemaHash, filter);
      return { ok: true, results, returned_count: results.length, total_count: results.length };
    },
    rawCall: notImpl("rawCall") as NodeClient["rawCall"],
  };
}

function seedBoard(node: NodeClient, slug: string, columns: string[]) {
  const now = nowIso();
  return node.createRecord({
    schemaHash: cfg.schemaHashes.board!,
    keyHash: slug,
    fields: boardToFields({
      slug,
      title: slug,
      body: "",
      columns,
      created_at: now,
      updated_at: now,
    }),
  });
}

describe("add update preserves the card's board", () => {
  let node: NodeClient;

  beforeEach(async () => {
    node = fakeNode();
    await seedBoard(node, "default", [...DEFAULT_COLUMNS]);
    // A board with a custom column set, to also catch column mis-validation.
    await seedBoard(node, "other", ["icebox", "wip", "shipped"]);
  });

  test("(a) update with NO --board keeps the card on its non-default board", async () => {
    const created = await addCmd({
      cfg,
      node,
      slug: "probe",
      title: "probe v1",
      board: "other",
      column: "wip",
    });
    expect(created).toMatchObject({ action: "created", board: "other", column: "wip" });

    // Edit just the title, no --board — must NOT teleport to "default".
    const updated = await addCmd({ cfg, node, slug: "probe", title: "probe v2 EDITED" });
    expect(updated).toMatchObject({ action: "updated", board: "other", column: "wip" });

    const after = await findCard(node, cfg, "probe");
    expect(after?.board).toBe("other");
    expect(after?.title).toBe("probe v2 EDITED");
    expect(after?.column).toBe("wip");
  });

  test("(b) update --column valid on the card's OWN board succeeds", async () => {
    await addCmd({ cfg, node, slug: "probe", board: "other", column: "wip" });

    // "shipped" is a column on "other" but NOT on the default board. Before the
    // fix this validated against the default board's columns and would throw.
    const updated = await addCmd({ cfg, node, slug: "probe", column: "shipped" });
    expect(updated).toMatchObject({ action: "updated", board: "other", column: "shipped" });

    const after = await findCard(node, cfg, "probe");
    expect(after?.board).toBe("other");
    expect(after?.column).toBe("shipped");
  });

  test("(b') update --column invalid on the card's own board is rejected", async () => {
    await addCmd({ cfg, node, slug: "probe", board: "other", column: "wip" });
    // "todo" is a default-board column but not on "other".
    expect(addCmd({ cfg, node, slug: "probe", column: "todo" })).rejects.toBeInstanceOf(FkanbanError);
  });

  test("(c) explicit --board still moves the card (intended)", async () => {
    await addCmd({ cfg, node, slug: "probe", board: "other", column: "wip" });

    const moved = await addCmd({ cfg, node, slug: "probe", board: "default", column: "todo" });
    expect(moved).toMatchObject({ action: "updated", board: "default", column: "todo" });

    const after = await findCard(node, cfg, "probe");
    expect(after?.board).toBe("default");
    expect(after?.column).toBe("todo");
  });

  test("(d) create path unchanged: defaults to the default board, then its first column", async () => {
    const created = await addCmd({ cfg, node, slug: "fresh", title: "Fresh" });
    expect(created).toMatchObject({
      action: "created",
      board: "default",
      column: DEFAULT_COLUMNS[0],
    });

    const after = await findCard(node, cfg, "fresh");
    expect(after?.board).toBe("default");
    expect(after?.column).toBe(DEFAULT_COLUMNS[0]);
  });

  test("(d') create with explicit --board honors it", async () => {
    const created = await addCmd({ cfg, node, slug: "fresh2", board: "other", column: "icebox" });
    expect(created).toMatchObject({ action: "created", board: "other", column: "icebox" });
  });
});

// `add --deps` must warn (to stderr) on a dep slug that doesn't resolve to a
// live card — the same forward-dependency heads-up `dep add` emits — WITHOUT
// blocking the write. A missing dep is non-blocking by design; we only signal
// at write time what `show` would otherwise surface much later.
describe("add --deps warns on missing dependency slugs", () => {
  let node: NodeClient;
  let warnings: string[];
  let restore: () => void;

  beforeEach(async () => {
    node = fakeNode();
    await seedBoard(node, "default", [...DEFAULT_COLUMNS]);
    warnings = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    restore = () => {
      console.error = orig;
    };
  });

  afterEach(() => restore());

  test("missing dep → warns once and STILL creates the card", async () => {
    const created = await addCmd({
      cfg,
      node,
      slug: "warn-a",
      title: "A",
      deps: ["does-not-exist"],
    });
    expect(created).toMatchObject({ action: "created" });
    expect(warnings).toEqual([
      'fkanban: warning — no card "does-not-exist" yet; adding it as a forward dependency.',
    ]);
    // Write still landed, with the forward dep recorded.
    const after = await findCard(node, cfg, "warn-a");
    expect(after?.deps).toEqual(["does-not-exist"]);
  });

  test("existing dep → no warning", async () => {
    await addCmd({ cfg, node, slug: "dep-target", title: "Target" });
    warnings.length = 0;
    await addCmd({ cfg, node, slug: "warn-b", title: "B", deps: ["dep-target"] });
    expect(warnings).toEqual([]);
  });

  test("mixed deps → exactly one warning, for the missing one only", async () => {
    await addCmd({ cfg, node, slug: "dep-ok", title: "OK" });
    warnings.length = 0;
    await addCmd({ cfg, node, slug: "warn-c", title: "C", deps: ["dep-ok", "dep-missing"] });
    expect(warnings).toEqual([
      'fkanban: warning — no card "dep-missing" yet; adding it as a forward dependency.',
    ]);
  });

  test("no --deps → never reads or warns", async () => {
    await addCmd({ cfg, node, slug: "warn-d", title: "D" });
    expect(warnings).toEqual([]);
  });
});
