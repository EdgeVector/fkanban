// Unit tests for LastgitCiStatus join + opt-in terminal move gates.
// Fake NodeClient only — no live LastDB / lastgit.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NodeClient, QueryFilter, QueryResponse, QueryRow } from "../src/client.ts";
import { FkanbanError } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { nowIso, type Card } from "../src/record.ts";
import {
  assertLifecycleMoveAllowed,
  attachPipelineStatus,
  clearLastgitSchemaHashCache,
  contextsForShow,
  defaultCiContext,
  evaluateLifecycleGate,
  fetchCiStatus,
  formatPipelineStatusLines,
  fullRefName,
  hasLifecycleGate,
  isPlausibleOid,
  lastgitRepoSlug,
  parseCrId,
  parseHeadOidHeader,
  parseLifecycleRequirements,
  readLastgitSchemaMap,
  requiredContexts,
  resolveCardOid,
  resolveLastgitSchemaHash,
  scoreLastgitSchemaCandidate,
  CI_STATUS_SCHEMA,
  CR_SCHEMA,
  REF_SCHEMA,
} from "../src/pipeline_status.ts";
import { showResult } from "../src/commands/show.ts";
import { moveCmd } from "../src/commands/move.ts";
import { boardToFields, cardToFields } from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";

/** Point schema resolution at identity map so fake tables keyed by logical names work. */
let schemaMapDir = "";
const prevSchemaMapEnv = process.env.LASTGIT_SCHEMA_MAP;

beforeEach(() => {
  clearLastgitSchemaHashCache();
  schemaMapDir = mkdtempSync(join(tmpdir(), "kanban-schema-map-"));
  const mapPath = join(schemaMapDir, "schema-map.json");
  writeFileSync(
    mapPath,
    JSON.stringify({
      schemas: {
        LastgitCiStatus: CI_STATUS_SCHEMA,
        LastgitRef: REF_SCHEMA,
        LastgitChangeRequest: CR_SCHEMA,
      },
    }),
  );
  process.env.LASTGIT_SCHEMA_MAP = mapPath;
});

afterEach(() => {
  clearLastgitSchemaHashCache();
  if (prevSchemaMapEnv === undefined) delete process.env.LASTGIT_SCHEMA_MAP;
  else process.env.LASTGIT_SCHEMA_MAP = prevSchemaMapEnv;
  if (schemaMapDir) rmSync(schemaMapDir, { recursive: true, force: true });
  schemaMapDir = "";
});

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash" },
};

function emptyCard(over: Partial<Card> = {}): Card {
  const now = nowIso();
  return {
    slug: "test-card",
    title: "Test",
    body: "",
    board: "default",
    column: "doing",
    position: "1",
    assignee: "",
    tags: [],
    deps: [],
    surfaces: [],
    created_at: now,
    updated_at: now,
    done_at: "",
    repo: "EdgeVector/fkanban",
    db: "",
    base: "main",
    kind: "pr",
    block_status: "",
    block_reason: "",
    north_star: "",
    pr_url: "",
    branch: "",
    ...over,
  };
}

type Store = Map<string, Map<string, Record<string, unknown>>>;

/**
 * The range component lastgit actually keys each log row by — and `""` for a
 * row that is not addressable by key at all.
 *
 * This distinction is the whole point. A repo partition holds the MATERIALIZED
 * row (the one carrying `rkey` / `cr_key` / `status_key`) alongside every
 * historical version of it: on the live node, `fkanban`'s ref partition has 144
 * rows whose `name` is `refs/heads/main` and exactly ONE of them is the tip.
 * A partition read plus `rows.find()` returns whichever came first.
 */
function naturalRange(schemaHash: string, fields: Record<string, unknown>): string {
  if (schemaHash === CI_STATUS_SCHEMA) return String(fields.status_key ?? "");
  if (schemaHash === REF_SCHEMA) return fields.rkey ? String(fields.name ?? "") : "";
  if (schemaHash === CR_SCHEMA) return fields.cr_key ? String(fields.cr_id ?? "") : "";
  return "";
}

