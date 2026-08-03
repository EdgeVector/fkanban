// NodeClient wire-level tests against a stub HTTP server — verify the keyed
// point-read filter goes out on the wire and that every request has a deadline.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FkanbanError, newNodeClient, type NodeClient } from "../src/client.ts";
import { findCard } from "../src/record.ts";
import type { Config } from "../src/config.ts";
import { addCmd } from "../src/commands/add.ts";

type SeenRequest = { path: string; body: unknown; headers: Headers };

const seen: SeenRequest[] = [];

// Per-suite hit counters for the busy-503 retry routes. `/busy-twice` returns a
// transient busy-503 on its first two query hits then 200; `/busy-always` always
// returns a transient busy-503; `/busy-not-provisioned` always returns the
// NON-transient node_not_provisioned 503 (must NOT be retried).
const busyHits = { twice: 0, always: 0, notProvisioned: 0 };

// Per-suite hit counters for the client-side DEADLINE retry routes. These stall
// past the caller's deadline rather than answering 503 — the shape a node under
// real load actually produces once it is too busy to reply at all.
// `/timeout-twice` stalls on its first two hits then answers 200;
// `/timeout-mutation` always stalls (a WRITE must never be auto-retried).
const timeoutHits = { query: 0, mutation: 0 };

// Paging fixtures: a 5-row result set served two rows per page.
const PAGE_ROWS = [0, 1, 2, 3, 4].map((i) => ({
  fields: { slug: `r${i}` },
  key: { hash: `r${i}`, range: null },
}));
// The cursor the unhonored-cursor stub keeps handing back unchanged.
const STUCK_CURSOR = { hash: "last-stack", range: "stuck" };
const pagingHits = { unhonored: 0, full: 0, repeats: 0 };

// Production-shaped fixture: full 1000-row pages, 1251 rows total — the exact
// size of the LastgitCiStatus HashKey(last-stack) partition this was found on.
// Page size matters: a client that stops when a page is short never reaches the
// loop, so only a full-width page reproduces what the live node actually does.
const FULL_PAGE = 1000;
const FULL_ROWS = Array.from({ length: 1251 }, (_, i) => ({
  fields: { slug: `f${i}` },
  key: { hash: `f${i}`, range: null },
}));

