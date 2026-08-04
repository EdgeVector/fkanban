/**
 * `querySchema`'s catch used to swallow EVERY error identically and return `[]`.
 *
 * Its own comment named the causes it expected — "Schema missing / permission /
 * busy" — and every one of those is the environment being unready. A 400 is not
 * one of them: it means the node UNDERSTOOD the request and refused the query
 * we BUILT. It is the only cause in that catch that is a bug on this side, and
 * it was the one made invisible.
 *
 * These reads are best-effort AND cross-app — kanban projecting lastgit's
 * schemas — so the node counts the failure under `app=kanban` while no human
 * ever sees a thing. The primary has carried 14 such unattributed query 400s
 * across three chief-engineer runs that could not name a single one, because
 * `lastdb ops` keeps a 256-entry ring and this path left no other trace.
 *
 * The fix does NOT change the degrade: still best-effort, still returns `[]`.
 * It only stops being silent about the one cause worth hearing. So what these
 * tests pin is the DISCRIMINATION, not the logging — a catch that shouted about
 * everything would be exactly as useless as one that shouted about nothing.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FkanbanError } from "../src/client.ts";
import type { NodeClient } from "../src/client.ts";
import { CR_SCHEMA, clearLastgitSchemaHashCache, resolveCardOid } from "../src/pipeline_status.ts";

let schemaMapDir: string;
const prevSchemaMapEnv = process.env.LASTGIT_SCHEMA_MAP;
let stderr: string[];
let restoreConsole: (() => void) | undefined;

beforeEach(() => {
  clearLastgitSchemaHashCache();
  schemaMapDir = mkdtempSync(join(tmpdir(), "kanban-malformed-query-"));
  const mapPath = join(schemaMapDir, "schema-map.json");
  writeFileSync(mapPath, JSON.stringify({ schemas: { LastgitChangeRequest: CR_SCHEMA } }));
  process.env.LASTGIT_SCHEMA_MAP = mapPath;

  stderr = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void stderr.push(args.map(String).join(" "));
  restoreConsole = () => {
    console.error = original;
  };
});

afterEach(() => {
  restoreConsole?.();
  clearLastgitSchemaHashCache();
  rmSync(schemaMapDir, { recursive: true, force: true });
  if (prevSchemaMapEnv === undefined) delete process.env.LASTGIT_SCHEMA_MAP;
  else process.env.LASTGIT_SCHEMA_MAP = prevSchemaMapEnv;
});

/** A node whose every query fails with `err`. */
function throwingNode(err: unknown): NodeClient {
  return {
    baseUrl: "http://unused.invalid",
    userHash: "test-user",
    async queryAll() {
      throw err;
    },
  } as unknown as NodeClient;
}

/** Drives `querySchema` through its only exported caller that takes a lookup. */
const read = (node: NodeClient) =>
  resolveCardOid(node, {
    repoSlug: "fkanban",
    body: "",
    branch: "main",
    prUrl: "lastdb:///fkanban/cr/cr-abc123",
  });

const warning = () => stderr.find((line) => line.includes("REJECTED"));

describe("a malformed-query 400 is voiced", () => {
  test("an unknown_fields 400 names the schema, the projection AND the filter", async () => {
    // The three things needed to fix it, and the three the ring could not
    // supply. Asserting on their presence is the point — a bare "a query
    // failed" line would satisfy a laxer test and still leave the next run
    // unable to name the offender.
    const node = throwingNode(
      new FkanbanError({
        code: "unknown_fields",
        message: "Node rejected /api/query: fields require_status not readable on schema.",
      }),
    );

    await read(node);

    const line = warning();
    expect(line).toBeDefined();
    expect(line).toContain(CR_SCHEMA);
    expect(line).toContain("require_status"); // the projection, echoed back
    // The filter as SENT. With no `listSchemas` on this node the key layout
    // cannot resolve, so the built filter is the partition read `HashKey:
    // <repo>` rather than the keyed `HashRangeKey` — which is exactly why the
    // line echoes the filter instead of the caller's intent.
    expect(line).toContain('"HashKey":"fkanban"');
    expect(line).toContain("bug in the query");
  });

  test("a bare node_http_400 is voiced too — deny_unknown_fields makes a bad filter key land here", async () => {
    const node = throwingNode(
      new FkanbanError({ code: "node_http_400", message: "Node /api/query returned HTTP 400." }),
    );

    await read(node);

    expect(warning()).toBeDefined();
  });

  test("it still degrades to empty — the caller's contract is unchanged", async () => {
    // The fix must not convert a best-effort read into a hard failure. If this
    // regresses, `kanban show` starts throwing on a node with a stale lastgit
    // schema, which is strictly worse than the silence being fixed.
    const node = throwingNode(new FkanbanError({ code: "node_http_400", message: "bad" }));

    const res = await read(node);

    expect(res.oid).toBe("");
  });
});

describe("the benign causes stay silent", () => {
  // Without these the fix is worthless in the other direction: this path runs
  // on every `kanban show`, and a node that simply has no lastgit schemas
  // registered is the NORMAL case on most machines. Shouting there would train
  // everyone to ignore the line — including the run that finally needs it.
  test.each([
    ["a 404 — schema genuinely missing", "node_http_404"],
    ["a 403 — permission", "node_http_403"],
    ["a 503 — node shedding load", "node_overloaded"],
  ])("%s stays silent", async (_label, code) => {
    const node = throwingNode(new FkanbanError({ code, message: "unavailable" }));

    const res = await read(node);

    expect(warning()).toBeUndefined();
    expect(res.oid).toBe("");
  });

  test("a transport failure — a plain Error with no code — stays silent", async () => {
    const node = throwingNode(new Error("socket hang up"));

    await read(node);

    expect(warning()).toBeUndefined();
  });
});
