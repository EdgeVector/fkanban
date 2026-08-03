// Contract tests for fkanban's vendored @lastdb/app-sdk.
//
// These assert on the SDK boundary fkanban does not own. A stale re-vendor can
// keep callers type-correct while silently dropping `where` pushdown or looping
// over an unstable page cursor; both regressions show up only as LastDB load.

import { describe, expect, test } from "bun:test";
import {
  LastDbClient,
  QueryPaginationError,
  parseQueryResponse,
  type Transport,
} from "@lastdb/app-sdk";

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

  // The node stopped counting partitions it does not need to count (fold
  // 800c03f3): for a key-restricted read with no cursor and no `Desc` sort —
  // every fkanban product read — it answers `total_count: null` while
  // `has_more` and `next_cursor` stay authoritative.
  //
  // A parser that demands a numeric `total_count` throws away the WHOLE page
  // object for those reads, which is not a type error and not a crash: the
  // drain quietly falls back to guessing "more rows?" from page width, and a
  // page shortened by an unhydratable row ends it early. That is the exact
  // failure mode this file exists to catch — a stale re-vendor that keeps
  // callers type-correct and loses rows.
  test("keeps page metadata when the node declines to count the partition", () => {
    const parsed = parseQueryResponse({
      ok: true,
      schema: SCHEMA,
      results: [],
      returned_count: 0,
      total_count: null,
      limit: 1000,
      offset: 0,
      has_more: true,
      next_cursor: { hash: "default", range: "todo#5" },
      unresolved_rows: 2,
    });

    expect(parsed.page).not.toBeNull();
    expect(parsed.page?.hasMore).toBe(true);
    expect(parsed.page?.nextCursor).toEqual({ hash: "default", range: "todo#5" });
    // Absent, not zero: a skipped count must never read as an empty partition.
    expect(parsed.page?.totalCount).toBeUndefined();
  });

  // Version-neutrality: a node that DOES count must still report the number.
  test("still surfaces an exact count when the node ran one", () => {
    const parsed = parseQueryResponse({
      ok: true,
      schema: SCHEMA,
      results: [],
      returned_count: 0,
      total_count: 42,
      limit: 1000,
      offset: 0,
      has_more: false,
      next_cursor: null,
    });

    expect(parsed.page?.totalCount).toBe(42);
  });
});
