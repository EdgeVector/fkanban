// `kanban ping` — the probe must cost exactly one status request, answer from
// the report (never throw), and stay honest about failures: a down node is
// ok:false with a diagnostic, not an exception, and a reachable-but-erroring
// node is ok:false too.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pingNode } from "../src/client.ts";
import { pingCommand, runPingStructured } from "../src/commands/ping.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function track(server: { stop(closeActiveConnections?: boolean): void }): void {
  cleanups.push(() => server.stop(true));
}

// A canonical `folddb.sock` with no `folddb-full.sock` sibling is the modern
// collapsed shape: it serves every node route, /api/status included.
function collapsedSocket(): string {
  const dir = mkdtempSync(join(tmpdir(), "fkanban-ping-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "folddb.sock");
}

// `resolveSocketPath` consults FOLDDB_SOCKET_PATH / LASTDB_HOME before it ever
// looks at the config it was handed. A `pingCommand` test that only sets
// `nodeSocketPath` would therefore probe the developer's REAL node whenever
// either variable is set in the shell — the exact accident the `cfg` parameter
// was added to stop. Pin the resolution for the duration of the test.
function pinSocket(sock: string): void {
  const prevSock = process.env.FOLDDB_SOCKET_PATH;
  const prevLastdb = process.env.LASTDB_HOME;
  const prevFold = process.env.FOLDDB_HOME;
  process.env.FOLDDB_SOCKET_PATH = sock;
  delete process.env.LASTDB_HOME;
  delete process.env.FOLDDB_HOME;
  cleanups.push(() => {
    if (prevSock === undefined) delete process.env.FOLDDB_SOCKET_PATH;
    else process.env.FOLDDB_SOCKET_PATH = prevSock;
    if (prevLastdb !== undefined) process.env.LASTDB_HOME = prevLastdb;
    if (prevFold !== undefined) process.env.FOLDDB_HOME = prevFold;
  });
}

function fakeCfg(sock: string): never {
  return {
    configVersion: 1,
    nodeUrl: "http://127.0.0.1:9001",
    schemaServiceUrl: "https://schema.invalid",
    userHash: "0".repeat(32),
    schemaHashes: {},
    nodeSocketPath: sock,
  } as never;
}

/**
 * The shape `/api/status` actually returns, captured from the live primary
 * 2026-08-01: `{ok, user_hash, status:{…}}`.
 *
 * This fake used to answer `{version: "0.23.2-test", status: "ok"}` and the
 * test asserted `report.node_version === "0.23.2-test"`. It passed — against a
 * contract no LastDB node has. There is no `version` key at the top level, none
 * under `status`, and none in the node's status builder; the only `"version"`
 * keys in lastdb_node are app-publish manifests. So the assertion proved the
 * fake, not the product, and it kept a permanently-dead field looking alive
 * through every prior review of this file.
 *
 * A fake is a claim about someone else's contract. This one is now a claim we
 * checked.
 */
function realStatusBody(): Record<string, unknown> {
  return {
    ok: true,
    user_hash: "0".repeat(32),
    status: {
      uptime_secs: 1234,
      rss_bytes: 1024,
      // 98.3% of the real 176 KB body is this ring. Presence matters here, not
      // size: it is why the success path must not parse what it does not read.
      request_ops: { samples: 706242, ring: [] },
    },
  };
}

describe("pingNode", () => {
  test("one status request over UDS: ok, latency, socket path", async () => {
    const sock = collapsedSocket();
    const seen: string[] = [];
    const uds = Bun.serve({
      unix: sock,
      fetch(req) {
        seen.push(`${req.method} ${new URL(req.url).pathname}`);
        return Response.json(realStatusBody());
      },
    });
    track(uds);

    const report = await pingNode({ nodeUrl: "http://127.0.0.1:9001", socketPath: sock });
    expect(report.ok).toBe(true);
    expect(report.latency_ms).toBeGreaterThanOrEqual(0);
    expect(report.socket_path).toBe(sock);
    // The whole point: exactly one request, and it is the status read.
    expect(seen).toEqual(["GET /api/status"]);
    // No invented fields. `node_version` is gone rather than always-undefined,
    // so nothing can advertise it again without also re-adding it here.
    expect(Object.keys(report).sort()).toEqual(["latency_ms", "ok", "socket_path"]);
  });

  test("success does not depend on the status body being parseable", async () => {
    // The liveness answer comes from the HTTP status line. A 200 whose body is
    // not JSON at all — a truncated ring, a proxy's plaintext — is still a node
    // that answered, and ping must say so. Before this change the success path
    // ran the body through a parse purely to look for a field that is not
    // there; a probe that could be broken by the shape of what it ignores is a
    // probe that reports the node down for a reason that is not the node.
    const sock = collapsedSocket();
    const uds = Bun.serve({
      unix: sock,
      fetch() {
        return new Response("<<not json>>", { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    track(uds);

    const report = await pingNode({ nodeUrl: "http://127.0.0.1:9001", socketPath: sock });
    expect(report.ok).toBe(true);
    expect(report.error).toBeUndefined();
  });

  test("down node (no socket file) is ok:false with a diagnostic, not a throw", async () => {
    const sock = collapsedSocket(); // never served
    const report = await pingNode({ nodeUrl: "http://127.0.0.1:9001", socketPath: sock });
    expect(report.ok).toBe(false);
    expect(report.error).toBeString();
    expect(report.error!.length).toBeGreaterThan(0);
  });

  // A node that accepts the connection and then never answers is the shape the
  // fleet actually hits: `/api/status` recomputes a recursive walk of the whole
  // store per request, so a healthy-but-loaded primary blows past the caller's
  // deadline while its ordinary reads stay in single-digit ms. The probe must
  // report that as a deadline, never as a missing node.
  test("a node that never answers is a timeout, not unreachability", async () => {
    const sock = collapsedSocket();
    const uds = Bun.serve({
      unix: sock,
      async fetch() {
        await new Promise(() => {}); // accepts, then never replies
        return new Response("unreachable");
      },
    });
    track(uds);

    const report = await pingNode({
      nodeUrl: "http://127.0.0.1:9001",
      socketPath: sock,
      timeoutMs: 150,
    });
    expect(report.ok).toBe(false);
    expect(report.timed_out).toBe(true);
    expect(report.error).toContain("did not respond within 150ms");
  });

  // The negative half, and the one that matters most: a genuinely absent node
  // must NOT acquire the busy flag, or the distinction buys nothing.
  test("a down node is not flagged as timed out", async () => {
    const sock = collapsedSocket(); // never served
    const report = await pingNode({ nodeUrl: "http://127.0.0.1:9001", socketPath: sock });
    expect(report.ok).toBe(false);
    expect(report.timed_out).toBeUndefined();
  });

  test("node answering non-2xx is ok:false with the mapped error", async () => {
    const sock = collapsedSocket();
    const uds = Bun.serve({
      unix: sock,
      fetch() {
        return Response.json({ error: "node_locked" }, { status: 423 });
      },
    });
    track(uds);

    const report = await pingNode({ nodeUrl: "http://127.0.0.1:9001", socketPath: sock });
    expect(report.ok).toBe(false);
    expect(report.error).toBe("node_locked");
  });
});

// The fleet gates on the PRINTED line, not on the report object: routines run
// `kanban ping` in a shell and branch on what it says. These assert the words.
describe("pingCommand output", () => {
  test("a timeout does not print 'unreachable'", async () => {
    const sock = collapsedSocket();
    const uds = Bun.serve({
      unix: sock,
      async fetch() {
        await new Promise(() => {});
        return new Response("unreachable");
      },
    });
    track(uds);

    pinSocket(sock);
    const lines: string[] = [];
    const rc = await pingCommand({
      cfg: fakeCfg(sock),
      print: (l) => lines.push(l),
      timeoutMs: 150,
    });

    expect(rc).toBe(1); // a probe that did not complete is still not a pass
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("busy, not unreachable");
    expect(lines[0]).not.toContain("node unreachable");
  });

  test("a down node still prints 'unreachable'", async () => {
    const sock = collapsedSocket(); // never served
    pinSocket(sock);
    const lines: string[] = [];
    const rc = await pingCommand({
      cfg: fakeCfg(sock),
      print: (l) => lines.push(l),
    });

    expect(rc).toBe(1);
    expect(lines[0]).toContain("node unreachable");
  });
});

describe("runPingStructured", () => {
  test("missing config is ok:false with the init hint and the CLI version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fkanban-ping-nocfg-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const report = await runPingStructured({ configPath: join(dir, "config.json") });
    expect(report.ok).toBe(false);
    expect(report.error).toContain("kanban init");
    expect(report.version.length).toBeGreaterThan(0);
  });
});
