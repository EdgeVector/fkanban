// `fkanban tag add|rm <slug> <tag...>` edits one (or a few) labels on a card
// WITHOUT clobbering the rest — the incremental counterpart to `add --tags`
// (which REPLACES the list wholesale), exactly mirroring `dep add`/`dep rm`.
//
// Backed by the same in-memory fake NodeClient used in add-update-board.test.ts
// (HashKey point-reads + recorded updates), so it exercises the real
// tagAddCmd/tagRmCmd + addCmd against no live node.

import { beforeEach, describe, expect, test } from "bun:test";

import { FkanbanError } from "../src/client.ts";
import type { NodeClient, QueryFilter, QueryResponse, QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { boardToFields, findCard, nowIso } from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";
import { addCmd } from "../src/commands/add.ts";
import { depAddCmd } from "../src/commands/dep.ts";
import { tagAddCmd, tagRmCmd } from "../src/commands/tag.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash" },
};

const validPickupBody = "Repo: EdgeVector/fkanban\nBase: main\n\nTag fixture.";

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

function seedBoard(node: NodeClient, slug: string, columns: string[]) {
  const now = nowIso();
  return node.createRecord({
    schemaHash: cfg.schemaHashes.board!,
    keyHash: slug,
    fields: boardToFields({ slug, title: slug, body: "", columns, created_at: now, updated_at: now }),
  });
}

describe("tag add/rm edit one label without clobbering the rest", () => {
  let node: NodeClient;

  beforeEach(async () => {
    node = fakeNode();
    await seedBoard(node, "default", [...DEFAULT_COLUMNS]);
  });

  test("tag add unions into the existing list (other tags survive)", async () => {
    await addCmd({ cfg, node, slug: "probe", column: "todo", tags: ["a", "b"], body: validPickupBody });

    const res = await tagAddCmd({ cfg, node, slug: "probe", tag: ["c"] });
    expect(res).toEqual({ slug: "probe", action: "added", tag: ["c"], tags: ["a", "b", "c"] });

    const after = await findCard(node, cfg, "probe");
    expect(after?.tags).toEqual(["a", "b", "c"]);
  });

  test("tag add of a present tag is idempotent (no duplicate)", async () => {
    await addCmd({ cfg, node, slug: "probe", column: "todo", tags: ["a", "b"], body: validPickupBody });
    const res = await tagAddCmd({ cfg, node, slug: "probe", tag: ["a"] });
    expect(res.tags).toEqual(["a", "b"]);
  });

  test("tag add accepts multiple tags at once, normalized + deduped", async () => {
    await addCmd({ cfg, node, slug: "probe", column: "todo", tags: ["a"], body: validPickupBody });
    const res = await tagAddCmd({ cfg, node, slug: "probe", tag: [" b ", "a", "c", "b"] });
    expect(res.tags).toEqual(["a", "b", "c"]);
    expect(res.tag).toEqual(["b", "a", "c"]); // incoming normalized + deduped (order-stable), trim applied
  });

  test("tag rm removes only the named tag (others survive)", async () => {
    await addCmd({ cfg, node, slug: "probe", column: "todo", tags: ["a", "b", "c"], body: validPickupBody });
    const res = await tagRmCmd({ cfg, node, slug: "probe", tag: ["b"] });
    expect(res).toEqual({ slug: "probe", action: "removed", tag: ["b"], tags: ["a", "c"] });

    const after = await findCard(node, cfg, "probe");
    expect(after?.tags).toEqual(["a", "c"]);
  });

  test("tag rm of an absent tag is a no-op (succeeds)", async () => {
    await addCmd({ cfg, node, slug: "probe", column: "todo", tags: ["a"], body: validPickupBody });
    const res = await tagRmCmd({ cfg, node, slug: "probe", tag: ["ghost"] });
    expect(res.tags).toEqual(["a"]);
  });

  test("tag add/rm never disturb dependency edges (deps survive a tag edit)", async () => {
    await addCmd({ cfg, node, slug: "api", column: "todo", body: validPickupBody });
    await addCmd({ cfg, node, slug: "ui", column: "todo", tags: ["frontend"], body: validPickupBody });
    await depAddCmd({ cfg, node, slug: "ui", dep: "api" });

    await tagAddCmd({ cfg, node, slug: "ui", tag: ["p1"] });
    const after = await findCard(node, cfg, "ui");
    expect(after?.tags).toEqual(["frontend", "p1"]); // dep:api is split out, not shown
    expect(after?.deps).toEqual(["api"]); // the dependency edge is intact

    await tagRmCmd({ cfg, node, slug: "ui", tag: ["frontend"] });
    const after2 = await findCard(node, cfg, "ui");
    expect(after2?.deps).toEqual(["api"]); // still intact after a tag rm
  });

  test("tag add on a missing card raises a voiced card_not_found", async () => {
    const p = tagAddCmd({ cfg, node, slug: "ghost", tag: ["x"] });
    await expect(p).rejects.toBeInstanceOf(FkanbanError);
    await expect(p).rejects.toMatchObject({ code: "card_not_found" });
  });

  test("tag rm on a missing card raises a voiced card_not_found", async () => {
    const p = tagRmCmd({ cfg, node, slug: "ghost", tag: ["x"] });
    await expect(p).rejects.toMatchObject({ code: "card_not_found" });
  });

  test("tag add rejects a reserved dep: tag (use `dep add` instead)", async () => {
    await addCmd({ cfg, node, slug: "probe", column: "todo", body: validPickupBody });
    const p = tagAddCmd({ cfg, node, slug: "probe", tag: ["dep:api"] });
    await expect(p).rejects.toMatchObject({ code: "reserved_tag" });
  });

  test("tag add rejects the internal tombstone tag", async () => {
    await addCmd({ cfg, node, slug: "probe", column: "todo", body: validPickupBody });
    const p = tagAddCmd({ cfg, node, slug: "probe", tag: ["__fkanban_deleted__"] });
    await expect(p).rejects.toMatchObject({ code: "reserved_tag" });
  });

  test("tag add rejects the internal done_at tag", async () => {
    await addCmd({ cfg, node, slug: "probe", column: "todo", body: validPickupBody });
    const p = tagAddCmd({ cfg, node, slug: "probe", tag: ["done_at:2026-07-03T12:00:00.000Z"] });
    await expect(p).rejects.toMatchObject({ code: "reserved_tag" });
  });
});