// Stub node: records every request; /api/query echoes one card row when a
// HashKey filter matches, an empty page otherwise; /slow never answers in time.
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = req.method === "POST" ? await req.json() : undefined;
    seen.push({ path: url.pathname, body, headers: req.headers });
    if (url.pathname === "/slow/api/query") {
      await new Promise((r) => setTimeout(r, 5_000));
      return Response.json({ ok: true, results: [] });
    }
    // Flush response headers immediately, then stall forever mid-body. This is
    // the cold-schema-init failure mode: the node accepts the request and
    // returns headers fast, then hangs while streaming the body. A fetch-only
    // timeout does NOT cover this — the deadline must also bound the body read.
    if (url.pathname === "/headers-then-stall/api/query") {
      const stream = new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(new TextEncoder().encode('{"ok":true,'));
          // never enqueue the rest, never close → body read hangs
        },
      });
      return new Response(stream, {
        headers: { "Content-Type": "application/json" },
      });
    }
    // A node too busy to answer AT ALL: stalls past the caller's deadline on
    // the first two hits, then answers normally. This is the same backpressure
    // as a busy-503, one notch worse — the node never got a reply out.
    if (url.pathname === "/timeout-twice/api/query") {
      timeoutHits.query += 1;
      if (timeoutHits.query <= 1) await new Promise((r) => setTimeout(r, 5_000));
      return Response.json({ ok: true, results: [] });
    }
    // A WRITE that always stalls. A timed-out mutation may still be in flight
    // and may still land, so it must surface — never silently re-send.
    if (url.pathname === "/timeout-mutation/api/mutation") {
      timeoutHits.mutation += 1;
      await new Promise((r) => setTimeout(r, 5_000));
      return Response.json({ ok: true });
    }
    // Transient backpressure that clears: busy-503 (with the node's own
    // "retry after Ns" directive) on the first two hits, then a normal 200.
    if (url.pathname === "/busy-twice/api/query") {
      busyHits.twice += 1;
      if (busyHits.twice <= 2) {
        // A small "retry after" hint so the test exercises hint-honoring
        // (capped at 5s in prod) without waiting real seconds.
        return Response.json(
          { error: "service_unavailable", message: "node is busy: too many concurrent reads; retry after 0.25s" },
          { status: 503 },
        );
      }
      return Response.json({ ok: true, results: [], has_more: false });
    }
    // A node that never clears: every hit is a transient busy-503. No explicit
    // "retry after" hint here, so the client falls back to its bounded
    // exponential backoff (250/500/1000ms) — fast enough for a unit test.
    if (url.pathname === "/busy-always/api/query") {
      busyHits.always += 1;
      return Response.json(
        { error: "service_unavailable", message: "node is busy: too many concurrent reads" },
        { status: 503 },
      );
    }
    // A NON-transient 503: node not set up. Must NOT be retried.
    if (url.pathname === "/busy-not-provisioned/api/query") {
      busyHits.notProvisioned += 1;
      return Response.json({ error: "node_not_provisioned" }, { status: 503 });
    }
    if (url.pathname === "/good-audit/api/apps/declare-schema") {
      return Response.json({
        app_id: "fkanban",
        schema: "fkanban/Card",
        canonical: "catalog-card-hash",
        resolution: "reuse",
        audit_event_id: "schema-sync-123",
        bind_eligible: true,
      });
    }
    if (url.pathname === "/bad-audit/api/apps/declare-schema") {
      return Response.json({
        app_id: "fkanban",
        schema: "fkanban/Card",
        canonical: "catalog-card-hash",
        resolution: "reuse",
        bind_eligible: false,
      });
    }
    if (url.pathname === "/legacy-audit/api/apps/declare-schema") {
      return Response.json({
        app_id: "fkanban",
        schema: "fkanban/Card",
        canonical: "catalog-card-hash",
        resolution: "reuse",
      });
    }
    // Paging stubs. PAGE_ROWS is the whole logical result set; each stub serves
    // it two rows at a time so the drain has to page.
    if (url.pathname.startsWith("/paging-")) {
      const b = body as Record<string, unknown>;
      const page = (from: number, nextCursor: unknown) =>
        Response.json({
          ok: true,
          results: PAGE_ROWS.slice(from, from + 2),
          returned_count: Math.min(2, Math.max(0, PAGE_ROWS.length - from)),
          total_count: PAGE_ROWS.length,
          offset: from,
          limit: b.limit,
          has_more: from + 2 < PAGE_ROWS.length,
          next_cursor: from + 2 < PAGE_ROWS.length ? nextCursor : null,
        });

      // Reproduces the live primary: `/api/query` stamps a next_cursor onto a
      // key-restricted read it cannot honor, and handing that cursor back
      // re-serves page 1 verbatim with the same cursor. Verified on
      // LastgitCiStatus HashKey(last-stack), 1251 rows.
      if (url.pathname === "/paging-unhonored-cursor/api/query") {
        pagingHits.unhonored += 1;
        // Backstop so a cursor-preferring (pre-fix) client fails fast and
        // deterministically instead of looping to its million-row cap.
        if (pagingHits.unhonored > 12) {
          return Response.json({
            ok: true,
            results: [],
            returned_count: 0,
            total_count: PAGE_ROWS.length,
            has_more: false,
            next_cursor: null,
          });
        }
        const from = b.cursor !== undefined ? 0 : Number(b.offset ?? 0);
        return page(from, STUCK_CURSOR);
      }

      // A node that genuinely honors cursors: the cursor carries the next row
      // index and advances. The guard must NOT fire here.
      if (url.pathname === "/paging-advancing-cursor/api/query") {
        const cur = b.cursor as { hash: string; range: string } | undefined;
        const from = cur !== undefined ? Number(cur.range) : Number(b.offset ?? 0);
        return page(from, { hash: "h", range: String(from + 2) });
      }

      // A node that never advertises a cursor at all — pure offset paging.
      if (url.pathname === "/paging-offset-only/api/query") {
        return page(Number(b.offset ?? 0), null);
      }

      // The live primary's FULL-SCAN offset paging, measured 2026-08-03 on the
      // Card schema (`scripts/probe-scan-duplicate-locus.ts`):
      //
      //   page 1      537 rows, 373 distinct — 164 duplicates INSIDE one page
      //   pages 2-18  1002 rows, ZERO new slugs between them
      //   has_more    true throughout; total_count claims 1502
      //
      // i.e. every page past the first re-serves rows already delivered, and
      // the node keeps claiming there is more. Modelled here at test scale:
      // page 1 carries the whole distinct set PLUS an in-page duplicate, and
      // every later offset re-serves a slice of the same rows, forever.
      if (url.pathname === "/paging-offset-repeats/api/query") {
        pagingHits.repeats += 1;
        // Backstop so a pre-fix client fails fast and deterministically rather
        // than looping to its row cap and timing the suite out.
        if (pagingHits.repeats > 40) {
          return Response.json({
            ok: true,
            results: [],
            returned_count: 0,
            total_count: 99,
            has_more: false,
            next_cursor: null,
          });
        }
        const results = pagingHits.repeats === 1
          ? [...PAGE_ROWS, PAGE_ROWS[0]!] // 6 rows, 5 distinct
          : PAGE_ROWS.slice(0, 2); // pure repeat: rows the client already has
        return Response.json({
          ok: true,
          results,
          returned_count: results.length,
          // Claims far more rows than it will ever serve distinctly — the
          // reason `has_more` alone can never terminate this drain.
          total_count: 99,
          offset: Number(b.offset ?? 0),
          limit: b.limit,
          has_more: true,
          next_cursor: null,
        });
      }

      // Same unhonored-cursor behaviour, at the real node's page width.
      if (url.pathname === "/paging-unhonored-cursor-full/api/query") {
        pagingHits.full += 1;
        if (pagingHits.full > 12) {
          return Response.json({
            ok: true,
            results: [],
            returned_count: 0,
            total_count: FULL_ROWS.length,
            has_more: false,
            next_cursor: null,
          });
        }
        const from = b.cursor !== undefined ? 0 : Number(b.offset ?? 0);
        const slice = FULL_ROWS.slice(from, from + FULL_PAGE);
        const more = from + FULL_PAGE < FULL_ROWS.length;
        return Response.json({
          ok: true,
          results: slice,
          returned_count: slice.length,
          total_count: FULL_ROWS.length,
          offset: from,
          limit: b.limit,
          has_more: more,
          next_cursor: more ? STUCK_CURSOR : null,
        });
      }
    }
    if (url.pathname === "/api/query") {
      const filter = (body as Record<string, unknown>).filter as { HashKey?: string } | undefined;
      const results =
        filter?.HashKey === "my-card"
          ? [
              {
                fields: {
                  slug: "my-card",
                  title: "My card",
                  body: "spec",
                  board: "default",
                  column: "todo",
                  position: "10",
                  assignee: "",
                  tags: [],
                  created_at: "2026-01-01T00:00:00.000Z",
                  updated_at: "2026-01-01T00:00:00.000Z",
                },
                key: { hash: "my-card", range: null },
              },
            ]
          : [];
      return Response.json({ ok: true, results, has_more: false });
    }
    if (url.pathname === "/api/app/search") {
      return Response.json({
        ok: true,
        results: [
          {
            key: { hash: "my-card", range: null },
            fields: { slug: "my-card", title: "My card" },
            metadata: null,
            author_pub_key: "PUBKEY",
            schema_name: "cardhash",
            schema_display_name: "fkanban/Card",
            score: 0.92,
          },
        ],
      });
    }
    return Response.json({ error: "unexpected_path" }, { status: 500 });
  },
});