function fakeNode(seed?: {
  ci?: Record<string, unknown>[];
  refs?: Record<string, unknown>[];
  crs?: Record<string, unknown>[];
  cards?: Card[];
  boards?: { slug: string; columns: string[] }[];
  /**
   * Report HashRange key layouts for the lastgit logs, like a live node does.
   * Omit to model an older node that reports no layout — the partition-read
   * fallback path.
   */
  hashRangeLayouts?: boolean;
  /** Every filter this node was queried with, in order (request-shape assertions). */
  filterLog?: Array<{ schemaHash: string; filter?: Record<string, unknown>; fields?: string[] }>;
}): NodeClient {
  const store: Store = new Map();
  const tableFor = (schemaHash: string) => {
    let t = store.get(schemaHash);
    if (!t) {
      t = new Map();
      store.set(schemaHash, t);
    }
    return t;
  };

  // Seed lastgit tables under descriptive schema names (same as production query).
  for (const row of seed?.ci ?? []) {
    const key = String(row.status_key ?? `${row.repo}:${row.oid}:${row.context}`);
    tableFor(CI_STATUS_SCHEMA).set(key, row);
  }
  // Superseded versions (no rkey/cr_key) get distinct storage keys so they sit
  // in the partition ALONGSIDE the materialized row, exactly as on the node —
  // collapsing them onto one key would hide the bug these tests exist to catch.
  for (const [i, row] of (seed?.refs ?? []).entries()) {
    tableFor(REF_SCHEMA).set(String(row.rkey ?? `${row.repo}:${row.name}#v${i}`), row);
  }
  for (const [i, row] of (seed?.crs ?? []).entries()) {
    tableFor(CR_SCHEMA).set(String(row.cr_key ?? `${row.repo}:${row.cr_id}#v${i}`), row);
  }
  for (const c of seed?.cards ?? []) {
    tableFor(cfg.schemaHashes.card!).set(c.slug, cardToFields(c));
  }
  for (const b of seed?.boards ?? [{ slug: "default", columns: [...DEFAULT_COLUMNS] }]) {
    const now = nowIso();
    tableFor(cfg.schemaHashes.board!).set(
      b.slug,
      boardToFields({
        slug: b.slug,
        title: b.slug,
        body: "",
        columns: b.columns,
        created_at: now,
        updated_at: now,
      }),
    );
  }

  const rowsFor = (schemaHash: string, filter?: QueryFilter): QueryRow[] => {
    const t = tableFor(schemaHash);
    // Lastgit tables: a HashRangeKey filter is a point read on (repo, range),
    // where `range` is the field lastgit keys that log by.
    const rangeKey = (filter as Record<string, unknown> | undefined)?.HashRangeKey as
      | { hash: string; range: string }
      | undefined;
    if (rangeKey) {
      return [...t.entries()]
        .filter(
          ([, fields]) =>
            String(fields.repo) === rangeKey.hash &&
            naturalRange(schemaHash, fields) === rangeKey.range,
        )
        .map(([hash, fields]) => ({ fields, key: { hash: String(fields.repo ?? hash), range: hash } }));
    }
    // Lastgit tables: HashKey filters on repo field (hash partition).
    if (filter?.HashKey && (schemaHash === CI_STATUS_SCHEMA || schemaHash === REF_SCHEMA || schemaHash === CR_SCHEMA)) {
      return [...t.entries()]
        .filter(([, fields]) => String(fields.repo) === filter.HashKey)
        .map(([hash, fields]) => ({ fields, key: { hash: String(fields.repo ?? hash), range: hash } }));
    }
    const entries = filter?.HashKey
      ? (t.has(filter.HashKey) ? [[filter.HashKey, t.get(filter.HashKey)!] as const] : [])
      : [...t.entries()].filter(([, fields]) =>
          !filter || Object.entries(filter).every(([field, value]) => fields[field] === value)
        );
    return entries.map(([hash, fields]) => ({ fields, key: { hash, range: null } }));
  };

  const notImpl = (m: string) => async (): Promise<never> => {
    throw new Error(`fakeNode.${m} not implemented`);
  };

  return {
    baseUrl: cfg.nodeUrl,
    userHash: cfg.userHash,
    autoIdentity: notImpl("autoIdentity"),
    bootstrap: notImpl("bootstrap"),
    loadSchemas: notImpl("loadSchemas"),
    listSchemas: seed?.hashRangeLayouts
      ? async () =>
          [CI_STATUS_SCHEMA, REF_SCHEMA, CR_SCHEMA].map((name) => ({
            name,
            descriptive_name: name,
            owner_app_id: "lastgit",
            fields: [],
            key: { hash_field: "repo", range_field: "sk" },
          }))
      : notImpl("listSchemas"),
    async createRecord({ schemaHash, fields, keyHash }) {
      tableFor(schemaHash).set(keyHash, fields);
    },
    async updateRecord({ schemaHash, fields, keyHash }) {
      tableFor(schemaHash).set(keyHash, { ...tableFor(schemaHash).get(keyHash), ...fields });
    },
    async deleteRecord({ schemaHash, keyHash }) {
      tableFor(schemaHash).delete(keyHash);
    },
    async queryAll({ schemaHash, filter, fields }): Promise<QueryResponse> {
      seed?.filterLog?.push({ schemaHash, filter, fields: fields ? [...fields] : undefined });
      const results = rowsFor(schemaHash, filter);
      return { ok: true, results, returned_count: results.length, total_count: results.length };
    },
    rawCall: notImpl("rawCall") as NodeClient["rawCall"],
    nodeTransport: () => ({ transport: "unavailable" as const }),
  };
}

