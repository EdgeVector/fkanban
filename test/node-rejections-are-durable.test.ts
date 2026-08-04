// A node 400 must survive the process that provoked it.
//
// The witness these tests defend replaced one that printed to `console.error`
// from a single call site (`pipeline_status.querySchema`). Both halves of that
// shape failed in production within four hours:
//
//   - the process is usually `kanban mcp`, a long-lived stdio server whose
//     stderr belongs to its spawner, so the line went nowhere readable; and
//   - the one 400 the node actually attributed to kanban was on `board_cards`,
//     which that call site never reads.
//
// So the tests below pin the two properties that fix it: the record is a FILE,
// and it is written from `queryAll` — the funnel EVERY kanban read passes
// through — not from any particular caller.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { newNodeClient } from "../src/client.ts";
import {
  DIAGNOSTICS_ENABLED_ENV,
  DIAGNOSTICS_PATH_ENV,
  REJECTIONS_MAX_BYTES,
  isMalformedQuery,
  readRecentRejections,
  recordNodeRejection,
  rejectionsPath,
} from "../src/diagnostics.ts";

let dir: string;
let sink: string;
const savedPath = process.env[DIAGNOSTICS_PATH_ENV];
const savedEnabled = process.env[DIAGNOSTICS_ENABLED_ENV];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fkanban-rejections-"));
  sink = join(dir, "node-rejections.jsonl");
  process.env[DIAGNOSTICS_PATH_ENV] = sink;
  delete process.env[DIAGNOSTICS_ENABLED_ENV];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedPath === undefined) delete process.env[DIAGNOSTICS_PATH_ENV];
  else process.env[DIAGNOSTICS_PATH_ENV] = savedPath;
  if (savedEnabled === undefined) delete process.env[DIAGNOSTICS_ENABLED_ENV];
  else process.env[DIAGNOSTICS_ENABLED_ENV] = savedEnabled;
});

describe("the rejection sink", () => {
  test("a recorded rejection is readable after the writer is gone", () => {
    expect(recordNodeRejection({ code: "node_http_400", message: "boom", schema: "abc" })).toBe(true);
    // Read through a path resolution that shares no state with the write —
    // this is the property the old console.error witness did not have.
    const lines = readFileSync(sink, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry.code).toBe("node_http_400");
    expect(entry.pid).toBe(process.pid);
    expect(typeof entry.ts).toBe("string");
  });

  test("`FKANBAN_DIAGNOSTICS=0` writes nothing at all", () => {
    process.env[DIAGNOSTICS_ENABLED_ENV] = "0";
    expect(recordNodeRejection({ code: "node_http_400", message: "boom" })).toBe(false);
    expect(existsSync(sink)).toBe(false);
  });

  test("an unwritable sink degrades to silence, never to a throw", () => {
    // A sink that can break the path it observes is worse than no sink: this
    // runs inside the error handling of a read that has ALREADY failed.
    process.env[DIAGNOSTICS_PATH_ENV] = join(dir, "not-a-dir-really");
    writeFileSync(join(dir, "not-a-dir-really"), "");
    process.env[DIAGNOSTICS_PATH_ENV] = join(dir, "not-a-dir-really", "nested.jsonl");
    expect(() => recordNodeRejection({ code: "node_http_400", message: "boom" })).not.toThrow();
  });

  test("the file is capped, and the cap keeps the NEWEST entries", () => {
    // Halving rather than emptying: a burst that crosses the cap must still be
    // readable across the boundary, or the cap destroys the evidence it was
    // sized to preserve.
    const big = "x".repeat(2000);
    for (let i = 0; i < 200; i++) recordNodeRejection({ code: "node_http_400", message: `${i}-${big}` });
    expect(statSync(sink).size).toBeLessThanOrEqual(REJECTIONS_MAX_BYTES * 2);
    const tail = readRecentRejections(3);
    expect(tail).toHaveLength(3);
    expect(tail[2]!.message.startsWith("199-")).toBe(true);
  });

  test("a torn line costs one record, not the whole report", () => {
    // Six `kanban mcp` servers append to this file concurrently on a normal day.
    recordNodeRejection({ code: "node_http_400", message: "first" });
    writeFileSync(sink, `${readFileSync(sink, "utf8")}{"code":"trunca\n`, "utf8");
    recordNodeRejection({ code: "unknown_fields", message: "third" });
    const read = readRecentRejections(10);
    expect(read.map((r) => r.message)).toEqual(["first", "third"]);
  });

  test("`readRecentRejections` on a missing file is empty, not an error", () => {
    expect(readRecentRejections()).toEqual([]);
  });

  test("the sink path follows the env override", () => {
    expect(rejectionsPath()).toBe(sink);
  });
});

