// Unit tests for LastgitCiStatus join + opt-in terminal move gates.
// Fake NodeClient only — no live LastDB / lastgit.

import { describe, expect, test } from "bun:test";

import type { NodeClient, QueryFilter, QueryResponse, QueryRow } from "../src/client.ts";
import { FkanbanError } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { nowIso, type Card } from "../src/record.ts";
import {
  assertLifecycleMoveAllowed,
  attachPipelineStatus,
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
  requiredContexts,
  resolveCardOid,
  CI_STATUS_SCHEMA,
  CR_SCHEMA,
  REF_SCHEMA,
} from "../src/pipeline_status.ts";
import { showResult } from "../src/commands/show.ts";
import { moveCmd } from "../src/commands/move.ts";
import { boardToFields, cardToFields } from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";

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

function fakeNode(seed?: {
  ci?: Record<string, unknown>[];
  refs?: Record<string, unknown>[];
  crs?: Record<string, unknown>[];
  cards?: Card[];
  boards?: { slug: string; columns: string[] }[];
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
  for (const row of seed?.refs ?? []) {
    const key = String(row.rkey ?? `${row.repo}:${row.name}`);
    tableFor(REF_SCHEMA).set(key, row);
  }
  for (const row of seed?.crs ?? []) {
    const key = String(row.cr_key ?? `${row.repo}:${row.cr_id}`);
    tableFor(CR_SCHEMA).set(key, row);
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
    listSchemas: notImpl("listSchemas"),
    async createRecord({ schemaHash, fields, keyHash }) {
      tableFor(schemaHash).set(keyHash, fields);
    },
    async updateRecord({ schemaHash, fields, keyHash }) {
      tableFor(schemaHash).set(keyHash, { ...tableFor(schemaHash).get(keyHash), ...fields });
    },
    async deleteRecord({ schemaHash, keyHash }) {
      tableFor(schemaHash).delete(keyHash);
    },
    async queryAll({ schemaHash, filter }): Promise<QueryResponse> {
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