describe("pipeline_status pure helpers", () => {
  test("lastgitRepoSlug strips owner and lastdb URLs", () => {
    expect(lastgitRepoSlug("EdgeVector/fkanban")).toBe("fkanban");
    expect(lastgitRepoSlug("fkanban")).toBe("fkanban");
    expect(lastgitRepoSlug("lastdb:///discovery")).toBe("discovery");
    expect(lastgitRepoSlug("lastdb:///exemem-infra#main")).toBe("exemem-infra");
    expect(lastgitRepoSlug("")).toBe("");
  });

  test("parseLifecycleRequirements reads Requires-Status and Requires-Deploy", () => {
    const body = [
      "Repo: EdgeVector/fkanban",
      "Requires-Status: ci-required, lint",
      "Requires-Deploy: deploy-dev",
      "",
      "## GOAL",
    ].join("\n");
    const reqs = parseLifecycleRequirements(body);
    expect(reqs.statusContexts).toEqual(["ci-required", "lint"]);
    expect(reqs.deployContexts).toEqual(["deploy-dev"]);
    expect(hasLifecycleGate(reqs)).toBe(true);
    expect(requiredContexts(reqs)).toEqual(["ci-required", "lint", "deploy-dev"]);
  });

  test("no Requires-* headers → no gate; show uses default context", () => {
    const reqs = parseLifecycleRequirements("Repo: EdgeVector/fkanban\n");
    expect(hasLifecycleGate(reqs)).toBe(false);
    expect(contextsForShow(reqs, "ci-required")).toEqual(["ci-required"]);
  });

  test("parseHeadOidHeader and isPlausibleOid", () => {
    expect(parseHeadOidHeader("Head-Oid: a9196fd3ef03ded916c1fe22e02425cb424c5557\n")).toBe(
      "a9196fd3ef03ded916c1fe22e02425cb424c5557",
    );
    expect(isPlausibleOid("a9196fd")).toBe(true);
    expect(isPlausibleOid("not-an-oid")).toBe(false);
  });

  test("parseCrId extracts cr-… from pr_url", () => {
    expect(parseCrId("cr-mroyfk59-5795")).toBe("cr-mroyfk59-5795");
    expect(parseCrId("https://example/cr-abc123-99")).toBe("cr-abc123-99");
  });

  test("fullRefName prefixes refs/heads", () => {
    expect(fullRefName("feature/x")).toBe("refs/heads/feature/x");
    expect(fullRefName("refs/heads/main")).toBe("refs/heads/main");
  });

  test("defaultCiContext honors LASTGIT_CI_CONTEXT", () => {
    const prev = process.env.LASTGIT_CI_CONTEXT;
    try {
      delete process.env.LASTGIT_CI_CONTEXT;
      expect(defaultCiContext()).toBe("ci-required");
      process.env.LASTGIT_CI_CONTEXT = "deploy-dev";
      expect(defaultCiContext()).toBe("deploy-dev");
    } finally {
      if (prev === undefined) delete process.env.LASTGIT_CI_CONTEXT;
      else process.env.LASTGIT_CI_CONTEXT = prev;
    }
  });

  test("readLastgitSchemaMap + resolveLastgitSchemaHash prefer schema map", async () => {
    const map = readLastgitSchemaMap();
    expect(map.LastgitCiStatus).toBe(CI_STATUS_SCHEMA);
    const node = fakeNode();
    expect(await resolveLastgitSchemaHash(node, CI_STATUS_SCHEMA)).toBe(CI_STATUS_SCHEMA);
  });

  test("scoreLastgitSchemaCandidate prefers hashrange CI over CiRed", () => {
    const red = scoreLastgitSchemaCandidate(CI_STATUS_SCHEMA, {
      name: "hash-red",
      descriptive_name: "LastgitCiRed",
      owner_app_id: "lastgit",
      fields: ["status_key", "repo", "oid", "context", "state", "updated_at", "log_excerpt"],
    });
    const good = scoreLastgitSchemaCandidate(CI_STATUS_SCHEMA, {
      name: "lastgit/LastgitCiStatus",
      descriptive_name: "LastgitCiStatus_hashrange_v2",
      owner_app_id: "lastgit",
      fields: [
        "status_key",
        "repo",
        "oid",
        "context",
        "state",
        "log_excerpt",
        "event_id",
        "updated_at",
        "schema_version",
        "layout",
      ],
    });
    expect(good).toBeGreaterThan(red);
    expect(good).toBeGreaterThan(0);
  });
});

