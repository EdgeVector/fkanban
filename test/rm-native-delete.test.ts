import { describe, expect, test } from "bun:test";

import { rmCmd } from "../src/commands/rm.ts";
import { FkanbanError, type NodeClient, type QueryFilter, type QueryResponse } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { cardToFields, emptyStructuredFields, type Card } from "../src/record.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash" },
};

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

type Delete = { schemaHash: string; keyHash: string };

function fakeNode(opts: { cards: Card[]; deletes: Delete[] }): NodeClient {
  const cardRows = opts.cards.map((c) => ({ fields: cardToFields(c), key: { hash: c.slug, range: null } }));
  const stub = () => {
    throw new Error("not implemented in fake node");
  };
  return {
    baseUrl: "http://fake",
    userHash: "test-user",
    autoIdentity: stub as never,
    bootstrap: stub as never,
    loadSchemas: stub as never,
    listSchemas: stub as never,
    createRecord: stub as never,
    updateRecord: stub as never,
    rawCall: stub as never,
    nodeTransport: stub as never,
    async deleteRecord(d) {
      opts.deletes.push(d);
    },
    async queryAll(q: { schemaHash: string; fields: string[]; filter?: QueryFilter }): Promise<QueryResponse> {
      let rows = q.schemaHash === "cardhash" ? cardRows : [];
      if (q.filter?.HashKey) rows = rows.filter((r) => r.key.hash === q.filter!.HashKey);
      return { ok: true, results: rows };
    },
  };
}

describe("rm native delete", () => {
  test("deletes the card using the native delete mutation and reports orphaned dependents", async () => {
    const deletes: Delete[] = [];
    const node = fakeNode({
      cards: [card({ slug: "api" }), card({ slug: "ui", deps: ["api"] }), card({ slug: "docs" })],
      deletes,
    });

    const res = await rmCmd({ cfg, node, slug: "api" });

    expect(res).toEqual({ slug: "api", orphanedDependents: ["ui"] });
    expect(deletes).toEqual([{ schemaHash: "cardhash", keyHash: "api" }]);
  });

  test("missing cards still raise card_not_found before any delete", async () => {
    const deletes: Delete[] = [];
    const node = fakeNode({ cards: [], deletes });

    const err = await rmCmd({ cfg, node, slug: "ghost" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FkanbanError);
    expect((err as FkanbanError).code).toBe("card_not_found");
    expect(deletes).toHaveLength(0);
  });
});