afterAll(() => server.stop(true));

const baseUrl = `http://127.0.0.1:${server.port}`;

const cfg: Config = {
  configVersion: 1,
  nodeUrl: baseUrl,
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash" },
};

describe("queryAll paging", () => {
  const slugs = (res: { results: { fields: Record<string, unknown> }[] }) =>
    res.results.map((r) => r.fields.slug);

  test("an unhonored next_cursor falls back to offset instead of looping", async () => {
    const node = newNodeClient({ baseUrl: `${baseUrl}/paging-unhonored-cursor`, userHash: "test-user" });
    const before = seen.length;
    const res = await node.queryAll({ schemaHash: "cardhash", fields: ["slug"] });

    // Every row exactly once, in order — no duplicated page, nothing dropped.
    expect(slugs(res)).toEqual(["r0", "r1", "r2", "r3", "r4"]);

    // And it got there in a handful of requests, not a ~1000-request loop.
    const reqs = seen.slice(before).filter((r) => r.path.endsWith("/api/query"));
    expect(reqs.length).toBeLessThanOrEqual(5);

    // The stall is detected once; every later page is requested by offset.
    const afterStall = reqs.slice(2);
    expect(afterStall.length).toBeGreaterThan(0);
    for (const r of afterStall) {
      expect((r.body as Record<string, unknown>).cursor).toBeUndefined();
      expect((r.body as Record<string, unknown>).offset).toBeDefined();
    }
  });

  test("an offset page that adds no new row ends the drain, without changing the result", async () => {
    const node = newNodeClient({ baseUrl: `${baseUrl}/paging-offset-repeats`, userHash: "test-user" });
    const before = seen.length;
    const res = await node.queryAll({ schemaHash: "cardhash", fields: ["slug"] });

    // THE POINT OF THE TEST: the guard is set-preserving. The drain already
    // de-dups on the way out, so every row the caller could ever have seen is
    // still here — stopping early only stops paying for repeats. Asserting the
    // rows, not just the request count, is what makes this a correctness test
    // rather than a performance one.
    expect(slugs(res)).toEqual(["r0", "r1", "r2", "r3", "r4"]);

    // Page 1 carries the whole distinct set; page 2 is the first that adds
    // nothing, so the drain stops there. Live, this is 18 requests -> 2.
    const reqs = seen.slice(before).filter((r) => r.path.endsWith("/api/query"));
    expect(reqs.length).toBe(2);

    // Every request went by offset — this is the offset path, not the cursor
    // path whose guard already existed.
    for (const r of reqs) {
      expect((r.body as Record<string, unknown>).offset).toBeDefined();
      expect((r.body as Record<string, unknown>).cursor).toBeUndefined();
    }
  });

  test("a node paging correctly never trips the no-progress guard", async () => {
    // The guard must be version-neutral: against a node whose offsets advance,
    // every page brings new rows, so nothing stops early. Without this, the
    // guard could silently truncate a healthy drain and the test above would
    // still pass.
    const node = newNodeClient({ baseUrl: `${baseUrl}/paging-offset-only`, userHash: "test-user" });
    const res = await node.queryAll({ schemaHash: "cardhash", fields: ["slug"] });
    expect(slugs(res)).toEqual(["r0", "r1", "r2", "r3", "r4"]);
  });

  test("full-width pages: the drain terminates with every row, exactly once", async () => {
    const node = newNodeClient({
      baseUrl: `${baseUrl}/paging-unhonored-cursor-full`,
      userHash: "test-user",
    });
    const before = seen.length;
    const res = await node.queryAll({ schemaHash: "cardhash", fields: ["slug"] });

    // 1251 rows, no duplicates — the shape a cursor-preferring client cannot
    // reach: it re-serves page 1 forever and blows past the row cap instead.
    expect(res.results).toHaveLength(FULL_ROWS.length);
    expect(new Set(res.results.map((r) => r.fields.slug)).size).toBe(FULL_ROWS.length);
    expect(res.results[0]!.fields.slug).toBe("f0");
    expect(res.results.at(-1)!.fields.slug).toBe("f1250");

    const reqs = seen.slice(before).filter((r) => r.path.endsWith("/api/query"));
    expect(reqs.length).toBeLessThanOrEqual(4);
  });

  test("a cursor that advances is still used as a cursor", async () => {
    const node = newNodeClient({ baseUrl: `${baseUrl}/paging-advancing-cursor`, userHash: "test-user" });
    const before = seen.length;
    const res = await node.queryAll({ schemaHash: "cardhash", fields: ["slug"] });

    expect(slugs(res)).toEqual(["r0", "r1", "r2", "r3", "r4"]);

    // Version-neutrality: on a node that honors cursors the guard must not
    // fire, so pages after the first go out as cursors, not offsets.
    const reqs = seen.slice(before).filter((r) => r.path.endsWith("/api/query"));
    expect(reqs.length).toBe(3);
    expect((reqs[1]!.body as Record<string, unknown>).cursor).toEqual({ hash: "h", range: "2" });
    expect((reqs[2]!.body as Record<string, unknown>).cursor).toEqual({ hash: "h", range: "4" });
  });

  test("a node that never advertises a cursor pages by offset", async () => {
    const node = newNodeClient({ baseUrl: `${baseUrl}/paging-offset-only`, userHash: "test-user" });
    const before = seen.length;
    const res = await node.queryAll({ schemaHash: "cardhash", fields: ["slug"] });

    expect(slugs(res)).toEqual(["r0", "r1", "r2", "r3", "r4"]);
    const reqs = seen.slice(before).filter((r) => r.path.endsWith("/api/query"));
    expect(reqs.map((r) => (r.body as Record<string, unknown>).offset)).toEqual([0, 2, 4]);
  });
});