describe("what counts as our bug", () => {
  // The predicate has exactly one definition now. It used to have one in
  // `pipeline_status.ts`; a second copy is a second chance to widen one side
  // and not the other, and the console line and the durable record must agree
  // or a 400 that prints will be absent from the file someone later reads.
  test("400-shaped codes are ours; environment failures are not", () => {
    expect(isMalformedQuery({ code: "node_http_400" })).toBe(true);
    expect(isMalformedQuery({ code: "unknown_fields" })).toBe(true);
    for (const code of ["node_http_403", "node_http_404", "node_overloaded", "service_unreachable"]) {
      expect(isMalformedQuery({ code })).toBe(false);
    }
    expect(isMalformedQuery(null)).toBe(false);
    expect(isMalformedQuery(new Error("plain"))).toBe(false);
  });
});

describe("coverage is a property of the funnel, not of the caller", () => {
  // This is the test that fails against the previous design. It drives a
  // `board_cards`-shaped read — a schema `pipeline_status.querySchema` never
  // touches — straight through `NodeClient.queryAll`, and requires the
  // rejection to have been recorded anyway.
  const BOARD_CARDS_HASH = "39a0424fa08536a60a301516186239dadb1a2b8607c882256fd3d2ec0315b475";

  let server: ReturnType<typeof Bun.serve>;
  let base: string;

  beforeEach(() => {
    server = Bun.serve({
      port: 0,
      // The schema being asked for decides the failure, so both tests below
      // travel the SAME funnel (`POST /api/query`) and differ only in what the
      // node says back — which is the distinction under test.
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/query") {
          const body = (await req.json()) as { schema_name?: string };
          if (body.schema_name === BOARD_CARDS_HASH) {
            return Response.json({ error: "unknown_fields", unknown_fields: ["colunm"] }, { status: 400 });
          }
          return Response.json({ error: "schema_not_found" }, { status: 404 });
        }
        return Response.json({ error: "not_found" }, { status: 404 });
      },
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(() => server.stop(true));

  test("a 400 on a board_cards read is recorded with the request shape", async () => {
    const node = newNodeClient({ baseUrl: base, userHash: "u" });
    await expect(
      node.queryAll({
        schemaHash: BOARD_CARDS_HASH,
        fields: ["colunm", "slug"],
        filter: { HashKey: "default" } as never,
      }),
    ).rejects.toThrow();

    const recorded = readRecentRejections(10);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.schema).toBe(BOARD_CARDS_HASH);
    expect(recorded[0]!.fields).toEqual(["colunm", "slug"]);
    expect(recorded[0]!.filter).toEqual({ HashKey: "default" });
  });

  test("a 404 is the environment and is NOT recorded", async () => {
    // Every machine without lastgit schemas registered 404s these reads. If
    // that landed in the file, the file would be noise within a day and the
    // real 400 would be unfindable inside it — the failure mode that made the
    // original swallow-everything catch look reasonable.
    const node = newNodeClient({ baseUrl: base, userHash: "u" });
    await expect(
      node.queryAll({ schemaHash: "a-schema-this-node-does-not-have", fields: ["slug"] }),
    ).rejects.toThrow();
    expect(readRecentRejections(10)).toEqual([]);
  });
});
