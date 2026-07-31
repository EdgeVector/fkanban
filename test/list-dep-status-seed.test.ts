// listDependencyStatusesForCards must not point-read deps already present in
// knownCards (the BoardCards board partition). Without that seed, column list
// N+1 Card-hashed every dep outside the column (multi-second under thrash).

import { describe, expect, test } from "bun:test";

import type { NodeClient, QueryFilter, QueryResponse, QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { listDependencyStatusesForCards, nowIso, type Card } from "../src/record.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash" },
};

function card(partial: Partial<Card> & { slug: string }): Card {
  const now = nowIso();
  return {
    slug: partial.slug,
    title: partial.title ?? partial.slug,
    body: partial.body ?? "",
    board: partial.board ?? "default",
    column: partial.column ?? "todo",
    position: partial.position ?? "1",
    tags: partial.tags ?? [],
    deps: partial.deps ?? [],
    surfaces: partial.surfaces ?? [],
    assignee: partial.assignee ?? "",
    kind: partial.kind ?? "pr",
    created_at: partial.created_at ?? now,
    updated_at: partial.updated_at ?? now,
    created_by: partial.created_by ?? "test",
    pr_url: partial.pr_url ?? "",
    repo: partial.repo ?? "",
    base: partial.base ?? "",
    north_star: partial.north_star ?? "",
    milestone: partial.milestone ?? "",
    block_status: partial.block_status ?? "",
    block_reason: partial.block_reason ?? "",
    db: partial.db ?? "",
    branch: partial.branch ?? "",
    done_at: partial.done_at ?? "",
  };
}

function fakeNode(opts?: { onCardHashKey?: (slug: string) => void }): NodeClient {
  const store = new Map<string, Record<string, unknown>>();
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
    async createRecord({ fields, keyHash }) {
      store.set(keyHash, fields);
    },
    async updateRecord({ fields, keyHash }) {
      store.set(keyHash, { ...store.get(keyHash), ...fields });
    },
    async deleteRecord({ keyHash }) {
      store.delete(keyHash);
    },
    async queryAll({ filter }): Promise<QueryResponse> {
      const f = filter as QueryFilter | undefined;
      if (f && typeof f === "object" && "HashKey" in f && typeof f.HashKey === "string") {
        opts?.onCardHashKey?.(f.HashKey);
        const fields = store.get(f.HashKey);
        const results: QueryRow[] = fields
          ? [{ fields, key: { hash: f.HashKey, range: null } }]
          : [];
        return { ok: true, results, returned_count: results.length, total_count: results.length };
      }
      return { ok: true, results: [], returned_count: 0, total_count: 0 };
    },
    rawCall: notImpl("rawCall") as NodeClient["rawCall"],
    nodeTransport: () => ({ transport: "unavailable" as const }),
  };
}

describe("listDependencyStatusesForCards knownCards seed", () => {
  test("same-board deps in knownCards never hit Card HashKey", async () => {
    const pointReads: string[] = [];
    const node = fakeNode({ onCardHashKey: (s) => pointReads.push(s) });
    const dep = card({ slug: "dep-done", column: "done", deps: [] });
    const parent = card({ slug: "parent", column: "todo", deps: ["dep-done"] });
    // Seed whole board partition (including dep) — list path after this fix.
    const boardPart = [parent, dep];
    const out = await listDependencyStatusesForCards(node, cfg, [parent], boardPart);
    expect(pointReads).toEqual([]);
    expect(out.some((c) => c.slug === "dep-done")).toBe(true);
  });

  test("unknown dep still point-reads Card", async () => {
    const pointReads: string[] = [];
    const node = fakeNode({ onCardHashKey: (s) => pointReads.push(s) });
    await node.createRecord({
      schemaHash: "cardhash",
      keyHash: "other-board-dep",
      fields: {
        slug: "other-board-dep",
        title: "x",
        board: "other",
        column: "done",
        position: "1",
        tags: [],
        deps: [],
        body: "",
      },
    });
    const parent = card({ slug: "parent", column: "todo", deps: ["other-board-dep"] });
    const out = await listDependencyStatusesForCards(node, cfg, [parent], [parent]);
    expect(pointReads).toEqual(["other-board-dep"]);
    expect(out.some((c) => c.slug === "other-board-dep")).toBe(true);
  });
});
