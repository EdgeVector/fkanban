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

function makeNode(cardSchemas: Array<{ name: string; fields: string[] }>) {
  const store = new Map<string, Record<string, unknown>>();
  return Bun.serve({
    port: 0,
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
}

const tmp = mkdtempSync(join(tmpdir(), "fkanban-doctor-probe-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// A bogus socket path so doctor's data-plane ops go TCP to the stub, not over a
// real :9001 control socket that might exist on the test machine.
const NO_SOCKET = join(tmp, "no-such.sock");

function writeCfg(name: string, cardHash: string, port: number): string {
  const p = join(tmp, name);
  writeFileSync(
    p,
    JSON.stringify({
      configVersion: 1,
      nodeUrl: `http://127.0.0.1:${port}`,
      schemaServiceUrl: "http://unused.invalid",
      userHash: "u",
      schemaHashes: { card: cardHash, board: BOARD_HASH },
      nodeSocketPath: NO_SOCKET,
    }),
  );
  return p;
}

describe("doctor write-probe", () => {
  test("green: config pinned to the writable full-18-field hash passes the write probe", async () => {
    const node = makeNode([{ name: FULL_CARD_HASH, fields: fieldsFor("card") }]);
    const cfgPath = writeCfg("ok.json", FULL_CARD_HASH, node.port!);
    const lines: string[] = [];
    try {
      const ok = await doctor({ configPath: cfgPath, print: (l) => lines.push(l) });
      const report = lines.join("\n");
      expect(report).toContain("✓ fkanban/Card write-probe");
      expect(ok).toBe(true);
    } finally {
      node.stop(true);
    }
  });

  test("green: config pinned to writable hash ignores a stale duplicate loaded first", async () => {
    const node = makeNode([
      { name: STALE_CARD_HASH, fields: OLD_CARD_FIELDS },
      { name: FULL_CARD_HASH, fields: fieldsFor("card") },
    ]);
    const cfgPath = writeCfg("ok-with-stale-duplicate.json", FULL_CARD_HASH, node.port!);
    const lines: string[] = [];
    try {
      const ok = await doctor({ configPath: cfgPath, print: (l) => lines.push(l) });
      const report = lines.join("\n");
      expect(ok).toBe(true);
      expect(report).toContain(`✓ fkanban/Card loaded + matches config — ${FULL_CARD_HASH}`);
      expect(report).toContain("✓ fkanban/Card write-probe");
      expect(report).not.toContain(`✗ fkanban/Card loaded + matches config — ${STALE_CARD_HASH}`);
    } finally {
      node.stop(true);
    }
  });

  test("red: config pinned to the stale 10-field hash FAILS the write probe", async () => {
    // Only the stale schema loaded → config can only point at it.
    const node = makeNode([{ name: STALE_CARD_HASH, fields: OLD_CARD_FIELDS }]);
    const cfgPath = writeCfg("stale.json", STALE_CARD_HASH, node.port!);
    const lines: string[] = [];
    try {
      const ok = await doctor({ configPath: cfgPath, print: (l) => lines.push(l) });
      const report = lines.join("\n");
      expect(ok).toBe(false);
      expect(report).toContain("✗ fkanban/Card write-probe");
      expect(report).toContain("not writable on schema");
    } finally {
      node.stop(true);
    }
  });

  test("red: config pinned to stale while a writable version is loaded → flags the wrong-version pin", async () => {
    const node = makeNode([
      { name: STALE_CARD_HASH, fields: OLD_CARD_FIELDS },
      { name: FULL_CARD_HASH, fields: fieldsFor("card") },
    ]);
    const cfgPath = writeCfg("wrongpin.json", STALE_CARD_HASH, node.port!);
    const lines: string[] = [];
    try {
      const ok = await doctor({ configPath: cfgPath, print: (l) => lines.push(l) });
      const report = lines.join("\n");
      expect(ok).toBe(false);
      expect(report).toContain("✗ fkanban/Card config hash is the writable version");
      expect(report).toContain(FULL_CARD_HASH);
    } finally {
      node.stop(true);
    }
  });
});