describe("queryAll filter", () => {
  test("passes a HashKey filter through to the /api/query body", async () => {
    const node = newNodeClient({ baseUrl, userHash: "test-user" });
    const res = await node.queryAll({
      schemaHash: "cardhash",
      fields: ["slug"],
      filter: { HashKey: "my-card" },
    });
    expect(res.results).toHaveLength(1);
    const last = seen.at(-1)!;
    expect(last.path).toBe("/api/query");
    expect((last.body as Record<string, unknown>).filter).toEqual({ HashKey: "my-card" });
  });

  test("omits the filter key entirely when none is given", async () => {
    const node = newNodeClient({ baseUrl, userHash: "test-user" });
    await node.queryAll({ schemaHash: "cardhash", fields: ["slug"] });
    const last = seen.at(-1)!;
    expect("filter" in (last.body as Record<string, unknown>)).toBe(false);
  });

  test("appId sends an app capability header so schema LINK mappings apply", async () => {
    const node = newNodeClient({ baseUrl, userHash: "test-user", appId: "fkanban" });
    await node.queryAll({ schemaHash: "Reference", fields: ["slug"] });
    const last = seen.at(-1)!;
    const header = last.headers.get("x-app-capability");
    expect(header).toBeTruthy();
    expect(last.headers.get("x-capability-ts")).toBeTruthy();
    const token = JSON.parse(Buffer.from(header!, "base64").toString("utf8")) as Record<string, unknown>;
    expect(token.app_id).toBe("fkanban");
    expect(token.scope).toEqual({ wildcard: "fkanban/*" });
  });

  test("allowFullScan sends the node's explicit admin full-scan header", async () => {
    const node = newNodeClient({ baseUrl, userHash: "test-user", appId: "fkanban" });
    await node.queryAll({ schemaHash: "cardhash", fields: ["slug"], allowFullScan: true });
    const last = seen.at(-1)!;
    expect(last.path).toBe("/api/query");
    expect(last.headers.get("x-lastdb-allow-full-scan")).toBe("1");
    expect((last.body as Record<string, unknown>).schema_name).toBe("cardhash");
    expect((last.body as Record<string, unknown>).limit).toBe(1000);
    expect(last.headers.get("x-app-capability")).toBeTruthy();
  });
});

describe("audited schema sync bind", () => {
  test("accepts a catalog sync carrying durable audit evidence", async () => {
    const node = newNodeClient({ baseUrl: `${baseUrl}/good-audit`, userHash: "test-user" });
    const result = await node.declareAppSchema!("fkanban", { name: "Card" });
    expect(result).toMatchObject({
      canonical: "catalog-card-hash",
      auditEventId: "schema-sync-123",
      bindEligible: true,
    });
  });

  test("accepts older Mini responses that omit audit metadata", async () => {
    const node = newNodeClient({ baseUrl: `${baseUrl}/legacy-audit`, userHash: "test-user" });
    const result = await node.declareAppSchema!("fkanban", { name: "Card" });
    expect(result).toMatchObject({
      canonical: "catalog-card-hash",
      bindEligible: true,
    });
    expect(result.auditEventId).toBeUndefined();
  });

  test("refuses an otherwise valid identity when Mini explicitly marks it ineligible", async () => {
    const node = newNodeClient({ baseUrl: `${baseUrl}/bad-audit`, userHash: "test-user" });
    await expect(node.declareAppSchema!("fkanban", { name: "Card" })).rejects.toMatchObject({
      code: "app_schema_declare_bad_response",
    });
  });
});

