// Does DIAGNOSTIC traffic identify itself separately from real board work?
//
// `X-LastDB-Client` is how `lastdb ops` attributes load. Every fkanban request
// used to send the literal string "kanban", so doctor's synthetic probes landed
// in the same bucket as a user's `add`/`move`. That is not cosmetic. Measured on
// the live primary 2026-08-04:
//
//   real board write (add/mark/move)   ~200-350ms, molecule_gate ~0
//   doctor write-probe (create+delete  ~2.4s,      molecule_gate ~2.2s
//   of ONE slug, back to back)
//
// because a delete issued inside that slot's ~2.2s deferred-put window blocks
// until the put fires. Ten probe writes were enough to drag the pooled
// `client=kanban` mutation average to "95% molecule_gate", and two
// chief-engineer runs read that as the board's write-path frontier. It was
// doctor measuring its own cleanup.
//
// So this file asserts on the header doctor ACTUALLY sends, driving the real
// `doctor()` against a stub node — not on `newNodeClient({opsLabel})`, which
// passes by construction. The failure this guards against is the label being
// plumbed but never wired, which is the shape that has bitten this repo
// repeatedly (see doctor-index-write-probe-wiring.test.ts).

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_OPS_LABEL,
  DOCTOR_OPS_LABEL,
  PARITY_OPS_LABEL,
  groomOpsLabel,
  newNodeClient,
} from "../src/client.ts";
import { doctor } from "../src/commands/doctor.ts";
import { GROOM_SUBCOMMANDS } from "../src/commands/groom.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
import { allPinnedSchemas } from "../src/schemas.ts";
import { handleApiList } from "./http-list.ts";

const HASH_FOR: Record<string, string> = Object.fromEntries(
  allPinnedSchemas().map((e) => [e.key, `hash-${e.key}`]),
);

// A stub node that records the ops label of EVERY request it is asked to serve,
// alongside the path and mutation type, so a test can distinguish "doctor
// labelled its reads but not its write-probes" from a clean pass.
type Seen = { path: string; label: string | null; mutationType?: string };

