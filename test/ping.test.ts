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

describe("pingNode", () => {
  test("one status request over UDS: ok, latency, node version", async () => {
    const sock = collapsedSocket();
    const seen: string[] = [];
    const uds = Bun.serve({
      unix: sock,
      fetch(req) {
        seen.push(`${req.method} ${new URL(req.url).pathname}`);
        return Response.json({ version: "0.23.2-test", status: "ok" });
      },
    });
    track(uds);

    const report = await pingNode({ nodeUrl: "http://127.0.0.1:9001", socketPath: sock });
    expect(report.ok).toBe(true);
    expect(report.node_version).toBe("0.23.2-test");
    expect(report.latency_ms).toBeGreaterThanOrEqual(0);
    expect(report.socket_path).toBe(sock);
    // The whole point: exactly one request, and it is the status read.
    expect(seen).toEqual(["GET /api/status"]);
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
