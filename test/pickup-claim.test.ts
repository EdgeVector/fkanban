import { beforeEach, describe, expect, test } from "bun:test";

import { FkanbanError, type CasExpectation, type NodeClient, type QueryFilter, type QueryResponse, type QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { formatPickupClaim, isTrueIdlePickupClaim, pickupClaimResult } from "../src/commands/pickup_claim.ts";
import { showResult } from "../src/commands/show.ts";
import {
  boardToFields,
  cardToFields,
  emptyStructuredFields,
  findCard,
  nowIso,
  type Board,
  type Card,
} from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash" },
};

function casError(actual: unknown): FkanbanError {
  return new FkanbanError({
    code: "cas_conflict",
    message: "CAS precondition failed.",
    cause: { error: "cas_conflict", field: "column", expected: "todo", actual },
  });
}

function fakeNode(): NodeClient {
  const store = new Map<string, Map<string, Record<string, unknown>>>();
  const tableFor = (schemaHash: string) => {
    let t = store.get(schemaHash);
    if (!t) {
      t = new Map();
      store.set(schemaHash, t);
    }
    return t;
  };
  const rowsFor = (schemaHash: string, filter?: QueryFilter): QueryRow[] => {
    const t = tableFor(schemaHash);
    const entries = filter?.HashKey
      ? (t.has(filter.HashKey) ? [[filter.HashKey, t.get(filter.HashKey)!] as const] : [])
      : [...t.entries()].filter(([, fields]) =>
          !filter || Object.entries(filter).every(([field, value]) => fields[field] === value)
        );
    return entries.map(([hash, fields]) => ({ fields, key: { hash, range: null } }));
  };
  const checkExpected = (fields: Record<string, unknown>, expected?: CasExpectation) => {
    if (expected === undefined) return;
    const actual = fields[expected.field];
    if (expected.type === "absent") {
      if (actual !== undefined && actual !== "") throw casError(actual);
    } else if (actual !== expected.value) {
      throw casError(actual);
    }
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
    async createRecord({ schemaHash, fields, keyHash, expected }) {
      const table = tableFor(schemaHash);
      checkExpected(table.get(keyHash) ?? {}, expected);
      table.set(keyHash, fields);
    },
    async updateRecord({ schemaHash, fields, keyHash, expected }) {
      const table = tableFor(schemaHash);
      checkExpected(table.get(keyHash) ?? {}, expected);
      table.set(keyHash, fields);
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

function board(partial: Partial<Board> = {}): Board {
  const now = nowIso();
  return {
    slug: "default",
    title: "Default",
    body: "",
    columns: [...DEFAULT_COLUMNS],
    created_at: now,
    updated_at: now,
    ...partial,
  };
}

function card(partial: Partial<Card>): Card {
  const now = nowIso();
  return {
    slug: "card",
    title: "Card",
    body: "Repo: EdgeVector/fkanban\nBase: main\n\nWork unit.",
    board: "default",
    column: "todo",
    position: "10",
    assignee: "",
    tags: [],
    deps: [],
    created_at: now,
    updated_at: now,
    ...emptyStructuredFields(),
    kind: "pr",
    block_status: "none",
    repo: "EdgeVector/fkanban",
    base: "main",
    ...partial,
  };
}

async function seedBoard(node: NodeClient, b: Board) {
  await node.createRecord({
    schemaHash: cfg.schemaHashes.board!,
    keyHash: b.slug,
    fields: boardToFields(b),
  });
}

async function seedCard(node: NodeClient, c: Card) {
  await node.createRecord({
    schemaHash: cfg.schemaHashes.card!,
    keyHash: c.slug,
    fields: cardToFields(c),
  });
}

describe("pickup claim", () => {
  let node: NodeClient;

  beforeEach(async () => {
    node = fakeNode();
    await seedBoard(node, board());
  });

  test("claims the highest-priority ready card into doing", async () => {
    await seedCard(node, card({
      slug: "low",
      title: "Low",
      tags: ["p3"],
      created_at: "2026-01-01T00:00:00.000Z",
      body: "Repo: EdgeVector/fkanban\nBase: main\nPriority: P3\n\nLow.",
    }));
    await seedCard(node, card({
      slug: "high",
      title: "High",
      tags: ["p0"],
      created_at: "2026-01-02T00:00:00.000Z",
      body: "Repo: EdgeVector/fkanban\nBase: main\nPriority: P0\n\nHigh.",
    }));

    const result = await pickupClaimResult({
      cfg,
      node,
      worker: "worker-a",
    });

    expect(result.claimed).toBe(true);
    expect(result.reason).toBe("claimed");
    expect(result.card?.slug).toBe("high");
    expect(result.from).toBe("todo");
    expect(result.to).toBe("doing");
    expect(result.card?.assignee).toBe("worker-a");
    expect(result.card?.column).toBe("doing");

    const onBoard = await findCard(node, cfg, "high");
    expect(onBoard?.column).toBe("doing");
    expect(onBoard?.assignee).toBe("worker-a");
  });

  test("claims a todo dependent after its dependency is already done", async () => {
    await seedCard(node, card({
      slug: "host-track-shared-driver",
      title: "Shared driver",
      column: "done",
      body: "Repo: EdgeVector/last-stack\nBase: main\n\nMerged dependency.",
      repo: "EdgeVector/last-stack",
    }));
    await seedCard(node, card({
      slug: "host-track-agent-standing-and-pickup",
      title: "Dependent work",
      deps: ["host-track-shared-driver"],
      body: "Repo: EdgeVector/last-stack\nBase: main\n\nDependent.",
      repo: "EdgeVector/last-stack",
    }));

    const result = await pickupClaimResult({
      cfg,
      node,
      worker: "worker-a",
    });

    expect(result.claimed).toBe(true);
    expect(result.card?.slug).toBe("host-track-agent-standing-and-pickup");
    expect(result.scanned_ready).toBe(1);
    expect(result.diagnostics).toBeUndefined();

    const onBoard = await findCard(node, cfg, "host-track-agent-standing-and-pickup");
    expect(onBoard?.column).toBe("doing");
    expect(onBoard?.assignee).toBe("worker-a");
  });

  test("successful claim reports actionable todo blockers", async () => {
    await seedCard(node, card({
      slug: "human-hold",
      block_status: "needs_human",
      block_reason: "waiting on Tom",
    }));
    await seedCard(node, card({
      slug: "ready-work",
      tags: ["p1"],
      body: "Repo: EdgeVector/fkanban\nBase: main\nPriority: P1\n\nReady.",
    }));

    const result = await pickupClaimResult({ cfg, node, worker: "worker-a" });

    expect(result.claimed).toBe(true);
    expect(result.card?.slug).toBe("ready-work");
    expect(result.todo_count).toBe(1);
    expect(result.todo_blockers).toBe(0);
    expect(result.todo_blocker_exemplars).toBeUndefined();
    expect(result.diagnostics).toBeUndefined();
    expect(formatPickupClaim(result)).not.toContain("todo blockers");

    const human = await findCard(node, cfg, "human-hold");
    expect(human?.column).toBe("backlog");
    expect(human?.block_status).toBe("needs_human");
    expect(human?.block_reason).toBe("waiting on Tom");
  });

  test("claims a dependent when its done dependency is only available by point read", async () => {
    await seedCard(node, card({
      slug: "done-dep",
      title: "Done dependency",
      column: "done",
      body: "Repo: EdgeVector/fkanban\nBase: main\n\nMerged dependency.",
    }));
    await seedCard(node, card({
      slug: "dependent",
      title: "Dependent work",
      deps: ["done-dep"],
      body: "Repo: EdgeVector/fkanban\nBase: main\n\nDependent work.",
    }));

    const baseQueryAll = node.queryAll.bind(node);
    node.queryAll = async (args: Parameters<NodeClient["queryAll"]>[0]) => {
      const res = await baseQueryAll(args);
      if (args.schemaHash === cfg.schemaHashes.card && !args.filter) {
        const results = res.results.filter((row) => row.key.hash !== "done-dep");
        return { ...res, results, returned_count: results.length };
      }
      return res;
    };

    const result = await pickupClaimResult({
      cfg,
      node,
      worker: "worker-a",
    });

    expect(result.claimed).toBe(true);
    expect(result.card?.slug).toBe("dependent");
    expect(result.scanned_ready).toBe(1);

    const onBoard = await findCard(node, cfg, "dependent");
    expect(onBoard?.column).toBe("doing");
    expect(onBoard?.assignee).toBe("worker-a");
  });

  test("claims a dependency-ready todo card that show reports unblocked", async () => {
    await seedCard(node, card({
      slug: "done-dep",
      title: "Done dependency",
      column: "done",
      body: "Repo: EdgeVector/fkanban\nBase: main\n\nMerged dependency.",
    }));
    await seedCard(node, card({
      slug: "dependent",
      title: "Dependent work",
      deps: ["done-dep"],
      body: "Repo: EdgeVector/fkanban\nBase: main\n\nDependent work.",
    }));

    const baseQueryAll = node.queryAll.bind(node);
    node.queryAll = async (args: Parameters<NodeClient["queryAll"]>[0]) => {
      const res = await baseQueryAll(args);
      if (args.schemaHash === cfg.schemaHashes.card && !args.filter) {
        const results = res.results.filter((row) => row.key.hash !== "done-dep");
        return { ...res, results, returned_count: results.length };
      }
      return res;
    };

    const shown = await showResult({ cfg, node, slug: "dependent" });
    expect(shown.card.blocked).toBe(false);
    expect(shown.card.blockedBy).toEqual([]);
    expect(shown.card.missingDeps).toEqual([]);
    expect(shown.card.deps).toEqual(["done-dep"]);

    const result = await pickupClaimResult({
      cfg,
      node,
      worker: "worker-a",
    });

    expect(result.claimed).toBe(true);
    expect(result.card?.slug).toBe("dependent");
    expect(result.scanned_ready).toBe(1);

    const onBoard = await findCard(node, cfg, "dependent");
    expect(onBoard?.column).toBe("doing");
    expect(onBoard?.assignee).toBe("worker-a");
  });

  test("skips surface-overlapping in-flight work and claims the next card", async () => {
    await seedCard(node, card({
      slug: "inflight",
      column: "doing",
      repo: "EdgeVector/fold",
      surfaces: ["src/engine/**"],
      body: "Repo: EdgeVector/fold\nBase: main\nSurfaces: src/engine/**\n\nIn flight.",
    }));
    await seedCard(node, card({
      slug: "overlap-todo",
      repo: "EdgeVector/fold",
      surfaces: ["src/engine/foo.ts"],
      tags: ["p0"],
      body: "Repo: EdgeVector/fold\nBase: main\nPriority: P0\nSurfaces: src/engine/foo.ts\n\nOverlaps.",
      created_at: "2026-01-01T00:00:00.000Z",
    }));
    await seedCard(node, card({
      slug: "other-repo",
      repo: "EdgeVector/kanban",
      surfaces: ["src/cli.ts"],
      tags: ["p1"],
      body: "Repo: EdgeVector/kanban\nBase: main\nPriority: P1\nSurfaces: src/cli.ts\n\nOther.",
      created_at: "2026-01-02T00:00:00.000Z",
    }));

    const result = await pickupClaimResult({ cfg, node });
    expect(result.claimed).toBe(true);
    expect(result.card?.slug).toBe("other-repo");
    expect(result.skipped.some((s) => s.slug === "overlap-todo" && s.reason === "surface-overlap")).toBe(true);
  });

  test("ignores stale doing overlap rows when point-read truth is done", async () => {
    await seedCard(node, card({
      slug: "stale-peer",
      column: "done",
      repo: "EdgeVector/fkanban",
      surfaces: ["src/pickup/**"],
      body: "Repo: EdgeVector/fkanban\nBase: main\nSurfaces: src/pickup/**\n\nMerged peer.",
    }));
    await seedCard(node, card({
      slug: "overlap-todo",
      repo: "EdgeVector/fkanban",
      surfaces: ["src/pickup/claim.ts"],
      tags: ["p0"],
      body: "Repo: EdgeVector/fkanban\nBase: main\nPriority: P0\nSurfaces: src/pickup/claim.ts\n\nReady.",
    }));

    const stalePreview = card({
      slug: "stale-peer",
      column: "doing",
      repo: "EdgeVector/fkanban",
      surfaces: ["src/pickup/**"],
      body: "",
    });
    const baseQueryAll = node.queryAll.bind(node);
    node.queryAll = async (args: Parameters<NodeClient["queryAll"]>[0]) => {
      const res = await baseQueryAll(args);
      if (args.schemaHash === cfg.schemaHashes.card && !args.filter) {
        const results = res.results.map((row) =>
          row.key.hash === "stale-peer"
            ? { ...row, fields: cardToFields(stalePreview) }
            : row
        );
        return { ...res, results };
      }
      return res;
    };

    const result = await pickupClaimResult({ cfg, node, worker: "worker-a" });

    expect(result.claimed).toBe(true);
    expect(result.card?.slug).toBe("overlap-todo");
    expect(result.skipped.some((s) => s.slug === "overlap-todo" && s.reason === "surface-overlap")).toBe(false);

    const onBoard = await findCard(node, cfg, "overlap-todo");
    expect(onBoard?.column).toBe("doing");
    expect(onBoard?.assignee).toBe("worker-a");
  });

  test("dry-run selects without moving", async () => {
    await seedCard(node, card({ slug: "ready-one", tags: ["p1"] }));

    const result = await pickupClaimResult({ cfg, node, dryRun: true });
    expect(result.claimed).toBe(true);
    expect(result.reason).toBe("dry-run");
    expect(result.card?.slug).toBe("ready-one");

    const still = await findCard(node, cfg, "ready-one");
    expect(still?.column).toBe("todo");
  });

  test("exclude-repo and prefer-repo filter ordering", async () => {
    await seedCard(node, card({
      slug: "fold-card",
      repo: "EdgeVector/fold",
      tags: ["p0"],
      body: "Repo: EdgeVector/fold\nBase: main\nPriority: P0\n\nFold.",
      created_at: "2026-01-01T00:00:00.000Z",
    }));
    await seedCard(node, card({
      slug: "kanban-card",
      repo: "EdgeVector/kanban",
      tags: ["p2"],
      body: "Repo: EdgeVector/kanban\nBase: main\nPriority: P2\n\nKanban.",
      created_at: "2026-01-02T00:00:00.000Z",
    }));

    const excluded = await pickupClaimResult({
      cfg,
      node,
      excludeRepo: ["EdgeVector/fold"],
    });
    expect(excluded.card?.slug).toBe("kanban-card");
    expect(excluded.skipped.some((s) => s.reason === "exclude-repo")).toBe(true);

    // Reset fold card still in todo; re-seed kanban as doing so only fold remains
    node = fakeNode();
    await seedBoard(node, board());
    await seedCard(node, card({
      slug: "fold-card",
      repo: "EdgeVector/fold",
      tags: ["p2"],
      body: "Repo: EdgeVector/fold\nBase: main\nPriority: P2\n\nFold.",
      created_at: "2026-01-01T00:00:00.000Z",
    }));
    await seedCard(node, card({
      slug: "kanban-card",
      repo: "EdgeVector/kanban",
      tags: ["p0"],
      body: "Repo: EdgeVector/kanban\nBase: main\nPriority: P0\n\nKanban.",
      created_at: "2026-01-02T00:00:00.000Z",
    }));
    const preferred = await pickupClaimResult({
      cfg,
      node,
      preferRepo: ["EdgeVector/fold"],
    });
    // Lane policy: p0-now always beats prefer-repo (kanban P0 before fold P2).
    expect(preferred.card?.slug).toBe("kanban-card");
    expect(preferred.card?.lane).toBe("p0-now");

    // Among non-p0, prefer-repo still soft-boosts.
    node = fakeNode();
    await seedBoard(node, board());
    await seedCard(node, card({
      slug: "fold-card",
      repo: "EdgeVector/fold",
      tags: ["p2"],
      body: "Repo: EdgeVector/fold\nBase: main\nPriority: P2\n\nFold.",
      created_at: "2026-01-01T00:00:00.000Z",
    }));
    await seedCard(node, card({
      slug: "kanban-card",
      repo: "EdgeVector/kanban",
      tags: ["p2"],
      body: "Repo: EdgeVector/kanban\nBase: main\nPriority: P2\n\nKanban.",
      created_at: "2026-01-02T00:00:00.000Z",
    }));
    const preferredNonP0 = await pickupClaimResult({
      cfg,
      node,
      preferRepo: ["EdgeVector/fold"],
    });
    expect(preferredNonP0.card?.slug).toBe("fold-card");
  });

  test("at-capacity when doing count hits max-doing", async () => {
    await seedCard(node, card({ slug: "already-doing", column: "doing" }));
    await seedCard(node, card({ slug: "ready", tags: ["p0"] }));

    const result = await pickupClaimResult({ cfg, node, maxDoing: 1 });
    expect(result.claimed).toBe(false);
    expect(result.reason).toBe("at-capacity");
    expect(result.diagnostics?.scanned_active).toBe(2);
    expect(result.diagnostics?.counts["collision"]).toBe(1);
    expect(result.diagnostics?.counts["pickup-ready"]).toBe(1);
  });

  test("no-eligible when queue empty of ready work", async () => {
    await seedCard(node, card({
      slug: "blocked",
      deps: ["missing-dep"],
      body: "Repo: EdgeVector/fkanban\nBase: main\n\nBlocked.",
    }));
    // missing dep card itself
    await seedCard(node, card({
      slug: "missing-dep",
      column: "todo",
      body: "Repo: EdgeVector/fkanban\nBase: main\n\nDep.",
    }));
    // Wait - if missing-dep is also ready, blocked isn't ready. claim might take missing-dep.
    // Seed only a human-gated card:
    node = fakeNode();
    await seedBoard(node, board());
    await seedCard(node, card({
      slug: "human",
      block_status: "needs_human",
      block_reason: "waiting on Tom",
    }));

    const result = await pickupClaimResult({ cfg, node });
    expect(result.claimed).toBe(false);
    expect(result.reason).toBe("no-eligible");
    expect(result.scanned_ready).toBe(0);
    expect(result.todo_count).toBe(0);
    expect(result.todo_blockers).toBe(0);
    expect(result.diagnostics?.scanned_active).toBe(1);
    expect(result.diagnostics?.ready).toBe(0);
    expect(result.diagnostics?.counts["human-gated"]).toBe(1);

    const human = await findCard(node, cfg, "human");
    expect(human?.column).toBe("backlog");
  });

  test("no-eligible reports zero todo count when todo queue is empty", async () => {
    const result = await pickupClaimResult({ cfg, node });

    expect(result.claimed).toBe(false);
    expect(result.reason).toBe("no-eligible");
    expect(result.scanned_ready).toBe(0);
    expect(result.skipped).toEqual([]);
    expect(result.todo_count).toBe(0);
    expect(result.todo_blockers).toBe(0);
    expect(result.todo_blocker_exemplars).toBeUndefined();
    expect(result.diagnostics?.scanned_active).toBe(0);
    expect(result.diagnostics?.ready).toBe(0);
    expect(result.diagnostics?.inflight_without_artifact).toBe(0);
    expect(result.diagnostics?.inflight_without_artifact_exemplars).toBeUndefined();
    expect(isTrueIdlePickupClaim(result)).toBe(true);
    expect(formatPickupClaim(result)).toContain(
      "idle: true empty pickup queue (no ready candidates were skipped)",
    );
  });

  test("supported validation proof cards do not count as todo blockers", async () => {
    await seedCard(node, card({
      slug: "terminal-validation",
      kind: "validation",
      body: "Kind: validation\nDONE-WHEN: file src/pickup.ts matches /buildPickupStatusReport/\n",
    }));

    const result = await pickupClaimResult({ cfg, node });

    expect(result.claimed).toBe(false);
    expect(result.reason).toBe("no-eligible");
    expect(result.scanned_ready).toBe(0);
    expect(result.todo_count).toBe(1);
    expect(result.todo_blockers).toBe(0);
    expect(result.todo_blocker_exemplars).toBeUndefined();
    expect(result.diagnostics?.counts["parked/non-work"]).toBe(1);
    expect(result.diagnostics?.todo_blockers).toBe(0);
    expect(isTrueIdlePickupClaim(result)).toBe(true);
  });

  test("malformed validation proof cards remain visible as todo blockers", async () => {
    await seedCard(node, card({
      slug: "valid-validation",
      kind: "validation",
      body: "Kind: validation\nDONE-WHEN: file src/pickup.ts matches /buildPickupStatusReport/\n",
    }));
    await seedCard(node, card({
      slug: "malformed-validation",
      kind: "validation",
      body: "Kind: validation\nDONE-WHEN: production looks healthy\n",
    }));

    const result = await pickupClaimResult({ cfg, node });

    expect(result.claimed).toBe(false);
    expect(result.reason).toBe("no-eligible");
    expect(result.todo_count).toBe(2);
    expect(result.todo_blockers).toBe(1);
    expect(result.todo_blocker_exemplars).toEqual([{
      slug: "malformed-validation",
      category: "parked/non-work",
      reason: "non-pickup kind: validation",
      suggestion: "Leave grouping/tracker/program/capstone/validation cards out of default todo, or split a concrete PR card.",
    }]);
    expect(result.diagnostics?.counts["parked/non-work"]).toBe(2);
  });

  test("no-eligible reports zero todo count for backlog and doing only", async () => {
    await seedCard(node, card({
      slug: "parked",
      column: "backlog",
      body: "Repo: EdgeVector/fkanban\nBase: main\n\nParked work.",
    }));
    await seedCard(node, card({
      slug: "inflight",
      column: "doing",
      body: "Repo: EdgeVector/fkanban\nBase: main\n\nIn flight.",
    }));

    const result = await pickupClaimResult({ cfg, node });

    expect(result.claimed).toBe(false);
    expect(result.reason).toBe("no-eligible");
    expect(result.scanned_ready).toBe(0);
    expect(result.todo_count).toBe(0);
    expect(result.diagnostics?.scanned_active).toBe(2);
    expect(result.diagnostics?.counts["parked/non-work"]).toBe(1);
    expect(result.diagnostics?.counts.collision).toBe(1);
    expect(result.diagnostics?.inflight_without_artifact).toBe(1);
    expect(result.diagnostics?.inflight_without_artifact_exemplars).toEqual([{
      slug: "inflight",
      category: "collision",
      reason: "card is already in doing",
      suggestion: "Do not pick up again; reconcile the existing branch/PR or move it back to todo.",
    }]);
  });

  test("no-eligible diagnostics ignore doing cards that already have review artifacts", async () => {
    await seedCard(node, card({
      slug: "inflight-with-pr",
      column: "doing",
      pr_url: "lastgit://fkanban/cr/cr-123",
      branch: "kanban/inflight-with-pr",
      body: "Repo: EdgeVector/fkanban\nBase: main\n\nIn flight with CR.",
    }));
    await seedCard(node, card({
      slug: "inflight-with-branch",
      column: "doing",
      branch: "kanban/inflight-with-branch",
      body: "Repo: EdgeVector/fkanban\nBase: main\n\nIn flight with branch.",
    }));

    const result = await pickupClaimResult({ cfg, node });

    expect(result.claimed).toBe(false);
    expect(result.reason).toBe("no-eligible");
    expect(result.diagnostics?.counts.collision).toBe(2);
    expect(result.diagnostics?.inflight_without_artifact).toBe(0);
    expect(result.diagnostics?.inflight_without_artifact_exemplars).toBeUndefined();
  });

  test("no-eligible diagnostics include malformed routing exemplars", async () => {
    await seedCard(node, card({
      slug: "bad-repo",
      repo: "not-a-repo",
      body: "Base: main\n\nMalformed routing.",
    }));

    const result = await pickupClaimResult({ cfg, node });

    expect(result.claimed).toBe(false);
    expect(result.reason).toBe("no-eligible");
    expect(result.scanned_ready).toBe(0);
    expect(result.diagnostics?.counts["malformed-routing"]).toBe(1);
    expect(result.diagnostics?.exemplars).toEqual([{
      slug: "bad-repo",
      category: "malformed-routing",
      reason: "invalid structured repo: not-a-repo",
      suggestion: "Set a bare `Repo: owner/name` header or `--repo owner/name`.",
    }]);
  });

  test("no-eligible diagnostics include stale done_at exemplars", async () => {
    await seedCard(node, card({
      slug: "reopened-with-done-at",
      column: "backlog",
      done_at: "2026-07-17T08:00:00.000Z",
    }));

    const result = await pickupClaimResult({ cfg, node });

    expect(result.claimed).toBe(false);
    expect(result.reason).toBe("no-eligible");
    expect(result.scanned_ready).toBe(0);
    expect(result.diagnostics?.counts["stale-metadata"]).toBe(1);
    expect(result.diagnostics?.exemplars).toEqual([{
      slug: "reopened-with-done-at",
      category: "stale-metadata",
      reason: "non-done card still has done_at metadata",
      suggestion: "Clear done_at on the reopened or parked card so pickup diagnostics reflect its live state.",
    }]);
  });

  test("self-heals stale generated pickup overlap hold before claiming", async () => {
    await seedCard(node, card({
      slug: "stale-overlap",
      repo: "EdgeVector/fkanban",
      base: "main",
      block_status: "needs_human",
      block_reason: "Pickup area overlap: shares area:pickup with old-peer in doing; serialize or retag one card.",
      tags: ["area:pickup", "p0"],
      body:
        "Repo: EdgeVector/fkanban\nBase: main\nPriority: P0\n\n" +
        "BLOCKED: fkanban-pickup cannot pick up stale overlap metadata.\nImplement it.",
    }));
    await seedCard(node, card({
      slug: "old-peer",
      column: "done",
      repo: "EdgeVector/fkanban",
      base: "main",
      tags: ["area:pickup"],
    }));

    const result = await pickupClaimResult({ cfg, node, worker: "worker-a" });

    expect(result.claimed).toBe(true);
    expect(result.card?.slug).toBe("stale-overlap");
    expect(result.diagnostics?.counts["stale-metadata"] ?? 0).toBe(0);

    const onBoard = await findCard(node, cfg, "stale-overlap");
    expect(onBoard?.column).toBe("doing");
    expect(onBoard?.assignee).toBe("worker-a");
    expect(onBoard?.block_status).toBe("none");
    expect(onBoard?.block_reason).toBe("");
    expect(onBoard?.body).not.toContain("BLOCKED: fkanban-pickup");
  });

  test("keeps active generated overlap protected and parks real human holds", async () => {
    await seedCard(node, card({
      slug: "active-peer",
      column: "doing",
      repo: "EdgeVector/fkanban",
      base: "main",
      tags: ["area:pickup"],
    }));
    await seedCard(node, card({
      slug: "active-overlap",
      repo: "EdgeVector/fkanban",
      base: "main",
      block_status: "needs_human",
      block_reason: "Pickup area overlap: shares area:pickup with active-peer in doing; serialize or retag one card.",
      tags: ["area:pickup", "p0"],
    }));
    await seedCard(node, card({
      slug: "human-hold",
      repo: "EdgeVector/fkanban",
      base: "main",
      block_status: "needs_human",
      block_reason: "waiting on Tom",
      tags: ["p1"],
    }));

    const result = await pickupClaimResult({ cfg, node, worker: "worker-a" });

    expect(result.claimed).toBe(false);
    expect(result.reason).toBe("no-eligible");
    expect(result.diagnostics?.counts["human-gated"]).toBe(2);

    const overlap = await findCard(node, cfg, "active-overlap");
    expect(overlap?.block_status).toBe("needs_human");
    expect(overlap?.block_reason).toContain("active-peer");

    const human = await findCard(node, cfg, "human-hold");
    expect(human?.column).toBe("backlog");
    expect(human?.block_status).toBe("needs_human");
    expect(human?.block_reason).toBe("waiting on Tom");
  });

  test("no-eligible diagnostics do not call legacy registry fallback non-pickup kind pr", async () => {
    await seedCard(node, card({
      slug: "legacy-registry",
      kind: "",
      body: "Repo: EdgeVector/fkanban\nBase: main\n\nTarget: fbrain record `dogfood-registry`.",
    }));

    const result = await pickupClaimResult({ cfg, node });

    expect(result.claimed).toBe(false);
    expect(result.reason).toBe("no-eligible");
    expect(result.scanned_ready).toBe(0);
    expect(result.diagnostics?.counts["parked/non-work"]).toBe(1);
    expect(result.diagnostics?.exemplars).toEqual([{
      slug: "legacy-registry",
      category: "parked/non-work",
      reason: "registry/recipe card",
      suggestion: "Registry/recipe cards target brain records, not code PRs; file a concrete PR card with explicit kind: pr when code is ready.",
    }]);
  });

  test("pickup claims explicit pr cards even when their body mentions registry keywords", async () => {
    await seedCard(node, card({
      slug: "explicit-pr-registry-keyword",
      kind: "pr",
      body: "Repo: EdgeVector/fkanban\nBase: main\n\nUpdate dogfood-registry via code.",
    }));

    const result = await pickupClaimResult({ cfg, node, worker: "worker-a" });

    expect(result.claimed).toBe(true);
    expect(result.reason).toBe("claimed");
    expect(result.card?.slug).toBe("explicit-pr-registry-keyword");
    expect(result.card?.kind).toBe("pr");
  });

  test("no-eligible diagnostics sample every non-ready blocker category", async () => {
    await seedCard(node, card({
      slug: "dep-in-progress",
      column: "doing",
      body: "Repo: EdgeVector/fkanban\nBase: main\n\nDependency in progress.",
    }));
    await seedCard(node, card({
      slug: "blocked-child",
      deps: ["dep-in-progress"],
      body: "Repo: EdgeVector/fkanban\nBase: main\n\nBlocked on dep.",
    }));
    await seedCard(node, card({
      slug: "human-hold",
      block_status: "needs_human",
      block_reason: "waiting on Tom",
    }));
    await seedCard(node, card({
      slug: "parked-tracker",
      kind: "tracker",
      body: "Repo: EdgeVector/fkanban\nBase: main\n\nTracker.",
    }));
    await seedCard(node, card({
      slug: "inflight",
      column: "doing",
      body: "Repo: EdgeVector/fkanban\nBase: main\n\nAlready claimed.",
    }));

    const result = await pickupClaimResult({ cfg, node });

    expect(result.claimed).toBe(false);
    expect(result.reason).toBe("no-eligible");
    expect(result.scanned_ready).toBe(0);
    expect(result.skipped).toEqual([]);
    expect(result.diagnostics?.counts["blocked-on-dependency"]).toBe(1);
    expect(result.diagnostics?.counts["human-gated"]).toBe(1);
    expect(result.diagnostics?.counts["parked/non-work"]).toBe(1);
    expect(result.diagnostics?.counts.collision).toBe(2);
    expect(result.diagnostics?.exemplars).toEqual(expect.arrayContaining([
      expect.objectContaining({
        slug: "blocked-child",
        category: "blocked-on-dependency",
        reason: "unfinished dependency",
      }),
      expect.objectContaining({
        slug: "human-hold",
        category: "human-gated",
        reason: "intentional hold: needs_human",
      }),
      expect.objectContaining({
        slug: "parked-tracker",
        category: "parked/non-work",
        reason: "non-pickup kind: tracker",
      }),
      expect.objectContaining({
        slug: "dep-in-progress",
        category: "collision",
        reason: "card is already in doing",
      }),
    ]));
  });

  test("no-eligible when every ready candidate is skipped", async () => {
    await seedCard(node, card({
      slug: "fold-card",
      repo: "EdgeVector/fold",
      body: "Repo: EdgeVector/fold\nBase: main\nPriority: P1\n\nFold.",
    }));
    await seedCard(node, card({
      slug: "human",
      block_status: "needs_human",
      block_reason: "waiting on Tom",
    }));

    const result = await pickupClaimResult({
      cfg,
      node,
      excludeRepo: ["EdgeVector/fold"],
    });

    expect(result.claimed).toBe(false);
    expect(result.reason).toBe("no-eligible");
    expect(result.scanned_ready).toBe(1);
    expect(result.diagnostics?.scanned_active).toBe(2);
    expect(result.diagnostics?.ready).toBe(1);
    expect(result.diagnostics?.counts["pickup-ready"]).toBe(1);
    expect(result.diagnostics?.counts["human-gated"]).toBe(1);
    expect(result.skipped).toContainEqual({
      slug: "fold-card",
      reason: "exclude-repo",
      detail: "EdgeVector/fold",
    });
    expect(isTrueIdlePickupClaim(result)).toBe(false);
    expect(formatPickupClaim(result)).toContain(
      "idle: false (ready candidates were skipped or blocked; do not enter idle mode)",
    );
  });

  test("claim_conflict on first candidate falls through to second", async () => {
    await seedCard(node, card({
      slug: "first",
      tags: ["p0"],
      created_at: "2026-01-01T00:00:00.000Z",
      body: "Repo: EdgeVector/a\nBase: main\nPriority: P0\n\nFirst.",
      repo: "EdgeVector/a",
    }));
    await seedCard(node, card({
      slug: "second",
      tags: ["p1"],
      created_at: "2026-01-02T00:00:00.000Z",
      body: "Repo: EdgeVector/b\nBase: main\nPriority: P1\n\nSecond.",
      repo: "EdgeVector/b",
    }));

    // Pre-move first to doing under CAS so claim sees conflict when it tries first
    // Simulate race: another worker already moved first between status and move.
    // Easiest: wrap updateRecord to fail CAS once for "first".
    const baseUpdate = node.updateRecord.bind(node);
    let firstAttempts = 0;
    node.updateRecord = async (args) => {
      if (args.keyHash === "first" && args.expected?.type === "value" && args.expected.value === "todo") {
        firstAttempts += 1;
        throw casError("doing");
      }
      return baseUpdate(args);
    };

    const result = await pickupClaimResult({ cfg, node });
    expect(firstAttempts).toBeGreaterThanOrEqual(1);
    expect(result.claimed).toBe(true);
    expect(result.card?.slug).toBe("second");
    expect(result.skipped.some((s) => s.slug === "first" && s.reason === "claim_conflict")).toBe(true);
  });
});
