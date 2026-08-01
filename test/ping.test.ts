// `kanban ping` — the probe must cost exactly one status request, answer from
// the report (never throw), and stay honest about failures: a down node is
// ok:false with a diagnostic, not an exception, and a reachable-but-erroring
// node is ok:false too.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pingNode } from "../src/client.ts";
import { runPingStructured } from "../src/commands/ping.ts";

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