describe("search data path", () => {
  test("routes native-index compatibility calls through SDK /api/app/search", async () => {
    const node = newNodeClient({ baseUrl, userHash: "test-user" });
    const res = await node.rawCall("GET", "/api/native-index/search?q=spec&include_internal=true");
    expect(res.status).toBe(200);
    expect((res.json as { results: Array<{ key_value: { hash: string } }> }).results[0]!.key_value.hash).toBe("my-card");
    const last = seen.at(-1)!;
    expect(last.path).toBe("/api/app/search");
    expect(last.body).toMatchObject({ query: "spec", k: 50 });
  });
});

describe("findCard", () => {
  test("is a single keyed query, not a scan", async () => {
    const node = newNodeClient({ baseUrl, userHash: "test-user" });
    const before = seen.length;
    const card = await findCard(node, cfg, "my-card");
    expect(card?.slug).toBe("my-card");
    expect(seen.length).toBe(before + 1);
    expect((seen.at(-1)!.body as Record<string, unknown>).filter).toEqual({ HashKey: "my-card" });
  });

  test("returns null when the key has no record", async () => {
    const node = newNodeClient({ baseUrl, userHash: "test-user" });
    const card = await findCard(node, cfg, "no-such-card");
    expect(card).toBeNull();
  });

  test("does not fall back to a scan when the keyed point read hits a transport error", async () => {
    const calls: unknown[] = [];
    const fakeNode: NodeClient = {
      baseUrl: "http://fake.invalid",
      userHash: "test-user",
      autoIdentity: async () => ({ provisioned: true, userHash: "test-user" }),
      bootstrap: async () => ({ userHash: "test-user" }),
      loadSchemas: async () => ({ available_schemas_loaded: 0, schemas_loaded_to_db: 0, failed_schemas: [] }),
      listSchemas: async () => [],
      createRecord: async () => {},
      updateRecord: async () => {},
      deleteRecord: async () => {},
      rawCall: async () => ({ status: 200, headers: new Headers(), body: "", json: null }),
      nodeTransport: () => ({ transport: "unavailable" }),
      async queryAll(opts) {
        calls.push(opts);
        if (opts.filter !== undefined) {
          throw new FkanbanError({ code: "service_unreachable", message: "socket flaked" });
        }
        throw new Error("findCard must not scan after a point-read transport failure");
      },
    };

    await expect(findCard(fakeNode, cfg, "my-card")).rejects.toMatchObject({ code: "service_unreachable" });
    expect(calls).toHaveLength(1);
    expect((calls[0] as Record<string, unknown>).filter).toEqual({ HashKey: "my-card" });
  });
});

