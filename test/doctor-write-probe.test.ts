// `fkanban doctor` must go RED — not cosmetically green — when the configured
// Card schema hash isn't actually writable (fkanban #94). The old doctor only
// checked "config hash == a loaded hash with this descriptive_name", which was
// green even when the node rejected every write. These drive the real `doctor`
// against a stub node and assert:
//   - a config pinned to the writable full-18-field hash passes the write probe;
//   - a config pinned to the writable full-18-field hash stays green even when
//     the node also reports the stale 10-field duplicate first;
//   - a config pinned to the stale 10-field hash FAILS the write probe (red);
//   - a config pinned to the stale hash while a writable version IS loaded is
//     flagged as "config hash is the writable version" = false (red), pointing
//     the user at init.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { doctor } from "../src/commands/doctor.ts";
import { fieldsFor } from "../src/schemas.ts";

const FULL_CARD_HASH = "doctorfullhash18";
const STALE_CARD_HASH = "doctorstalehash10";
const BOARD_HASH = "doctorboardhash";
const OLD_CARD_FIELDS = [
  "slug",
  "title",
  "body",
  "board",
  "column",
  "position",
  "assignee",
  "tags",
  "created_at",
  "updated_at",
];

// A node fixture that serves over a UNIX SOCKET (folddb.sock) — the only
// transport a local node speaks now that the loopback TCP listener is retired
// and the client is socket-only. Returns the socket path + a stop() that also
// cleans the temp dir.
function makeNode(cardSchemas: Array<{ name: string; fields: string[] }>) {
  const store = new Map<string, Record<string, unknown>>();
  const dir = mkdtempSync(join(tmpdir(), "fkanban-probe-node-"));
  const socketPath = join(dir, "folddb.sock");
  const server = Bun.serve({
    unix: socketPath,
    async fetch(req) {
      const url = new URL(req.url);
      let body: Record<string, unknown> | undefined;
      if (req.method === "POST") {
        const text = await req.text();
        body = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
      }
      if (url.pathname === "/api/system/auto-identity") return Response.json({ user_hash: "u" });
      if (url.pathname === "/api/schemas") {
        return Response.json({
          schemas: [
            ...cardSchemas.map((c) => ({
              name: c.name,
              descriptive_name: "Card",
              owner_app_id: "fkanban",
              fields: c.fields,
            })),
            { name: BOARD_HASH, descriptive_name: "Board", owner_app_id: "fkanban", fields: fieldsFor("board") },
          ],
        });
      }
      if (url.pathname === "/api/mutation") {
        const schema = body!.schema as string;
        const fields = (body!.fields_and_values ?? {}) as Record<string, unknown>;
        const keyHash = (body!.key_value as { hash: string }).hash;
        const mtype = body!.mutation_type as string;
        if (schema === STALE_CARD_HASH && mtype !== "delete") {
          const unknown = Object.keys(fields).filter((f) => !OLD_CARD_FIELDS.includes(f));
          if (unknown.length > 0) {
            return Response.json(
              {
                ok: false,
                error: "unknown_fields",
                message: `Fields ${unknown.map((f) => `'${f}'`).join(", ")} not writable on schema '${STALE_CARD_HASH}'. Available: ${OLD_CARD_FIELDS.join(", ")}`,
                unknown_fields: unknown.sort(),
                available_fields: OLD_CARD_FIELDS,
              },
              { status: 400 },
            );
          }
        }
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
      return Response.json({ error: "unexpected", path: url.pathname }, { status: 500 });
    },
  });
  return {
    socketPath,
    stop: () => {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const tmp = mkdtempSync(join(tmpdir(), "fkanban-doctor-probe-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// The node fixture serves over its Unix socket; nodeUrl is a closed loopback
// placeholder (socket-only never dials it). Point the cfg at the live socket.
function writeCfg(name: string, cardHash: string, socketPath: string): string {
  return writeCfgWithNode(name, cardHash, closedTcpUrl(), socketPath);
}

function writeCfgWithNode(name: string, cardHash: string, nodeUrl: string, nodeSocketPath: string): string {
  const p = join(tmp, name);
  writeFileSync(
    p,
    JSON.stringify({
      configVersion: 1,
      nodeUrl,
      schemaServiceUrl: "http://unused.invalid",
      userHash: "u",
      schemaHashes: { card: cardHash, board: BOARD_HASH },
      nodeSocketPath,
    }),
  );
  return p;
}

function closedTcpUrl(): string {
  const server = Bun.serve({ port: 0, fetch: () => Response.json({}) });
  const url = `http://127.0.0.1:${server.port}`;
  server.stop(true);
  return url;
}

describe("doctor write-probe", () => {
  test("green: config pinned to the writable full-18-field hash passes the write probe", async () => {
    const node = makeNode([{ name: FULL_CARD_HASH, fields: fieldsFor("card") }]);
    const cfgPath = writeCfg("ok.json", FULL_CARD_HASH, node.socketPath);
    const lines: string[] = [];
    try {
      const ok = await doctor({ configPath: cfgPath, print: (l) => lines.push(l) });
      const report = lines.join("\n");
      expect(report).toContain("✓ fkanban/Card write-probe");
      expect(ok).toBe(true);
    } finally {
      node.stop();
    }
  });

  test("green: config pinned to writable hash ignores a stale duplicate loaded first", async () => {
    const node = makeNode([
      { name: STALE_CARD_HASH, fields: OLD_CARD_FIELDS },
      { name: FULL_CARD_HASH, fields: fieldsFor("card") },
    ]);
    const cfgPath = writeCfg("ok-with-stale-duplicate.json", FULL_CARD_HASH, node.socketPath);
    const lines: string[] = [];
    try {
      const ok = await doctor({ configPath: cfgPath, print: (l) => lines.push(l) });
      const report = lines.join("\n");
      expect(ok).toBe(true);
      expect(report).toContain(`✓ fkanban/Card loaded + matches config — ${FULL_CARD_HASH}`);
      expect(report).toContain("✓ fkanban/Card write-probe");
      expect(report).not.toContain(`✗ fkanban/Card loaded + matches config — ${STALE_CARD_HASH}`);
    } finally {
      node.stop();
    }
  });

  test("red: config pinned to the stale 10-field hash FAILS the write probe", async () => {
    // Only the stale schema loaded → config can only point at it.
    const node = makeNode([{ name: STALE_CARD_HASH, fields: OLD_CARD_FIELDS }]);
    const cfgPath = writeCfg("stale.json", STALE_CARD_HASH, node.socketPath);
    const lines: string[] = [];
    try {
      const ok = await doctor({ configPath: cfgPath, print: (l) => lines.push(l) });
      const report = lines.join("\n");
      expect(ok).toBe(false);
      expect(report).toContain("✗ fkanban/Card write-probe");
      expect(report).toContain("not writable on schema");
    } finally {
      node.stop();
    }
  });

  test("red: config pinned to stale while a writable version is loaded → flags the wrong-version pin", async () => {
    const node = makeNode([
      { name: STALE_CARD_HASH, fields: OLD_CARD_FIELDS },
      { name: FULL_CARD_HASH, fields: fieldsFor("card") },
    ]);
    const cfgPath = writeCfg("wrongpin.json", STALE_CARD_HASH, node.socketPath);
    const lines: string[] = [];
    try {
      const ok = await doctor({ configPath: cfgPath, print: (l) => lines.push(l) });
      const report = lines.join("\n");
      expect(ok).toBe(false);
      expect(report).toContain("✗ fkanban/Card config hash is the writable version");
      expect(report).toContain(FULL_CARD_HASH);
    } finally {
      node.stop();
    }
  });

  test("green: socket data-plane reachability is authoritative when TCP is down", async () => {
    const socketPath = join(tmp, "socket-only.sock");
    const socketSeen: string[] = [];
    const socketNode = Bun.serve({
      unix: socketPath,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        socketSeen.push(path);
        if (path === "/control/browser-pairing-code") return Response.json({ pairing_code: "socket-only" });
        if (path === "/api/system/auto-identity") return Response.json({ user_hash: "u" });
        if (path === "/api/schemas") {
          return Response.json({
            schemas: [
              { name: FULL_CARD_HASH, descriptive_name: "Card", owner_app_id: "fkanban", fields: fieldsFor("card") },
              { name: BOARD_HASH, descriptive_name: "Board", owner_app_id: "fkanban", fields: fieldsFor("board") },
            ],
          });
        }
        if (path === "/api/query") return Response.json({ ok: true, results: [], has_more: false });
        if (path === "/api/mutation") return Response.json({ ok: true });
        return Response.json({ error: "unexpected_socket_path" }, { status: 500 });
      },
    });
    const cfgPath = writeCfgWithNode("socket-only.json", FULL_CARD_HASH, closedTcpUrl(), socketPath);
    const lines: string[] = [];
    try {
      const ok = await doctor({ configPath: cfgPath, print: (l) => lines.push(l) });
      const report = lines.join("\n");
      expect(ok).toBe(true);
      expect(report).toContain("✓ node transport: socket");
      expect(report).toContain("socket-only; no TCP fallback");
      expect(report).not.toContain("loopback TCP fallback configured");
      expect(report).toContain("✓ node reachable via socket");
      expect(report).toContain("✓ node reachable + provisioned");
      expect(report).toContain("✓ fkanban/Card loaded + matches config");
      expect(report).toContain("✓ fkanban/Board loaded + matches config");
      expect(report).toContain("✓ query round-trip");
      expect(report).not.toContain("node TCP control-plane unavailable");
      expect(report).not.toContain("node schema list unavailable over TCP");
      expect(report).not.toContain("Start one");
      expect(report).not.toContain("re-run `fkanban init`");
      expect(socketSeen).toContain("/api/query");
      expect(socketSeen).toContain("/api/system/auto-identity");
      expect(socketSeen).toContain("/api/schemas");
    } finally {
      socketNode.stop(true);
    }
  });

  test("green: socket transport keeps TCP fallback wording for remote nodeUrl", async () => {
    const node = makeNode([{ name: FULL_CARD_HASH, fields: fieldsFor("card") }]);
    const cfgPath = writeCfgWithNode("remote-socket-fallback.json", FULL_CARD_HASH, "https://node.example", node.socketPath);
    const lines: string[] = [];
    try {
      const ok = await doctor({ configPath: cfgPath, print: (l) => lines.push(l) });
      const report = lines.join("\n");
      expect(ok).toBe(true);
      expect(report).toContain("✓ node transport: socket");
      expect(report).toContain("TCP fallback configured");
      expect(report).not.toContain("socket-only; no TCP fallback");
    } finally {
      node.stop();
    }
  });

  test("red: socket mode still fails when neither socket nor TCP can answer data-plane reads", async () => {
    const socketPath = join(tmp, "unusable-socket.sock");
    writeFileSync(socketPath, "");
    const cfgPath = writeCfgWithNode("socket-and-tcp-down.json", FULL_CARD_HASH, closedTcpUrl(), socketPath);
    const lines: string[] = [];

    const ok = await doctor({ configPath: cfgPath, print: (l) => lines.push(l) });
    const report = lines.join("\n");
    expect(ok).toBe(false);
    expect(report).toContain("✓ node transport: socket");
    expect(report).toContain("✗ node reachable via socket");
    expect(report).toContain("Is a folddb node running?");
  });
});
