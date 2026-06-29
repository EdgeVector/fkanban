// `fkanban init` must NOT pin config to a resolved-but-not-writable schema
// (fkanban #94). These drive the real `runInit` against a stub node and assert:
//   - happy path: with the full 18-field Card loaded, init resolves it,
//     write-probes OK, and writes config pinned to the full hash.
//   - #94 footgun: with ONLY the stale 10-field Card loaded, init REFUSES — it
//     throws a `schema_not_writable` error and leaves any existing config
//     untouched (so current writes keep working), rather than adopting a hash
//     that breaks every subsequent `add`.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FkanbanError } from "../src/client.ts";
import { runInit } from "../src/commands/init.ts";
import { fieldsFor } from "../src/schemas.ts";

const FULL_CARD_HASH = "fullcardhash18";
const STALE_CARD_HASH = "stalecardhash10";
const BOARD_HASH = "boardhash";
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

// A stub node parameterised by which Card schemas it has loaded. Models the #94
// write split: writes against the stale Card 400 when they carry new fields.
// Serves over a full-surface UNIX SOCKET (folddb-full.sock) — the only
// transport a local node speaks now that the client is socket-only and the
// loopback TCP listener is retired. A full-surface socket carries EVERY node
// route (incl. /api/schemas/load), so init's control + data calls all land here.
function makeNode(cardSchemas: Array<{ name: string; fields: string[] }>) {
  const store = new Map<string, Record<string, unknown>>();
  const dir = mkdtempSync(join(tmpdir(), "fkanban-init-node-"));
  const socketPath = join(dir, "folddb-full.sock");
  const server = Bun.serve({
    unix: socketPath,
    async fetch(req) {
      const url = new URL(req.url);
      // Parse a JSON body only when one is actually present — `/api/schemas/load`
      // is a bodyless POST, so `req.json()` would throw on empty input.
      let body: Record<string, unknown> | undefined;
      if (req.method === "POST") {
        const text = await req.text();
        body = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
      }

      if (url.pathname === "/api/system/auto-identity") {
        return Response.json({ user_hash: "stub-user" });
      }
      if (url.pathname === "/api/schemas/load") {
        return Response.json({
          available_schemas_loaded: 2,
          schemas_loaded_to_db: 2,
          failed_schemas: [],
        });
      }
      if (url.pathname === "/api/schemas") {
        const schemas = [
          ...cardSchemas.map((c) => ({
            name: c.name,
            descriptive_name: "Card",
            owner_app_id: "fkanban",
            fields: c.fields,
          })),
          {
            name: BOARD_HASH,
            descriptive_name: "Board",
            owner_app_id: "fkanban",
            fields: fieldsFor("board"),
          },
        ];
        return Response.json({ schemas });
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

const tmp = mkdtempSync(join(tmpdir(), "fkanban-init-probe-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("runInit write-probe guard", () => {
  test("happy path: resolves + write-probes the full 18-field Card and pins config to it", async () => {
    // Stale listed FIRST so a naive resolver would pick the wrong one.
    const node = makeNode([
      { name: STALE_CARD_HASH, fields: OLD_CARD_FIELDS },
      { name: FULL_CARD_HASH, fields: fieldsFor("card") },
    ]);
    const configPath = join(tmp, "happy.json");
    try {
      const { config } = await runInit({
        nodeUrl: `http://127.0.0.1:1`,
        configPath,
        // Point at the fixture's full-surface socket — socket-only routes every
        // call there; nodeUrl is just a loopback placeholder that's never dialed.
        nodeSocketPath: node.socketPath,
        print: () => {},
      });
      expect(config.schemaHashes.card).toBe(FULL_CARD_HASH);
      const written = JSON.parse(readFileSync(configPath, "utf8"));
      expect(written.schemaHashes.card).toBe(FULL_CARD_HASH);
    } finally {
      node.stop();
    }
  });

  test("#94 footgun: with only the stale Card loaded, init REFUSES and leaves config untouched", async () => {
    const node = makeNode([{ name: STALE_CARD_HASH, fields: OLD_CARD_FIELDS }]);
    const configPath = join(tmp, "refuse.json");
    // Pre-existing config pinned to the GOOD hash — the workaround state. init
    // must not clobber it when it refuses.
    const prior = {
      configVersion: 1,
      nodeUrl: `http://127.0.0.1:1`,
      schemaServiceUrl: "http://unused.invalid",
      userHash: "stub-user",
      schemaHashes: { card: FULL_CARD_HASH, board: BOARD_HASH },
      nodeSocketPath: node.socketPath,
    };
    writeFileSync(configPath, JSON.stringify(prior, null, 2));
    try {
      let err: unknown;
      try {
        await runInit({
          nodeUrl: `http://127.0.0.1:1`,
          configPath,
          nodeSocketPath: node.socketPath,
          print: () => {},
        });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(FkanbanError);
      expect((err as FkanbanError).code).toBe("schema_not_writable");
      // Resolution-stage refusal names the missing fields.
      expect((err as FkanbanError).message).toContain("repo");
      // Config is UNTOUCHED — the good hash survives, so writes keep working.
      const after = JSON.parse(readFileSync(configPath, "utf8"));
      expect(after.schemaHashes.card).toBe(FULL_CARD_HASH);
    } finally {
      node.stop();
    }
  });
});
