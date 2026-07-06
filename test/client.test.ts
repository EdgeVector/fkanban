// NodeClient wire-level tests against a stub HTTP server — verify the keyed
// point-read filter goes out on the wire and that every request has a deadline.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FkanbanError, newNodeClient, type NodeClient } from "../src/client.ts";
import { findCard } from "../src/record.ts";
import type { Config } from "../src/config.ts";

type SeenRequest = { path: string; body: unknown };

const seen: SeenRequest[] = [];

// Per-suite hit counters for the busy-503 retry routes. `/busy-twice` returns a
// transient busy-503 on its first two query hits then 200; `/busy-always` always
// returns a transient busy-503; `/busy-not-provisioned` always returns the
// NON-transient node_not_provisioned 503 (must NOT be retried).
const busyHits = { twice: 0, always: 0, notProvisioned: 0 };

// Stub node: records every request; /api/query echoes one card row when a
// HashKey filter matches, an empty page otherwise; /slow never answers in time.
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = req.method === "POST" ? await req.json() : undefined;
    seen.push({ path: url.pathname, body });
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

  test("falls back to a scan when the keyed point read hits a transport error", async () => {
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
        return {
          ok: true,
          results: [
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
          ],
        };
      },
    };

    const card = await findCard(fakeNode, cfg, "my-card");
    expect(card?.slug).toBe("my-card");
    expect(calls).toHaveLength(2);
    expect((calls[0] as Record<string, unknown>).filter).toEqual({ HashKey: "my-card" });
    expect("filter" in (calls[1] as Record<string, unknown>)).toBe(false);
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
      if (path === "/control/browser-pairing-code") {
        return Response.json({ pairing_code: "test-pairing-code" });
      }
      if (path === "/api/query") return Response.json({ ok: true, results: [], has_more: false });
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

  test("a node_not_provisioned 503 is NOT retried and still surfaces 'Run `fkanban init`'", async () => {
    busyHits.notProvisioned = 0;
    const node = newNodeClient({ baseUrl: `${baseUrl}/busy-not-provisioned`, userHash: "test-user" });
    const err = await node
      .queryAll({ schemaHash: "cardhash", fields: ["slug"] })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FkanbanError);
    const fe = err as FkanbanError;
    expect(fe.code).toBe("node_not_provisioned");
    expect(fe.hint).toContain("fkanban init");
    // Exactly one hit — no retry for the non-transient 503.
    expect(busyHits.notProvisioned).toBe(1);
  });
});