describe("resolveCardOid + fetchCiStatus", () => {
  const oid = "a9196fd3ef03ded916c1fe22e02425cb424c5557";

  test("prefers Head-Oid header over ref/CR", async () => {
    const node = fakeNode({
      refs: [{ repo: "fkanban", name: "refs/heads/main", oid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }],
    });
    const res = await resolveCardOid(node, {
      repoSlug: "fkanban",
      body: `Head-Oid: ${oid}\nBranch: main\n`,
      branch: "main",
      prUrl: "",
    });
    expect(res).toEqual({ oid, via: "head-oid" });
  });

  test("resolves via LastgitChangeRequest head_oid", async () => {
    const node = fakeNode({
      crs: [{
        repo: "fkanban",
        cr_id: "cr-test-1",
        head_oid: oid,
        head_ref: "refs/heads/feature",
        state: "open",
      }],
    });
    const res = await resolveCardOid(node, {
      repoSlug: "fkanban",
      body: "",
      branch: "",
      prUrl: "cr-test-1",
    });
    expect(res).toEqual({ oid, via: "change-request" });
  });

  test("resolves via LastgitRef branch tip", async () => {
    const node = fakeNode({
      refs: [{ repo: "fkanban", name: "refs/heads/kanban/x", oid }],
    });
    const res = await resolveCardOid(node, {
      repoSlug: "fkanban",
      body: "",
      branch: "kanban/x",
      prUrl: "",
    });
    expect(res).toEqual({ oid, via: "ref" });
  });

  test("fetchCiStatus returns success row", async () => {
    const node = fakeNode({
      ci: [{
        status_key: `fkanban:${oid}:ci-required`,
        repo: "fkanban",
        oid,
        context: "ci-required",
        state: "success",
        log_excerpt: "ok",
        updated_at: "2026-07-17T00:00:00.000Z",
      }],
    });
    const snap = await fetchCiStatus(node, "fkanban", oid, "ci-required", "head-oid");
    expect(snap.state).toBe("success");
    expect(snap.log_excerpt).toBe("ok");
    expect(snap.resolved_via).toBe("head-oid");
  });

  test("fetchCiStatus missing when no row", async () => {
    const node = fakeNode({ ci: [] });
    const snap = await fetchCiStatus(node, "fkanban", oid, "ci-required");
    expect(snap.state).toBe("missing");
  });
});