// Socket-first covers the node routes served by the owner data socket:
// `/api/query`, `/api/mutation`, `/api/system/auto-identity`, and
// `/api/schemas`. Routes outside that allowlist still go TCP unless the
// configured socket is the full-surface `folddb-full.sock`.
describe("socket-first covers owner data socket routes", () => {
  const sockDir = mkdtempSync(join(tmpdir(), "fkanban-sock-"));
  const socketPath = join(sockDir, "folddb.sock");

  // Records every request the UDS (socket) listener receives.
  const socketSeen: string[] = [];
  // Records every request the TCP listener receives (separate from the
  // module-level `seen` used by the other suites).
  const tcpSeen: string[] = [];

  // UDS listener: serves the owner-session mint (so attestation succeeds over
  // the socket), data-plane routes, and the schema/identity reads that the node
  // exposes on the owner data socket.
  const socketServer = Bun.serve({
    unix: socketPath,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      socketSeen.push(path);
      const body = req.method === "POST" ? await req.json().catch(() => undefined) : undefined;
      if (path === "/control/browser-pairing-code") {
        return Response.json({ pairing_code: "test-pairing-code" });
      }
      if (path === "/api/query") {
        const q = body as Record<string, unknown> | undefined;
        const filter = q?.filter as { HashKey?: string } | undefined;
        if (q?.schema_name === "boardhash" && filter?.HashKey === "default") {
          return Response.json({
            ok: true,
            results: [
              {
                fields: {
                  slug: "default",
                  title: "Default board",
                  body: "",
                  columns: ["backlog", "todo", "doing", "done"],
                  created_at: "2026-01-01T00:00:00.000Z",
                  updated_at: "2026-01-01T00:00:00.000Z",
                },
                key: { hash: "default", range: null },
              },
            ],
            has_more: false,
          });
        }
        return Response.json({ ok: true, results: [], has_more: false });
      }
      if (path === "/api/mutation") return Response.json({ ok: true });
      if (path === "/api/system/auto-identity") {
        return Response.json({ user_hash: "test-user" });
      }
      if (path === "/api/schemas") return Response.json({ ok: true, schemas: [] });
      return Response.json({ error: "not_found_on_data_plane_socket" }, { status: 404 });
    },
  });

  // TCP listener: serves the pairing-code exchange. Owner data socket routes
  // should not reach it when the socket exists.
  const tcpServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      tcpSeen.push(path);
      if (path === "/api/session/browser-pair") {
        return Response.json({ session_token: "test-session-token" });
      }
      if (path === "/api/mutation" || path === "/api/query") {
        // Socket-eligible routes over TCP would be the bug; answer so the
        // assertion can fail loudly on tcpSeen rather than on a thrown error.
        return Response.json({ ok: true, results: [], has_more: false });
      }
      return Response.json({ error: "unexpected_tcp_path" }, { status: 500 });
    },
  });

  const tcpUrl = `http://127.0.0.1:${tcpServer.port}`;

  afterAll(() => {
    socketServer.stop(true);
    tcpServer.stop(true);
    rmSync(sockDir, { recursive: true, force: true });
  });

  test("the socket file actually exists for this suite", () => {
    expect(existsSync(socketPath)).toBe(true);
  });

  test("data-plane /api/query goes over the socket, not TCP", async () => {
    const node = newNodeClient({ baseUrl: tcpUrl, userHash: "test-user", socketPath });
    const before = tcpSeen.length;
    await node.queryAll({ schemaHash: "cardhash", fields: ["slug"] });
    expect(socketSeen).toContain("/api/query");
    // /api/query must NOT have hit the TCP listener.
    expect(tcpSeen.slice(before)).not.toContain("/api/query");
  });

  test("data-plane /api/mutation goes over the socket, not TCP", async () => {
    const node = newNodeClient({ baseUrl: tcpUrl, userHash: "test-user", socketPath });
    const before = tcpSeen.length;
    await node.createRecord({ schemaHash: "cardhash", fields: { slug: "x" }, keyHash: "x" });
    expect(socketSeen).toContain("/api/mutation");
    expect(tcpSeen.slice(before)).not.toContain("/api/mutation");
  });

  test("add create reads and writes cards over the socket when TCP is down", async () => {
    const node = newNodeClient({ baseUrl: tcpUrl, userHash: "test-user", socketPath });
    const beforeSocket = socketSeen.length;
    const beforeTcp = tcpSeen.length;
    const res = await addCmd({
      cfg,
      node,
      slug: "socket-add-card",
      title: "Socket add card",
      column: "backlog",
    });

    expect(res).toMatchObject({ slug: "socket-add-card", action: "created", board: "default", column: "backlog" });
    expect(socketSeen.slice(beforeSocket)).toContain("/api/query");
    expect(socketSeen.slice(beforeSocket)).toContain("/api/mutation");
    expect(tcpSeen.slice(beforeTcp)).not.toContain("/api/query");
    expect(tcpSeen.slice(beforeTcp)).not.toContain("/api/mutation");
  });

  test("system /api/system/auto-identity goes over the socket, not TCP", async () => {
    const node = newNodeClient({ baseUrl: tcpUrl, userHash: "test-user", socketPath });
    const beforeSocket = socketSeen.length;
    const beforeTcp = tcpSeen.length;
    const res = await node.autoIdentity();
    expect(res.provisioned).toBe(true);
    expect(socketSeen.slice(beforeSocket)).toContain("/api/system/auto-identity");
    expect(tcpSeen.slice(beforeTcp)).not.toContain("/api/system/auto-identity");
  });

  test("schema route /api/schemas goes over the socket, not TCP", async () => {
    const node = newNodeClient({ baseUrl: tcpUrl, userHash: "test-user", socketPath });
    const beforeSocket = socketSeen.length;
    const beforeTcp = tcpSeen.length;
    await node.listSchemas();
    expect(socketSeen.slice(beforeSocket)).toContain("/api/schemas");
    expect(tcpSeen.slice(beforeTcp)).not.toContain("/api/schemas");
  });

  test("nodeTransport() still reports socket when the socket exists", () => {
    const node = newNodeClient({ baseUrl: tcpUrl, userHash: "test-user", socketPath });
    const t = node.nodeTransport();
    expect(t.transport).toBe("socket");
    expect(t.socketPath).toBe(socketPath);
  });

  test("nodeTransport() reports 'unavailable' (not 'tcp') when the socket file is missing", () => {
    // Local nodes are socket-only — a missing socket means requests will fail,
    // not that TCP takes over. The label must say so, since `fkanban doctor`
    // surfaces it to users.
    const missingSocket = join(mkdtempSync(join(tmpdir(), "fkanban-nosock-")), "folddb.sock");
    const node = newNodeClient({ baseUrl: tcpUrl, userHash: "test-user", socketPath: missingSocket });
    const t = node.nodeTransport();
    expect(t.transport).toBe("unavailable");
    expect(t.socketPath).toBe(missingSocket);
  });
});

describe("folddb-full socket routes every node path over UDS", () => {
  test("non-allowlisted node routes use the full-surface socket instead of TCP", async () => {
    const sockDir = mkdtempSync(join(tmpdir(), "fkanban-full-sock-"));
    const socketPath = join(sockDir, "folddb-full.sock");
    const socketSeen: string[] = [];
    const tcpSeen: string[] = [];
    const socketServer = Bun.serve({
      unix: socketPath,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        socketSeen.push(path);
        if (path === "/control/browser-pairing-code") return Response.json({ pairing_code: "full-socket" });
        if (path === "/api/setup/bootstrap") return Response.json({ user_hash: "bootstrapped-user" });
        return Response.json({ error: "unexpected_socket_path", path }, { status: 500 });
      },
    });
    const tcpServer = Bun.serve({
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        tcpSeen.push(path);
        if (path === "/api/session/browser-pair") return Response.json({ session_token: "test-session-token" });
        return Response.json({ error: "unexpected_tcp_path", path }, { status: 500 });
      },
    });
    try {
      const node = newNodeClient({ baseUrl: `http://127.0.0.1:${tcpServer.port}`, userHash: "test-user", socketPath });
      await expect(node.bootstrap("Test User")).resolves.toEqual({ userHash: "bootstrapped-user" });
      expect(socketSeen).toContain("/api/setup/bootstrap");
      expect(tcpSeen).not.toContain("/api/setup/bootstrap");
    } finally {
      socketServer.stop(true);
      tcpServer.stop(true);
      rmSync(sockDir, { recursive: true, force: true });
    }
  });
});

