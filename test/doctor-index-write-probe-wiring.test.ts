// Does `doctor` ACTUALLY run the write probe for the five index schemas?
//
// `probeSchemaWritable` being callable for them (index-schema-write-probe.test.ts)
// is only half the fix. The first cut of the doctor wiring compiled, typechecked
// and passed every unit test while emitting NO index write-probe at all: the
// call had been placed inside the identity chain's `not_loaded` arm, a branch
// that by definition never runs for a pin that IS loaded. It was caught by
// running doctor against the live primary and counting the lines — three
// write-probes, seven pins.
//
// That is the same shape run (f) found in the identity wiring (tests green
// against a commented-out call site), and it is why this file asserts on
// doctor's OUTPUT rather than on the probe function: the only thing that can
// catch a check wired into an unreachable branch is one that reads what the
// operator reads.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { doctor } from "../src/commands/doctor.ts";
import { WRITE_PROBE_SLUG } from "../src/record.ts";
import { EXTRA_SCHEMAS, allPinnedSchemas } from "../src/schemas.ts";
import { handleApiList } from "./http-list.ts";

// One loaded-schema row per pinned key, each at its DECLARED identity, so
// `checkPinnedSchemaIdentity` returns `ok` for all eight and the probe gate
// (`identity.kind === "ok"`) is open. A fixture that got any identity wrong
// would skip the probe for the right reason and pass this file for the wrong one.
const HASH_FOR: Record<string, string> = Object.fromEntries(
  allPinnedSchemas().map((e) => [e.key, `hash-${e.key}`]),
);

// Schemas whose writes the node refuses, to prove the wiring reports a red and
// not just a line.
const rejecting = new Set<string>();

function makeNode() {
  const store = new Map<string, Record<string, unknown>>();
  const dir = mkdtempSync(join(tmpdir(), "fkanban-doctor-idx-node-"));
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
          schemas: allPinnedSchemas().map((e) => {
            const def = e.schema.schema;
            return {
              name: HASH_FOR[e.key],
              descriptive_name: def.descriptive_name,
              owner_app_id: def.owner_app_id,
              fields: [...def.fields],
              key: { hash_field: def.key.hash_field, range_field: def.key.range_field ?? null },
            };
          }),
        });
      }
      if (url.pathname === "/api/mutation") {
        const schema = body!.schema as string;
        const key = body!.key_value as { hash: string; range?: string | null };
        const mtype = body!.mutation_type as string;
        if (rejecting.has(schema) && mtype !== "delete") {
          return Response.json(
            { ok: false, error: "unknown_fields", message: `not writable on schema '${schema}'` },
            { status: 400 },
          );
        }
        const addr = `${schema}::${key.hash}::${key.range ?? ""}`;
        if (mtype === "delete") store.delete(addr);
        else store.set(addr, (body!.fields_and_values ?? {}) as Record<string, unknown>);
        return Response.json({ ok: true, success: true });
      }
      if (url.pathname === "/api/list") return handleApiList(url);
      if (url.pathname === "/api/query") {
        const schema = body!.schema_name as string;
        const filter = body!.filter as { HashKey?: string } | undefined;
        const rows = [...store.entries()]
          .filter(([k]) => k.startsWith(`${schema}::`))
          .map(([k, f]) => {
            const [, hash, range] = k.split("::");
            return { fields: f, key: { hash: hash!, range: range!.length > 0 ? range! : null } };
          })
          .filter((r) => filter?.HashKey === undefined || r.key.hash === filter.HashKey);
        return Response.json({ ok: true, results: rows, has_more: false });
      }
      return Response.json({ error: "unexpected", path: url.pathname }, { status: 500 });
    },
  });
  return {
    socketPath,
    store,
    stop: () => {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const tmp = mkdtempSync(join(tmpdir(), "fkanban-doctor-idx-cfg-"));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  rejecting.clear();
});

function writeCfg(name: string, socketPath: string): string {
  const p = join(tmp, name);
  const server = Bun.serve({ port: 0, fetch: () => Response.json({}) });
  const nodeUrl = `http://127.0.0.1:${server.port}`;
  server.stop(true);
  writeFileSync(
    p,
    JSON.stringify({
      configVersion: 1,
      nodeUrl,
      schemaServiceUrl: "http://unused.invalid",
      userHash: "u",
      schemaHashes: { ...HASH_FOR },
      nodeSocketPath: socketPath,
    }),
  );
  return p;
}

async function doctorReport(name: string): Promise<{ report: string; store: Map<string, unknown> }> {
  const node = makeNode();
  const cfgPath = writeCfg(name, node.socketPath);
  const lines: string[] = [];
  try {
    await doctor({ configPath: cfgPath, print: (l) => lines.push(l) });
    return { report: lines.join("\n"), store: node.store };
  } finally {
    node.stop();
  }
}

describe("doctor wires the write probe to the five index schemas", () => {
  test("every EXTRA_SCHEMA gets a write-probe line", async () => {
    const { report } = await doctorReport("all-ok.json");
    for (const entry of EXTRA_SCHEMAS) {
      expect(report).toContain(`✓ ${entry.key} write-probe`);
    }
  });

  test("the three RecordTypes are probed once each, under their own label", async () => {
    const { report } = await doctorReport("no-double.json");
    // The `!reportedBelow` gate keeps card/board/milestone out of the identity
    // loop's probe — they are probed by the UNIQUE_SCHEMAS loop below it. A
    // regression that dropped the gate would print both labels for the same key.
    for (const key of ["card", "board", "milestone"]) {
      expect(report).toContain(`✓ fkanban/`);
      expect(report).not.toContain(`✓ ${key} write-probe`);
    }
  });

  test("a rejected index write turns doctor RED, naming the key", async () => {
    rejecting.add(HASH_FOR.board_cards!);
    try {
      const { report } = await doctorReport("bc-rejects.json");
      expect(report).toContain("✗ board_cards write-probe");
      expect(report).toContain("node rejected a write of all fields");
    } finally {
      rejecting.delete(HASH_FOR.board_cards!);
    }
  });

  test("no probe row survives, and none lands in a live partition", async () => {
    const { report, store } = await doctorReport("cleanup.json");
    expect(report).not.toContain("probe row left behind");
    for (const addr of store.keys()) {
      // `<schema>::<hash>::<range>` — every probe row is addressed at the probe
      // slug, so nothing can be left in `default` (the live board partition).
      const hash = addr.split("::")[1];
      if (hash === WRITE_PROBE_SLUG) throw new Error(`probe row survived at ${addr}`);
    }
  });
});