// These joins hold the exact range component of the row they want. Reading the
// whole repo partition and running `rows.find()` in the client was measurably
// the most expensive thing kanban did to the node — 778 rows / 3.93 MB / ~450ms
// per lookup against 1 row / 14 KB for the keyed read, 2-4 lookups per `show`.
describe("lastgit log joins are keyed point reads, not partition scans", () => {
  const oid = "a9196fd3ef03ded916c1fe22e02425cb424c5557";

  test("fetchCiStatus asks for (repo, status_key) — never the whole partition", async () => {
    const filterLog: Array<{ schemaHash: string; filter?: Record<string, unknown>; fields?: string[] }> = [];
    const node = fakeNode({
      hashRangeLayouts: true,
      filterLog,
      ci: [
        {
          status_key: `fkanban:${oid}:ci-required`,
          repo: "fkanban",
          oid,
          context: "ci-required",
          state: "success",
          log_excerpt: "ok",
          updated_at: "2026-07-17T00:00:00.000Z",
        },
        // A second row in the same partition: a partition read would return it
        // too, so its absence from the request proves the read was keyed.
        {
          status_key: "fkanban:1111111111111111111111111111111111111111:ci-required",
          repo: "fkanban",
          oid: "1111111111111111111111111111111111111111",
          context: "ci-required",
          state: "failure",
        },
      ],
    });

    const snap = await fetchCiStatus(node, "fkanban", oid, "ci-required");
    expect(snap.state).toBe("success");

    const ciReads = filterLog.filter((f) => f.schemaHash === CI_STATUS_SCHEMA);
    expect(ciReads).toHaveLength(1);
    expect(ciReads[0]!.filter).toEqual({
      HashRangeKey: { hash: "fkanban", range: `fkanban:${oid}:ci-required` },
    });
    expect(ciReads[0]!.filter?.HashKey).toBeUndefined();
    // Light projection: show never renders log_excerpt; do not pull that atom.
    expect(ciReads[0]!.fields).toEqual([
      "status_key",
      "repo",
      "oid",
      "context",
      "state",
      "updated_at",
    ]);
    expect(ciReads[0]!.fields).not.toContain("log_excerpt");
  });

  test("fetchCiStatus light path caches by status_key within TTL", async () => {
    const filterLog: Array<{ schemaHash: string; filter?: Record<string, unknown> }> = [];
    const node = fakeNode({
      hashRangeLayouts: true,
      filterLog,
      ci: [
        {
          status_key: `fkanban:${oid}:ci-required`,
          repo: "fkanban",
          oid,
          context: "ci-required",
          state: "success",
          updated_at: "2026-07-17T00:00:00.000Z",
        },
      ],
    });

    const a = await fetchCiStatus(node, "fkanban", oid, "ci-required");
    const b = await fetchCiStatus(node, "fkanban", oid, "ci-required");
    expect(a.state).toBe("success");
    expect(b.state).toBe("success");
    const ciReads = filterLog.filter((f) => f.schemaHash === CI_STATUS_SCHEMA);
    expect(ciReads).toHaveLength(1);

    // Excerpt opt-in must hit the node even when a light cache entry exists.
    const c = await fetchCiStatus(node, "fkanban", oid, "ci-required", "none", {
      includeLogExcerpt: true,
    });
    expect(c.state).toBe("success");
    expect(filterLog.filter((f) => f.schemaHash === CI_STATUS_SCHEMA)).toHaveLength(2);
  });

  test("fetchCiStatus includeLogExcerpt projects log_excerpt", async () => {
    const filterLog: Array<{ schemaHash: string; filter?: Record<string, unknown>; fields?: string[] }> = [];
    const node = fakeNode({
      hashRangeLayouts: true,
      filterLog,
      ci: [
        {
          status_key: `fkanban:${oid}:ci-required`,
          repo: "fkanban",
          oid,
          context: "ci-required",
          state: "failure",
          log_excerpt: "boom",
          updated_at: "2026-07-17T00:00:00.000Z",
        },
      ],
    });

    const snap = await fetchCiStatus(node, "fkanban", oid, "ci-required", "none", {
      includeLogExcerpt: true,
      bypassCache: true,
    });
    expect(snap.log_excerpt).toBe("boom");
    const ciReads = filterLog.filter((f) => f.schemaHash === CI_STATUS_SCHEMA);
    expect(ciReads[0]!.fields).toContain("log_excerpt");
  });

  test("a keyed miss reports missing WITHOUT falling back to a partition scan", async () => {
    const filterLog: Array<{ schemaHash: string; filter?: Record<string, unknown> }> = [];
    const node = fakeNode({
      hashRangeLayouts: true,
      filterLog,
      ci: [
        {
          status_key: "fkanban:2222222222222222222222222222222222222222:ci-required",
          repo: "fkanban",
          oid: "2222222222222222222222222222222222222222",
          context: "ci-required",
          state: "success",
        },
      ],
    });

    const snap = await fetchCiStatus(node, "fkanban", oid, "ci-required");
    expect(snap.state).toBe("missing");

    // Most cards have no CI row, so a miss is the COMMON case: re-reading the
    // partition on empty would cost strictly more than the scan it replaced.
    const ciReads = filterLog.filter((f) => f.schemaHash === CI_STATUS_SCHEMA);
    expect(ciReads).toHaveLength(1);
    expect(ciReads.every((r) => r.filter?.HashRangeKey !== undefined)).toBe(true);
  });

  // The bug this replaces was not slowness, it was a WRONG ANSWER. On the live
  // node `fkanban`'s ref partition carries 144 rows named `refs/heads/main` —
  // every tip main has ever had — and `rows.find()` returned the FIRST, which
  // is not the tip. `show` then reported CI for an ancient commit, and a
  // Requires-Status card would have been gated on that commit's result.
  test("ref resolution returns the TIP, not the first historical row with that name", async () => {
    const tip = "15aca21309bdff11bb626238c939e9a38cf9eaca";
    const history = Array.from({ length: 20 }, (_, i) => ({
      repo: "fkanban",
      name: "refs/heads/main",
      oid: String(i).padStart(40, "a"),
      rkey: null, // a superseded version: present in the partition, not keyed
    }));
    const node = fakeNode({
      hashRangeLayouts: true,
      refs: [...history, { repo: "fkanban", name: "refs/heads/main", oid: tip, rkey: "fkanban:refs/heads/main" }],
    });

    const res = await resolveCardOid(node, { repoSlug: "fkanban", body: "", branch: "main", prUrl: "" });
    expect(res).toEqual({ oid: tip, via: "ref" });
  });

  test("resolveCardOid keys the ref read by full ref name", async () => {
    const filterLog: Array<{ schemaHash: string; filter?: Record<string, unknown> }> = [];
    const node = fakeNode({
      hashRangeLayouts: true,
      filterLog,
      refs: [
        { repo: "fkanban", name: "refs/heads/kanban/x", oid, rkey: "fkanban:refs/heads/kanban/x" },
        { repo: "fkanban", name: "refs/heads/main", oid: "3333333333333333333333333333333333333333", rkey: "fkanban:refs/heads/main" },
      ],
    });

    const res = await resolveCardOid(node, { repoSlug: "fkanban", body: "", branch: "kanban/x", prUrl: "" });
    expect(res).toEqual({ oid, via: "ref" });

    const refReads = filterLog.filter((f) => f.schemaHash === REF_SCHEMA);
    expect(refReads).toHaveLength(1);
    expect(refReads[0]!.filter).toEqual({
      HashRangeKey: { hash: "fkanban", range: "refs/heads/kanban/x" },
    });
  });

  test("resolveCardOid keys the CR read by cr_id, trying both spellings", async () => {
    const filterLog: Array<{ schemaHash: string; filter?: Record<string, unknown> }> = [];
    const node = fakeNode({
      hashRangeLayouts: true,
      filterLog,
      crs: [{ repo: "fkanban", cr_id: "cr-test-1", cr_key: "fkanban:cr-test-1", head_oid: oid, head_ref: "refs/heads/f", state: "open" }],
    });

    // The card cites the CR without the `cr-` prefix; the row carries it.
    const res = await resolveCardOid(node, { repoSlug: "fkanban", body: "", branch: "", prUrl: "cr-test-1" });
    expect(res).toEqual({ oid, via: "change-request" });

    const crReads = filterLog.filter((f) => f.schemaHash === CR_SCHEMA);
    expect(crReads.length).toBeGreaterThan(0);
    expect(crReads.every((r) => r.filter?.HashRangeKey !== undefined)).toBe(true);
  });

  test("a node that reports no key layout still resolves, via the partition read", async () => {
    const filterLog: Array<{ schemaHash: string; filter?: Record<string, unknown> }> = [];
    const node = fakeNode({
      // hashRangeLayouts omitted: listSchemas throws, like an older node.
      filterLog,
      ci: [
        {
          status_key: `fkanban:${oid}:ci-required`,
          repo: "fkanban",
          oid,
          context: "ci-required",
          state: "success",
          log_excerpt: "ok",
        },
      ],
    });

    const snap = await fetchCiStatus(node, "fkanban", oid, "ci-required");
    expect(snap.state).toBe("success");

    const ciReads = filterLog.filter((f) => f.schemaHash === CI_STATUS_SCHEMA);
    expect(ciReads).toHaveLength(1);
    expect(ciReads[0]!.filter).toEqual({ HashKey: "fkanban" });
  });
});