describe("canonical folddb.sock full-surface collapse", () => {
  test("non-allowlisted routes use folddb.sock when no legacy full sibling exists", async () => {
    const sockDir = mkdtempSync("/tmp/fkanban-collapse-");
    const socketPath = join(sockDir, "folddb.sock");
    const socketSeen: string[] = [];
    const socketServer = Bun.serve({
      unix: socketPath,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        socketSeen.push(path);
        if (path === "/api/setup/bootstrap") return Response.json({ user_hash: "bootstrapped-user" });
        return Response.json({ error: "unexpected_socket_path", path }, { status: 500 });
      },
    });
    try {
      const node = newNodeClient({ baseUrl, userHash: "test-user", socketPath });
      await expect(node.bootstrap("Test User")).resolves.toEqual({ userHash: "bootstrapped-user" });
      expect(socketSeen).toContain("/api/setup/bootstrap");
    } finally {
      socketServer.stop(true);
      rmSync(sockDir, { recursive: true, force: true });
    }
  });

  test("legacy folddb-full.sock sibling still wins for setup routes", async () => {
    const sockDir = mkdtempSync("/tmp/fkanban-legacy-full-");
    const socketPath = join(sockDir, "folddb.sock");
    const fullSocketPath = join(sockDir, "folddb-full.sock");
    const fullSeen: string[] = [];
    const fullServer = Bun.serve({
      unix: fullSocketPath,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        fullSeen.push(path);
        if (path === "/api/setup/bootstrap") return Response.json({ user_hash: "legacy-user" });
        return Response.json({ error: "unexpected_socket_path", path }, { status: 500 });
      },
    });
    try {
      const node = newNodeClient({ baseUrl, userHash: "test-user", socketPath });
      await expect(node.bootstrap("Test User")).resolves.toEqual({ userHash: "legacy-user" });
      expect(fullSeen).toContain("/api/setup/bootstrap");
    } finally {
      fullServer.stop(true);
      rmSync(sockDir, { recursive: true, force: true });
    }
  });
});

describe("socket-only: no TCP fallback for a local node", () => {
  test("a loopback node whose socket cannot connect FAILS — it never dials TCP", async () => {
    // The loopback TCP listener is retired; a local node is socket-only. A
    // configured-but-dead socket must surface a node-not-running error, NOT a
    // silent fall-through to a TCP server listening on the same loopback host.
    const sockDir = mkdtempSync(join(tmpdir(), "fkanban-bad-sock-"));
    const badSocket = join(sockDir, "folddb.sock");
    writeFileSync(badSocket, "");
    const tcpSeen: string[] = [];
    const tcpServer = Bun.serve({
      port: 0,
      async fetch(req) {
        tcpSeen.push(new URL(req.url).pathname);
        return Response.json({ ok: true, results: [], has_more: false });
      },
    });

    try {
      const node = newNodeClient({
        baseUrl: `http://127.0.0.1:${tcpServer.port}`,
        userHash: "test-user",
        socketPath: badSocket,
      });
      let caught: unknown;
      try {
        await node.queryAll({ schemaHash: "cardhash", fields: ["slug"] });
      } catch (e) {
        caught = e;
      }
      // It errored over the socket, and the TCP server was NEVER contacted.
      expect(caught).toBeInstanceOf(FkanbanError);
      expect((caught as FkanbanError).code).toBe("service_unreachable");
      expect(tcpSeen).toEqual([]);
    } finally {
      tcpServer.stop(true);
      rmSync(sockDir, { recursive: true, force: true });
    }
  });

  test("an unreachable socket write names the mutation route", async () => {
    const sockDir = mkdtempSync(join(tmpdir(), "fkanban-bad-write-sock-"));
    const badSocket = join(sockDir, "folddb.sock");
    writeFileSync(badSocket, "");
    const tcpSeen: string[] = [];
    const tcpServer = Bun.serve({
      port: 0,
      async fetch(req) {
        tcpSeen.push(new URL(req.url).pathname);
        return Response.json({ ok: true });
      },
    });

    try {
      const node = newNodeClient({
        baseUrl: `http://127.0.0.1:${tcpServer.port}`,
        userHash: "test-user",
        socketPath: badSocket,
      });
      const err = await node
        .createRecord({ schemaHash: "cardhash", fields: { slug: "x" }, keyHash: "x" })
        .then(() => null)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(FkanbanError);
      expect((err as FkanbanError).code).toBe("service_unreachable");
      expect((err as FkanbanError).message).toContain("write route");
      expect((err as FkanbanError).message).toContain("POST /api/mutation");
      expect((err as FkanbanError).message).toContain(badSocket);
      expect(tcpSeen).toEqual([]);
    } finally {
      tcpServer.stop(true);
      rmSync(sockDir, { recursive: true, force: true });
    }
  });
});

