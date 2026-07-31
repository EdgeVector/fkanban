// Contract tests for fkanban's vendored @lastdb/app-sdk.
//
// These assert on the SDK boundary fkanban does not own. A stale re-vendor can
// keep callers type-correct while silently dropping `where` pushdown or looping
// over an unstable page cursor; both regressions show up only as LastDB load.

import { describe, expect, test } from "bun:test";
import { LastDbClient, QueryPaginationError, type Transport } from "@lastdb/app-sdk";

const SCHEMA = "fkanban/Card";

function clientWithCapturedBodies(
  responses: Array<Record<string, unknown>> = [
    { ok: true, results: [], returned_count: 0, total_count: 0, limit: 100, offset: 0, has_more: false },
  ],
): {
  client: LastDbClient;
  bodies: Record<string, unknown>[];
} {
  const bodies: Record<string, unknown>[] = [];
  const transport: Transport = {
    target: "http://lastdb.test",
    async send(_method, _path, options) {
      bodies.push((options?.body ?? {}) as Record<string, unknown>);
      return {
        status: 200,
        body: responses[Math.min(bodies.length - 1, responses.length - 1)] ?? responses[responses.length - 1],
      };
    },
  };
  const noopStore = {
    async store(): Promise<void> {},
    async load(): Promise<null> {
      return null;
    },
    async remove(): Promise<void> {},
  };
  const client = new LastDbClient(
    "fkanban",
    transport,
    noopStore,
    null,
    "fkanban",
    "http://lastdb.test",
  );
  return { client, bodies };
}

describe("vendored @lastdb/app-sdk", () => {
  test("forwards a two-pass `where` predicate onto the query wire body", async () => {
    const { client, bodies } = clientWithCapturedBodies();

    await client.query(SCHEMA, {
      fields: ["slug", "column"],
      filter: { HashKey: "default" },
      where: [{ eq: { field: "column", value: "todo" } }],
    });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toHaveProperty("where");
    expect(bodies[0]!.where).toEqual([{ eq: { field: "column", value: "todo" } }]);
    expect(bodies[0]!.filter).toEqual({ HashKey: "default" });
  });

  test("omits `where` entirely when the caller passes none", async () => {
    const { client, bodies } = clientWithCapturedBodies();

    await client.query(SCHEMA, { fields: ["slug"], filter: { HashKey: "default" } });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty("where");
  });

  test("queryAll throws when a follow-up page makes no unique progress", async () => {
    const duplicateRow = {
      key: { hash: "default", range: "card-1" },
      fields: { slug: "card-1" },
      metadata: null,
    };
    const { client } = clientWithCapturedBodies([
      {
        ok: true,
        results: [duplicateRow],
        returned_count: 1,
        total_count: 2,
        limit: 1,
        offset: 0,
        has_more: true,
        next_cursor: { hash: "default", range: "stuck" },
      },
      {
        ok: true,
        results: [duplicateRow],
        returned_count: 1,
        total_count: 2,
        limit: 1,
        offset: 0,
        has_more: true,
        next_cursor: { hash: "default", range: "stuck" },
      },
    ]);

    await expect(
      client.queryAll(SCHEMA, { filter: { HashKey: "default" } }, { pageSize: 1 }),
    ).rejects.toBeInstanceOf(QueryPaginationError);
  });
});