function makeNode() {
  const seen: Seen[] = [];
  const store = new Map<string, Record<string, unknown>>();
  const dir = mkdtempSync(join(tmpdir(), "fkanban-opslabel-node-"));
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
      seen.push({
        path: url.pathname,
        label: req.headers.get("x-lastdb-client"),
        mutationType: body?.mutation_type as string | undefined,
      });
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
        const addr = `${schema}::${key.hash}::${key.range ?? ""}`;
        if ((body!.mutation_type as string) === "delete") store.delete(addr);
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
    seen,
    stop: () => {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const tmp = mkdtempSync(join(tmpdir(), "fkanban-opslabel-cfg-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function writeCfg(name: string, socketPath: string): string {
  const p = join(tmp, name);
  const probe = Bun.serve({ port: 0, fetch: () => Response.json({}) });
  const nodeUrl = `http://127.0.0.1:${probe.port}`;
  probe.stop(true);
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

describe("ops-label attribution on the wire", () => {
  test("ordinary board traffic keeps the plain label", async () => {
    const node = makeNode();
    try {
      const client = newNodeClient({
        baseUrl: "http://127.0.0.1:1",
        userHash: "u",
        socketPath: node.socketPath,
      });
      await client.queryAll({ schemaHash: "cardhash", fields: ["slug"] });
      const labels = node.seen.filter((s) => s.path === "/api/query").map((s) => s.label);
      expect(labels.length).toBeGreaterThan(0);
      expect(new Set(labels)).toEqual(new Set([DEFAULT_OPS_LABEL]));
    } finally {
      node.stop();
    }
  });

  test("an explicit opsLabel reaches the node", async () => {
    const node = makeNode();
    try {
      const client = newNodeClient({
        baseUrl: "http://127.0.0.1:1",
        userHash: "u",
        socketPath: node.socketPath,
        opsLabel: PARITY_OPS_LABEL,
      });
      await client.queryAll({ schemaHash: "cardhash", fields: ["slug"] });
      const labels = node.seen.filter((s) => s.path === "/api/query").map((s) => s.label);
      expect(new Set(labels)).toEqual(new Set([PARITY_OPS_LABEL]));
    } finally {
      node.stop();
    }
  });

  test("the diagnostic labels are distinct from the board label", () => {
    // A regression that "fixed" this by aliasing the constants would satisfy
    // every wire assertion above while restoring the exact pooling that caused
    // the misreading. Pin the thing that actually matters: they differ.
    expect(DOCTOR_OPS_LABEL).not.toBe(DEFAULT_OPS_LABEL);
    expect(PARITY_OPS_LABEL).not.toBe(DEFAULT_OPS_LABEL);
    expect(DOCTOR_OPS_LABEL).not.toBe(PARITY_OPS_LABEL);
  });
});

describe("doctor attributes its own traffic", () => {
  test("every request doctor issues carries the doctor label, none the board label", async () => {
    const node = makeNode();
    const cfgPath = writeCfg("doctor-labels.json", node.socketPath);
    try {
      await doctor({ configPath: cfgPath, print: () => {} });
    } finally {
      node.stop();
    }

    // Doctor is not required to be all-green against this stub; it is required
    // to be honest about who it is on every request it does make.
    expect(node.seen.length).toBeGreaterThan(0);
    const labels = new Set(node.seen.map((s) => s.label));
    expect(labels).toEqual(new Set([DOCTOR_OPS_LABEL]));
    expect(labels.has(DEFAULT_OPS_LABEL)).toBe(false);
  });

  test("the write-probe mutations specifically are not billed to the board", async () => {
    const node = makeNode();
    const cfgPath = writeCfg("doctor-probe-labels.json", node.socketPath);
    try {
      await doctor({ configPath: cfgPath, print: () => {} });
    } finally {
      node.stop();
    }

    // The create+delete pair is the exact traffic that produced the bad
    // verdict, so assert on it directly rather than trusting the aggregate
    // above to have covered it.
    const mutations = node.seen.filter((s) => s.path === "/api/mutation");
    expect(mutations.length).toBeGreaterThan(0);
    expect(mutations.some((m) => m.mutationType === "delete")).toBe(true);
    for (const m of mutations) expect(m.label).toBe(DOCTOR_OPS_LABEL);
  });
});

// A maintenance SWEEP is not a user moving a card, even when the rows it writes
// are real board rows. Measured on the live primary 2026-08-05: one
// `groom board-cards-heal --apply` emitted 686 board_cards mutations at avg
// 9408ms (max 36.7s) under the plain `kanban` label, next to a ~300-400ms real
// `move`. Nothing in `lastdb ops` could separate them, so the bucket read as
// "board writes take 9.4 seconds" — the same misreading DOCTOR_OPS_LABEL exists
// to prevent, one layer out.
describe("every groom sweep attributes its own traffic", () => {
  test("no groom subcommand bills itself to the board label", () => {
    // Table-driven over the dispatcher's OWN list, so a groom subcommand added
    // later cannot quietly inherit the user's bucket — the failure mode that
    // left nine of ten sweeps unlabelled when parity-check was fixed.
    expect(GROOM_SUBCOMMANDS.length).toBeGreaterThan(1);
    for (const sub of GROOM_SUBCOMMANDS) {
      expect(groomOpsLabel(sub)).not.toBe(DEFAULT_OPS_LABEL);
    }
  });

  test("each sweep is distinguishable from every other sweep", () => {
    // One blanket `kanban-groom` would pass the test above while still pooling
    // a 686-write heal with a handful of archive-done deletes. "Name the
    // offender" needs the labels to differ from each other, not just from the
    // board.
    const labels = GROOM_SUBCOMMANDS.map((s) => groomOpsLabel(s));
    expect(new Set(labels).size).toBe(GROOM_SUBCOMMANDS.length);
    expect(labels).not.toContain(DOCTOR_OPS_LABEL);
  });

  test("parity-check keeps the label already cited in the record", () => {
    // Renaming it would be tidier and would invalidate a shipped measurement.
    expect(groomOpsLabel("parity-check")).toBe(PARITY_OPS_LABEL);
  });

  // The assertions above all run inside the process that defines the label, so
  // they pass whether or not the dispatcher uses it. These drive the REAL CLI
  // as a subprocess against a stub node and read the header off the wire —
  // the "plumbed but never wired" shape this repo keeps hitting.
  for (const sub of ["board-cards-heal", "structured-routing"] as const) {
    test(`groom ${sub} sends its own label on every request`, async () => {
      const node = makeNode();
      const cfgPath = writeCfg(`groom-${sub}.json`, node.socketPath);
      try {
        const proc = Bun.spawn(["bun", "run", CLI, "groom", sub], {
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
          env: { ...process.env, KANBAN_CONFIG: cfgPath },
        });
        await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
      } finally {
        node.stop();
      }

      // Like doctor above: not required to be all-green against the stub, only
      // required to be honest about who it is on every request it does make.
      expect(node.seen.length).toBeGreaterThan(0);
      const labels = new Set(node.seen.map((s) => s.label));
      expect(labels).toEqual(new Set([groomOpsLabel(sub)]));
      expect(labels.has(DEFAULT_OPS_LABEL)).toBe(false);
    });
  }
});
