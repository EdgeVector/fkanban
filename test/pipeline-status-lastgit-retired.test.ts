/**
 * LastGit is retired as a venue (decision-2026-09-06-all-repos-venue-forgejo-
 * no-lastgit-default). Its schemas are absent on the primary, and every
 * `kanban show` used to query LastgitRef for the card's branch, get
 * `HTTP 400: Schema '17a37bb…' not found`, and print a "malformed query"
 * warning (papercut-kanban-show-builds-malformed-lastgitref-query-degrades-silently).
 *
 * Pinned here:
 * 1. A Forgejo-venue card never queries LastgitChangeRequest or LastgitRef.
 * 2. A "schema not found" 400 is reported as an absent schema, once per
 *    process, never as a malformed query, and the schema is then skipped.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FkanbanError } from "../src/client.ts";
import type { NodeClient } from "../src/client.ts";
import {
  attachPipelineStatus,
  clearLastgitSchemaHashCache,
  isLastgitVenueCard,
  resolveCardOid,
} from "../src/pipeline_status.ts";

const REF_HASH = "17a37bbceed9d4f4c62d1836d6d70919d4a98ea6dcf5ea1fe15304b854a2a6b8";
let dir: string;
let stderr: string[];
let restore: (() => void) | undefined;
const prevMap = process.env.LASTGIT_SCHEMA_MAP;
const prevForce = process.env.KANBAN_LASTGIT_LOOKUPS;

beforeEach(() => {
  clearLastgitSchemaHashCache();
  dir = mkdtempSync(join(tmpdir(), "kanban-lastgit-retired-"));
  const mapPath = join(dir, "schema-map.json");
  writeFileSync(mapPath, JSON.stringify({ schemas: { LastgitRef: REF_HASH } }));
  process.env.LASTGIT_SCHEMA_MAP = mapPath;
  delete process.env.KANBAN_LASTGIT_LOOKUPS;
  stderr = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void stderr.push(args.map(String).join(" "));
  restore = () => {
    console.error = original;
  };
});

afterEach(() => {
  restore?.();
  clearLastgitSchemaHashCache();
  rmSync(dir, { recursive: true, force: true });
  if (prevMap === undefined) delete process.env.LASTGIT_SCHEMA_MAP;
  else process.env.LASTGIT_SCHEMA_MAP = prevMap;
  if (prevForce === undefined) delete process.env.KANBAN_LASTGIT_LOOKUPS;
  else process.env.KANBAN_LASTGIT_LOOKUPS = prevForce;
});

function schemaMissingNode(calls: string[]): NodeClient {
  return {
    baseUrl: "http://unused.invalid",
    userHash: "test-user",
    async queryAll(req: { schemaHash: string }) {
      calls.push(req.schemaHash);
      throw new FkanbanError({
        code: "node_http_400",
        message: `Node /api/query returned HTTP 400: Invalid data: Schema '${req.schemaHash}' not found`,
      });
    },
  } as unknown as NodeClient;
}

describe("isLastgitVenueCard", () => {
  test("Forgejo cards are not LastGit venue", () => {
    expect(
      isLastgitVenueCard({
        repo: "EdgeVector/fold",
        body: "",
        pr_url: "http://100.109.94.59:3300/EdgeVector/fold/pulls/2148",
      }),
    ).toBe(false);
    expect(isLastgitVenueCard({ repo: "EdgeVector/fold", body: "", pr_url: "" })).toBe(false);
  });

  test("lastdb:/// repos and cr- locators are LastGit venue", () => {
    expect(isLastgitVenueCard({ repo: "lastdb:///fold", body: "", pr_url: "" })).toBe(true);
    expect(isLastgitVenueCard({ repo: "EdgeVector/fold", body: "", pr_url: "cr-abc123" })).toBe(true);
    expect(
      isLastgitVenueCard({ repo: "EdgeVector/fold", body: "", pr_url: "lastdb:///fold/cr/cr-abc123" }),
    ).toBe(true);
  });

  test("KANBAN_LASTGIT_LOOKUPS=1 forces the lookups", () => {
    process.env.KANBAN_LASTGIT_LOOKUPS = "1";
    expect(isLastgitVenueCard({ repo: "EdgeVector/fold", body: "", pr_url: "" })).toBe(true);
  });
});

describe("show on a Forgejo card", () => {
  test("queries no LastGit CR/ref schema and prints nothing", async () => {
    const calls: string[] = [];
    const res = await attachPipelineStatus(schemaMissingNode(calls), {
      repo: "EdgeVector/fold",
      body: "Repo: EdgeVector/fold\n",
      branch: "kanban/x",
      pr_url: "http://100.109.94.59:3300/EdgeVector/fold/pulls/1",
    });
    expect(calls).not.toContain(REF_HASH);
    expect(res.unresolvedOid).toBe(true);
    expect(stderr).toEqual([]);
  });
});

describe("a schema-not-found 400", () => {
  test("is voiced once as an absent schema, never as malformed, then skipped", async () => {
    const calls: string[] = [];
    const node = schemaMissingNode(calls);
    const opts = { repoSlug: "fold", body: "", branch: "kanban/x", prUrl: "" };

    expect((await resolveCardOid(node, opts)).oid).toBe("");
    expect((await resolveCardOid(node, opts)).oid).toBe("");

    expect(calls.filter((c) => c === REF_HASH)).toHaveLength(1);
    expect(stderr.some((l) => l.includes("REJECTED") || l.includes("malformed"))).toBe(false);
    expect(stderr.filter((l) => l.includes("is not loaded on this node"))).toHaveLength(1);
  });
});