describe("request deadline", () => {
  test("a hung node surfaces as service_timeout instead of hanging the CLI", async () => {
    const node = newNodeClient({ baseUrl: `${baseUrl}/slow`, userHash: "test-user", timeoutMs: 100 });
    const err = await node
      .queryAll({ schemaHash: "cardhash", fields: ["slug"] })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FkanbanError);
    expect((err as FkanbanError).code).toBe("service_timeout");
    expect((err as FkanbanError).hint).toContain("re-running the command is safe");
  });

  test("a node that returns headers then stalls mid-body still times out (not just the fetch)", async () => {
    const node = newNodeClient({
      baseUrl: `${baseUrl}/headers-then-stall`,
      userHash: "test-user",
      timeoutMs: 100,
    });
    const start = Date.now();
    const err = await node
      .queryAll({ schemaHash: "cardhash", fields: ["slug"] })
      .then(() => null)
      .catch((e: unknown) => e);
    // It must abort at the deadline, not hang on the unbounded body read.
    expect(Date.now() - start).toBeLessThan(3_000);
    expect(err).toBeInstanceOf(FkanbanError);
    expect((err as FkanbanError).code).toBe("service_timeout");
    expect((err as FkanbanError).hint).toContain("re-running the command is safe");
  });
});

describe("client-side deadline is backpressure too", () => {
  test("a READ that stalls past the deadline is retried and rides through", async () => {
    timeoutHits.query = 0;
    const node = newNodeClient({
      baseUrl: `${baseUrl}/timeout-twice`,
      userHash: "test-user",
      timeoutMs: 150,
    });
    const res = await node.queryAll({ schemaHash: "cardhash", fields: ["slug"] });
    expect(res.results).toEqual([]);
    // One deadline expiry + one success = two hits. A node too busy to reply
    // must not be treated more harshly than one that manages to say "I'm busy".
    expect(timeoutHits.query).toBe(2);
  });

  test("a read that never answers retries exactly once, then surfaces", async () => {
    const node = newNodeClient({ baseUrl: `${baseUrl}/slow`, userHash: "test-user", timeoutMs: 100 });
    const before = seen.filter((r) => r.path === "/slow/api/query").length;
    const err = await node
      .queryAll({ schemaHash: "cardhash", fields: ["slug"] })
      .then(() => null)
      .catch((e: unknown) => e);
    expect((err as FkanbanError).code).toBe("service_timeout");
    // Bounded: 1 initial + TIMEOUT_RETRY_MAX(1) = 2. A permanently hung node
    // must not multiply the caller's deadline without limit.
    expect(seen.filter((r) => r.path === "/slow/api/query").length - before).toBe(2);
  });

  test("a WRITE that stalls past the deadline is NOT retried — it may have landed", async () => {
    timeoutHits.mutation = 0;
    const node = newNodeClient({
      baseUrl: `${baseUrl}/timeout-mutation`,
      userHash: "test-user",
      timeoutMs: 150,
    });
    const err = await node
      .updateRecord({ schemaHash: "cardhash", keyHash: "c1", fields: { title: "x" } })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FkanbanError);
    expect((err as FkanbanError).code).toBe("service_timeout");
    // Exactly one attempt. Unlike a 503 (which the node REJECTED, so it
    // provably never applied), a timed-out mutation may still be in flight.
    expect(timeoutHits.mutation).toBe(1);
  });
});

describe("transient busy-503 backpressure retry", () => {
  test("rides through a busy-503 that clears: succeeds after retries", async () => {
    busyHits.twice = 0;
    const node = newNodeClient({ baseUrl: `${baseUrl}/busy-twice`, userHash: "test-user" });
    const start = Date.now();
    const res = await node.queryAll({ schemaHash: "cardhash", fields: ["slug"] });
    expect(res.results).toEqual([]);
    // Two busy rejections + one success = three hits.
    expect(busyHits.twice).toBe(3);
    // Backoff is bounded: two ~0.25s honored hints (+jitter) clear well under a
    // generous ceiling. Proves the wait is finite, not that it's instant.
    expect(Date.now() - start).toBeLessThan(4_000);
  });

  test("an always-busy node surfaces an accurate 'overloaded, re-run' error — NOT a 'node-side bug'", async () => {
    busyHits.always = 0;
    const node = newNodeClient({ baseUrl: `${baseUrl}/busy-always`, userHash: "test-user" });
    const err = await node
      .queryAll({ schemaHash: "cardhash", fields: ["slug"] })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FkanbanError);
    const fe = err as FkanbanError;
    expect(fe.code).toBe("node_overloaded");
    expect(fe.message.toLowerCase()).toContain("overloaded");
    expect(fe.hint).toContain("shedding load, not broken");
    // The misleading legacy hint must be gone.
    expect(`${fe.message} ${fe.hint ?? ""}`).not.toContain("node-side bug");
    // It retried the bounded number of times: 1 initial + BUSY_RETRY_MAX(3) = 4.
    expect(busyHits.always).toBe(4);
  });

  test("a node_not_provisioned 503 is NOT retried and still surfaces 'Run `kanban init`'", async () => {
    busyHits.notProvisioned = 0;
    const node = newNodeClient({ baseUrl: `${baseUrl}/busy-not-provisioned`, userHash: "test-user" });
    const err = await node
      .queryAll({ schemaHash: "cardhash", fields: ["slug"] })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FkanbanError);
    const fe = err as FkanbanError;
    expect(fe.code).toBe("node_not_provisioned");
    expect(fe.hint).toContain("kanban init");
    // Exactly one hit — no retry for the non-transient 503.
    expect(busyHits.notProvisioned).toBe(1);
  });
});