describe("attachPipelineStatus + evaluateLifecycleGate", () => {
  const oid = "a9196fd3ef03ded916c1fe22e02425cb424c5557";

  test("attach joins success for default context", async () => {
    const node = fakeNode({
      ci: [{
        status_key: `fkanban:${oid}:ci-required`,
        repo: "fkanban",
        oid,
        context: "ci-required",
        state: "success",
        log_excerpt: "passed",
        updated_at: "2026-07-17T00:00:00.000Z",
      }],
    });
    const card = emptyCard({
      body: `Repo: EdgeVector/fkanban\nHead-Oid: ${oid}\n`,
      repo: "EdgeVector/fkanban",
    });
    const attached = await attachPipelineStatus(node, card);
    expect(attached.unresolvedOid).toBe(false);
    expect(attached.statuses).toHaveLength(1);
    expect(attached.statuses[0]!.state).toBe("success");
    const lines = formatPipelineStatusLines(attached, false);
    expect(lines.some((l) => l.includes("success") && l.includes("ci-required"))).toBe(true);
  });

  test("gate blocks non-success required context", () => {
    const verdict = evaluateLifecycleGate({
      requirements: { statusContexts: ["ci-required"], deployContexts: [] },
      statuses: [{
        repo: "fkanban",
        oid,
        context: "ci-required",
        state: "failure",
        updated_at: "",
        log_excerpt: "boom",
        resolved_via: "head-oid",
        status_key: `fkanban:${oid}:ci-required`,
      }],
      unresolvedRepo: false,
      unresolvedOid: false,
      repoSlug: "fkanban",
      oid,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.violations[0]!.state).toBe("failure");
  });

  test("gate allows success", () => {
    const verdict = evaluateLifecycleGate({
      requirements: { statusContexts: ["ci-required"], deployContexts: [] },
      statuses: [{
        repo: "fkanban",
        oid,
        context: "ci-required",
        state: "success",
        updated_at: "",
        log_excerpt: "",
        resolved_via: "head-oid",
        status_key: `fkanban:${oid}:ci-required`,
      }],
      unresolvedRepo: false,
      unresolvedOid: false,
      repoSlug: "fkanban",
      oid,
    });
    expect(verdict.ok).toBe(true);
  });

  test("no Requires-* → gate always ok", () => {
    const verdict = evaluateLifecycleGate({
      requirements: { statusContexts: [], deployContexts: [] },
      statuses: [],
      unresolvedRepo: true,
      unresolvedOid: true,
      repoSlug: "",
      oid: "",
    });
    expect(verdict.ok).toBe(true);
  });
});

describe("showResult pipeline enrichment", () => {
  const oid = "a9196fd3ef03ded916c1fe22e02425cb424c5557";

  test("show --json includes pipeline.statuses", async () => {
    const card = emptyCard({
      slug: "show-pipe",
      column: "doing",
      body: `Repo: EdgeVector/fkanban\nHead-Oid: ${oid}\n`,
    });
    const node = fakeNode({
      cards: [card],
      ci: [{
        status_key: `fkanban:${oid}:ci-required`,
        repo: "fkanban",
        oid,
        context: "ci-required",
        state: "success",
        log_excerpt: "ok",
        updated_at: "2026-07-17T00:00:00.000Z",
      }],
    });
    const { text, card: detail } = await showResult({ cfg, node, slug: "show-pipe" });
    expect(detail.pipeline?.statuses[0]?.state).toBe("success");
    expect(text).toContain("pipeline:");
    expect(text).toContain("success");
  });
});

describe("moveCmd lifecycle gate", () => {
  const oid = "a9196fd3ef03ded916c1fe22e02425cb424c5557";

  test("blocks done when Requires-Status is failure", async () => {
    const card = emptyCard({
      slug: "gate-fail",
      column: "doing",
      body: [
        "Repo: EdgeVector/fkanban",
        `Head-Oid: ${oid}`,
        "Requires-Status: ci-required",
        "Kind: pr",
      ].join("\n"),
    });
    const node = fakeNode({
      cards: [card],
      ci: [{
        status_key: `fkanban:${oid}:ci-required`,
        repo: "fkanban",
        oid,
        context: "ci-required",
        state: "failure",
        log_excerpt: "red",
        updated_at: "2026-07-17T00:00:00.000Z",
      }],
    });
    try {
      await moveCmd({ cfg, node, slug: "gate-fail", column: "done" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FkanbanError);
      expect((err as FkanbanError).code).toBe("lifecycle_status_blocked");
    }
  });

  test("allows done when Requires-Status is success", async () => {
    const card = emptyCard({
      slug: "gate-ok",
      column: "doing",
      body: [
        "Repo: EdgeVector/fkanban",
        `Head-Oid: ${oid}`,
        "Requires-Status: ci-required",
        "Kind: pr",
      ].join("\n"),
    });
    const node = fakeNode({
      cards: [card],
      ci: [{
        status_key: `fkanban:${oid}:ci-required`,
        repo: "fkanban",
        oid,
        context: "ci-required",
        state: "success",
        log_excerpt: "green",
        updated_at: "2026-07-17T00:00:00.000Z",
      }],
    });
    const res = await moveCmd({ cfg, node, slug: "gate-ok", column: "done" });
    expect(res.to).toBe("done");
  });

  test("--force bypasses lifecycle gate", async () => {
    const card = emptyCard({
      slug: "gate-force",
      column: "doing",
      body: [
        "Repo: EdgeVector/fkanban",
        `Head-Oid: ${oid}`,
        "Requires-Status: ci-required",
        "Kind: pr",
      ].join("\n"),
    });
    const node = fakeNode({
      cards: [card],
      ci: [{
        status_key: `fkanban:${oid}:ci-required`,
        repo: "fkanban",
        oid,
        context: "ci-required",
        state: "pending",
        log_excerpt: "",
        updated_at: "2026-07-17T00:00:00.000Z",
      }],
    });
    const res = await moveCmd({ cfg, node, slug: "gate-force", column: "done", force: true });
    expect(res.to).toBe("done");
  });

  test("no Requires-* → move to done without CI rows", async () => {
    const card = emptyCard({
      slug: "no-gate",
      column: "doing",
      body: "Repo: EdgeVector/fkanban\nKind: pr\n",
    });
    const node = fakeNode({ cards: [card], ci: [] });
    const res = await moveCmd({ cfg, node, slug: "no-gate", column: "done" });
    expect(res.to).toBe("done");
  });

  test("assertLifecycleMoveAllowed is no-op for non-terminal columns", async () => {
    const card = emptyCard({
      body: "Requires-Status: ci-required\n",
    });
    const node = fakeNode();
    await assertLifecycleMoveAllowed({
      node,
      card,
      targetColumn: "doing",
      terminalColumn: "done",
    });
  });
});
