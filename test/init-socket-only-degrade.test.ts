// On a socket-only node (legacy TCP `:9001` retired / connection refused), the
// owner data socket serves board data-plane routes plus identity/schema reads,
// but narrower sockets still cannot serve setup writes such as schema load.
// `fkanban init` used to hard-fail there with `node not reachable at
// http://127.0.0.1:9001`, even though the node is UP.
//
// Symmetric to the doctor degrade (#101): when the TCP control-plane is
// unreachable BUT the data-plane socket round-trips against an EXISTING config,
// init degrades gracefully — reuses the config, re-seeds the board over the
// socket, and reports the node UP — instead of telling the user to start a node.
// These drive the real `runInit` and assert both the degrade and that the real
// failure path (socket ALSO unreachable, or no prior config) still errors.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FkanbanError } from "../src/client.ts";
import { runInit } from "../src/commands/init.ts";

const CARD_HASH = "socketcardhash18";
const BOARD_HASH = "socketboardhash";

const tmp = mkdtempSync(join(tmpdir(), "fkanban-init-socket-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// A closed TCP url — a port we bound then immediately released, so connecting
// to it is refused (modeling the retired `:9001`).
function closedTcpUrl(): string {
  const server = Bun.serve({ port: 0, fetch: () => Response.json({}) });
  const url = `http://127.0.0.1:${server.port}`;
  server.stop(true);
  return url;
}

// A narrow Unix-socket node: serves `/api/query`, `/api/mutation`, and
// `/api/system/auto-identity` (plus the pairing-code mint), but not setup
// writes like `/api/schemas/load`. `seedBoard` controls whether a `default`
// board already exists so we can exercise both the create and the already-exists
// legs.
function makeSocketNode(socketPath: string, opts: { seedBoard?: boolean } = {}) {
  const store = new Map<string, Record<string, unknown>>();
  if (opts.seedBoard) {
    store.set(`${BOARD_HASH}::default`, { slug: "default", title: "Default board", columns: [] });
  }
  const seen: string[] = [];
  const server = Bun.serve({
    unix: socketPath,
    async fetch(req) {
      const url = new URL(req.url);
      seen.push(url.pathname);
      let body: Record<string, unknown> | undefined;
      if (req.method === "POST") {
        const text = await req.text();
        body = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
      }
      if (url.pathname === "/control/browser-pairing-code") {
        return Response.json({ pairing_code: "socket-only" });
      }
      if (url.pathname === "/api/system/auto-identity") {
        return Response.json({ user_hash: "stub-user" });
      }
      if (url.pathname === "/api/mutation") {
        const schema = body!.schema as string;
        const fields = (body!.fields_and_values ?? {}) as Record<string, unknown>;
        const keyHash = (body!.key_value as { hash: string }).hash;
        const mtype = body!.mutation_type as string;
        if (mtype === "delete") store.delete(`${schema}::${keyHash}`);
        else store.set(`${schema}::${keyHash}`, fields);
        return Response.json({ ok: true, success: true });
      }
      if (url.pathname === "/api/query") {
        const schema = body!.schema_name as string;
        const filter = body!.filter as { HashKey?: string } | undefined;
        const rows = [...store.entries()]
          .filter(([key]) => key.startsWith(`${schema}::`))
          .map(([key, f]) => ({ fields: f, key: { hash: key.split("::")[1]!, range: null } }))
          .filter((r) => filter?.HashKey === undefined || r.key.hash === filter.HashKey);
        return Response.json({ ok: true, results: rows, has_more: false });
      }
      // Setup/control writes still 404 on this narrower socket.
      return Response.json({ error: "unexpected_socket_path" }, { status: 404 });
    },
  });
  return { server, seen };
}

function writePriorConfig(name: string, nodeUrl: string, socketPath: string): string {
  const p = join(tmp, name);
  writeFileSync(
    p,
    JSON.stringify({
      configVersion: 1,
      nodeUrl,
      schemaServiceUrl: "http://unused.invalid",
      userHash: "stub-user",
      schemaHashes: { card: CARD_HASH, board: BOARD_HASH },
      nodeSocketPath: socketPath,
    }),
  );
  return p;
}

describe("runInit socket-only graceful degrade", () => {
  test("TCP refused + socket live + prior config → degrades, reseeds board, reports UP", async () => {
    const socketPath = join(tmp, "live.sock");
    const { server, seen } = makeSocketNode(socketPath);
    const tcpUrl = closedTcpUrl();
    const configPath = writePriorConfig("degrade.json", tcpUrl, socketPath);
    const lines: string[] = [];
    try {
      const { config, bootstrapped } = await runInit({
        nodeUrl: tcpUrl,
        nodeSocketPath: socketPath,
        configPath,
        print: (l) => lines.push(l),
      });
      const report = lines.join("\n");
      // It did NOT emit the misleading "start a node" / unreachable failure.
      expect(report).not.toContain("not reachable");
      // It reported the socket-only degrade path and finished ok.
      expect(report).toContain("socket-only");
      expect(report).toContain("[init] ok");
      // Config pins survived untouched.
      expect(config.schemaHashes.card).toBe(CARD_HASH);
      expect(bootstrapped).toBe(false);
      const written = JSON.parse(readFileSync(configPath, "utf8"));
      expect(written.schemaHashes.card).toBe(CARD_HASH);
      // The board was seeded over the SOCKET (mutation seen there).
      expect(seen).toContain("/api/mutation");
      expect(report).toContain('created board "default"');
    } finally {
      server.stop(true);
    }
  });

  test("already-seeded board → leaves it as-is over the socket (idempotent)", async () => {
    const socketPath = join(tmp, "seeded.sock");
    const { server } = makeSocketNode(socketPath, { seedBoard: true });
    const tcpUrl = closedTcpUrl();
    const configPath = writePriorConfig("idempotent.json", tcpUrl, socketPath);
    const lines: string[] = [];
    try {
      await runInit({ nodeUrl: tcpUrl, nodeSocketPath: socketPath, configPath, print: (l) => lines.push(l) });
      const report = lines.join("\n");
      expect(report).toContain("already exists — leaving as-is");
      expect(report).toContain("[init] ok");
    } finally {
      server.stop(true);
    }
  });

  test("real failure preserved: TCP refused AND no usable socket → unreachable error", async () => {
    // Socket path points at a file that isn't a live listener → data-plane probe
    // can't round-trip, so the degrade bails and the TCP-unreachable error stands.
    const deadSocket = join(tmp, "dead.sock");
    writeFileSync(deadSocket, "");
    const tcpUrl = closedTcpUrl();
    const configPath = writePriorConfig("dead.json", tcpUrl, deadSocket);
    let err: unknown;
    try {
      await runInit({ nodeUrl: tcpUrl, nodeSocketPath: deadSocket, configPath, print: () => {} });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FkanbanError);
    expect((err as FkanbanError).code).toBe("service_unreachable");
  });

  test("no prior config: first-ever init on a socket-only node still errors (can't resolve schemas)", async () => {
    const socketPath = join(tmp, "first.sock");
    const { server } = makeSocketNode(socketPath);
    const tcpUrl = closedTcpUrl();
    // No pre-existing config file at this path.
    const configPath = join(tmp, "first-init.json");
    let err: unknown;
    try {
      await runInit({ nodeUrl: tcpUrl, nodeSocketPath: socketPath, configPath, print: () => {} });
    } catch (e) {
      err = e;
    }
    try {
      expect(err).toBeInstanceOf(FkanbanError);
      expect((err as FkanbanError).code).toBe("service_unreachable");
    } finally {
      server.stop(true);
    }
  });
});
