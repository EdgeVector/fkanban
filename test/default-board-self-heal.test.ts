// Regression: if the `default` board record disappears while live cards still
// reference it, write paths must recreate the board metadata instead of failing
// with `Board "default" does not exist`.

import { describe, expect, test } from "bun:test";

import { FkanbanError, type NodeClient, type QueryFilter, type QueryResponse, type QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { addCmd } from "../src/commands/add.ts";
import { moveCmd } from "../src/commands/move.ts";
import {
  boardToFields,
  cardToFields,
  emptyStructuredFields,
  findBoard,
  findCard,
  nowIso,
  type Board,
  type Card,
} from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";

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
  const rowsFor = (schemaHash: string, filter?: QueryFilter): QueryRow[] => {
    const t = tableFor(schemaHash);
    const entries = filter?.HashKey
      ? (t.has(filter.HashKey) ? [[filter.HashKey, t.get(filter.HashKey)!] as const] : [])
      : [...t.entries()].filter(([, fields]) =>
          !filter || Object.entries(filter).every(([field, value]) => fields[field] === value)
        );
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
    nodeTransport: () => ({ transport: "unavailable" as const }),
  };
}

function card(partial: Partial<Card>): Card {
  const now = nowIso();
  return {
    slug: "existing",
    title: "Existing",
    body: "",
    board: "default",
    column: "todo",
    position: "1",
    assignee: "",
    tags: [],
    deps: [],
    ...emptyStructuredFields(),
    created_at: now,
    updated_at: now,
    ...partial,
  };
}

function seedCard(node: NodeClient, c: Card) {
  return node.createRecord({
    schemaHash: cfg.schemaHashes.card!,
    keyHash: c.slug,
    fields: cardToFields(c),
  });
}

function seedBoard(node: NodeClient, b: Board) {
  return node.createRecord({
    schemaHash: cfg.schemaHashes.board!,
    keyHash: b.slug,
    fields: boardToFields(b),
  });
}

describe("missing referenced board self-heal", () => {
  test("add recreates a missing default board record when live cards reference it", async () => {
    const node = fakeNode();
    await seedCard(node, card({ slug: "old-card", board: "default", column: "todo" }));

    const res = await addCmd({ cfg, node, slug: "new-card", title: "New card" });

    expect(res).toMatchObject({ action: "created", board: "default", column: DEFAULT_COLUMNS[0] });
    const healed = await findBoard(node, cfg, "default");
    expect(healed?.title).toBe("Default board");
    expect(healed?.columns).toEqual([...DEFAULT_COLUMNS]);
    expect((await findCard(node, cfg, "new-card"))?.board).toBe("default");
  });

  test("move recreates a missing board record for the card's board before validating columns", async () => {
    const node = fakeNode();
    await seedCard(node, card({ slug: "moveme", board: "default", column: "todo" }));

    const res = await moveCmd({ cfg, node, slug: "moveme", column: "doing" });

    expect(res).toEqual({ slug: "moveme", from: "todo", to: "doing" });
    expect((await findBoard(node, cfg, "default"))?.columns).toEqual([...DEFAULT_COLUMNS]);
    expect((await findCard(node, cfg, "moveme"))?.column).toBe("doing");
  });

  test("missing unreferenced boards still fail with an exact create command", async () => {
    const node = fakeNode();
    await seedBoard(node, {
      slug: "default",
      title: "Default board",
      body: "",
      columns: [...DEFAULT_COLUMNS],
      created_at: nowIso(),
      updated_at: nowIso(),
    });

    const err = await addCmd({ cfg, node, slug: "new-card", board: "missing" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FkanbanError);
    expect((err as FkanbanError).code).toBe("board_not_found");
    expect((err as FkanbanError).hint).toBe(
      "Create it first: `fkanban board create missing --columns backlog,todo,doing,done`.",
    );
  });
});
