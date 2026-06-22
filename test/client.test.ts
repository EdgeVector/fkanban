// NodeClient wire-level tests against a stub HTTP server — verify the keyed
// point-read filter goes out on the wire and that every request has a deadline.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FkanbanError, newNodeClient } from "../src/client.ts";
import { findCard } from "../src/record.ts";
import type { Config } from "../src/config.ts";

type SeenRequest = { path: string; body: unknown };

const seen: SeenRequest[] = [];

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
});

// Socket-first is DATA-PLANE-ONLY: the fold#1004-discovered node socket serves
// `/api/query`+`/api/mutation` but 404s every system/identity/schema route, so
// the client must route data-plane calls over the socket and ALL other
// `service: node` routes over TCP — even though the socket file exists. We prove
// the selection by which transport (UDS server vs TCP server) actually receives
// each request.
describe("socket-first is data-plane-only", () => {
  const sockDir = mkdtempSync(join(tmpdir(), "fkanban-sock-"));
  const socketPath = join(sockDir, "folddb.sock");

  // Records every request the UDS (socket) listener receives.
  const socketSeen: string[] = [];
  // Records every request the TCP listener receives (separate from the
  // module-level `seen` used by the other suites).
  const tcpSeen: string[] = [];

  // UDS listener: serves the owner-session mint (so attestation succeeds over
  // the socket) and the data-plane routes. If a system route ever reaches it,
  // it answers 404 (mirroring the real data-plane socket) so the test would
  // observe the wrong-transport hit rather than silently passing.
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
      return Response.json({ error: "not_found_on_data_plane_socket" }, { status: 404 });
    },
  });

  // TCP listener: serves the pairing-code exchange and the SYSTEM/identity/schema
  // routes that must NOT use the socket.
  const tcpServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      tcpSeen.push(path);
      if (path === "/api/session/browser-pair") {
        return Response.json({ session_token: "test-session-token" });
      }
      if (path === "/api/system/auto-identity") {
        return Response.json({ user_hash: "test-user" });
      }
      if (path === "/api/schemas") return Response.json({ ok: true, schemas: [] });
      if (path === "/api/mutation" || path === "/api/query") {
        // Data-plane over TCP would be the bug; answer so the assertion can fail
        // loudly on tcpSeen rather than on a thrown error.
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

  test("system /api/system/auto-identity goes over TCP even though the socket exists", async () => {
    const node = newNodeClient({ baseUrl: tcpUrl, userHash: "test-user", socketPath });
    const res = await node.autoIdentity();
    expect(res.provisioned).toBe(true);
    expect(tcpSeen).toContain("/api/system/auto-identity");
    // The system route must NEVER have been sent to the data-plane socket.
    expect(socketSeen).not.toContain("/api/system/auto-identity");
  });

  test("schema route /api/schemas goes over TCP even though the socket exists", async () => {
    const node = newNodeClient({ baseUrl: tcpUrl, userHash: "test-user", socketPath });
    await node.listSchemas();
    expect(tcpSeen).toContain("/api/schemas");
    expect(socketSeen).not.toContain("/api/schemas");
  });

  test("nodeTransport() still reports socket when the socket exists", () => {
    const node = newNodeClient({ baseUrl: tcpUrl, userHash: "test-user", socketPath });
    const t = node.nodeTransport();
    expect(t.transport).toBe("socket");
    expect(t.socketPath).toBe(socketPath);
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
