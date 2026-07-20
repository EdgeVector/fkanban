import { beforeEach, describe, expect, test } from "bun:test";

import type { Config } from "../src/config.ts";
import type { NodeClient, QueryFilter, QueryResponse, QueryRow } from "../src/client.ts";
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
import { pickupStatusResult } from "../src/commands/pickup_status.ts";
import { groomStaleBlockersResult } from "../src/commands/groom.ts";
import { moveCmd } from "../src/commands/move.ts";
import { HUMAN_BOARD_COLUMNS, PICKUP_CATEGORIES } from "../src/pickup.ts";
import type { SituationPreflight } from "../src/situations.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash" },
};

const minimalNodeFence = {
  situation: {
    slug: "fold-db-node-major-simplification",
    links_brain: ["north-star-lastdb-minimal-node"],
    allowed_actions: [],
  },
  action: "file-fold-db-node-feature-card",
  message: "Only north-star-lastdb-minimal-node cards may modify fold_db_node.",
};

const foldDbNodeFencePreflight: SituationPreflight = async ({ action }) => {
  if (action === "file-fold-db-node-feature-card") {
    return { ok: false, blocks: [minimalNodeFence] };
  }
  return { ok: false, blocks: [minimalNodeFence] };
};

const modifyFoldDbNodeFence = {
  situation: {
    slug: "fold-db-node-dmg-temporary-deprecation",
    links_brain: [],
    allowed_actions: [],
  },
  action: "modify-fold-db-node",
  message: "fold_db_node modification is temporarily frozen.",
};

function fakeNode(): NodeClient {
  const store = new Map<string, Map<string, Record<string, unknown>>>();
  const tableFor = (schemaHash: string) => {
    let table = store.get(schemaHash);
    if (!table) {
      table = new Map();
      store.set(schemaHash, table);
    }
    return table;
  };
  const rowsFor = (schemaHash: string, filter?: QueryFilter, wantedFields?: string[]): QueryRow[] => {
    const table = tableFor(schemaHash);
    const entries = filter?.HashKey
      ? (table.has(filter.HashKey) ? [[filter.HashKey, table.get(filter.HashKey)!] as const] : [])
      : [...table.entries()].filter(([, fields]) =>
          !filter || Object.entries(filter).every(([field, value]) => fields[field] === value)
        );
    return entries.map(([hash, fields]) => ({
      fields: wantedFields
        ? Object.fromEntries(wantedFields.filter((field) => field in fields).map((field) => [field, fields[field]]))
        : fields,
      key: { hash, range: null },
    }));
  };
  const notImpl = (method: string) => async (): Promise<never> => {
    throw new Error(`fakeNode.${method} not implemented`);
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
      tableFor(schemaHash).set(keyHash, fields);
    },
    async deleteRecord({ schemaHash, keyHash }) {
      tableFor(schemaHash).delete(keyHash);
    },
    async queryAll({ schemaHash, fields, filter }): Promise<QueryResponse> {
      const results = rowsFor(schemaHash, filter, fields);
      return { ok: true, results, returned_count: results.length, total_count: results.length };
    },
    rawCall: notImpl("rawCall") as NodeClient["rawCall"],
    nodeTransport: () => ({ transport: "unavailable" as const }),
  };
}

function board(partial: Partial<Board>): Board {
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
    body: "",
    board: "default",
    column: "todo",
    position: String(Date.now()),
    assignee: "",
    tags: [],
    deps: [],
    created_at: now,
    updated_at: now,
    ...emptyStructuredFields(),
    kind: "pr",
    block_status: "none",
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

describe("pickup-status", () => {
  let node: NodeClient;

  beforeEach(async () => {
    node = fakeNode();
    await seedBoard(node, board({ slug: "default", columns: [...DEFAULT_COLUMNS] }));
    await seedBoard(node, board({ slug: "human", title: "Human", columns: [...HUMAN_BOARD_COLUMNS] }));
  });

  test("classifies ready, dependency-blocked, human-gated, malformed, parked, and collision cards", async () => {
    await seedCard(node, card({ slug: "ready", repo: "EdgeVector/fkanban", base: "main" }));
    await seedCard(node, card({ slug: "dep", repo: "EdgeVector/fkanban", base: "main", column: "doing" }));
    await seedCard(node, card({ slug: "blocked", repo: "EdgeVector/fkanban", base: "main", deps: ["dep"] }));
    await seedCard(node, card({ slug: "human", board: "human", repo: "EdgeVector/fkanban", base: "main", block_status: "needs_human" }));
    await seedCard(node, card({ slug: "malformed", repo: "", base: "main", body: "No routing header" }));
    await seedCard(node, card({ slug: "tracker", kind: "tracker", repo: "EdgeVector/fkanban", base: "main" }));
    await seedCard(node, card({ slug: "backlog", repo: "EdgeVector/fkanban", base: "main", column: "backlog" }));
    await seedCard(node, card({ slug: "backlog-blocked", repo: "EdgeVector/fkanban", base: "main", column: "backlog", deps: ["dep"] }));
    await seedCard(node, card({ slug: "inflight", repo: "EdgeVector/fkanban", base: "main", column: "doing", branch: "fkanban/inflight" }));

    const { report } = await pickupStatusResult({ cfg, node });
    const bySlug = new Map(report.cards.map((c) => [c.slug, c]));

    expect(bySlug.get("ready")?.category).toBe("pickup-ready");
    expect(bySlug.get("blocked")?.category).toBe("blocked-on-dependency");
    expect(bySlug.get("human")?.category).toBe("human-gated");
    expect(bySlug.get("malformed")?.category).toBe("malformed-routing");
    expect(bySlug.get("tracker")?.category).toBe("parked/non-work");
    expect(bySlug.get("backlog")?.category).toBe("parked/non-work");
    expect(bySlug.get("backlog")?.reason).toBe("card is parked in backlog");
    expect(bySlug.get("backlog-blocked")?.category).toBe("blocked-on-dependency");
    expect(bySlug.get("inflight")?.category).toBe("collision");
    for (const category of PICKUP_CATEGORIES) {
      expect(report.counts[category]).toBeGreaterThanOrEqual(0);
    }
  });

  test("classifies a todo dependent as ready after its dependency is done", async () => {
    await seedCard(node, card({
      slug: "host-track-migrate-brain",
      title: "Migrate brain",
      column: "done",
      body: "Repo: EdgeVector/last-stack\nBase: main\n\nMerged dependency.",
      repo: "EdgeVector/last-stack",
    }));
    await seedCard(node, card({
      slug: "host-track-multi-app-refresh-agent",
      title: "Multi-app refresh agent",
      deps: ["host-track-migrate-brain"],
      body: "Repo: EdgeVector/last-stack\nBase: main\n\nDependent work.",
      repo: "EdgeVector/last-stack",
    }));

    const { report } = await pickupStatusResult({ cfg, node });
    const dependent = report.cards.find((c) => c.slug === "host-track-multi-app-refresh-agent");

    expect(dependent?.category).toBe("pickup-ready");
    expect(dependent?.ready).toBe(true);
    expect(dependent?.blockedBy).toEqual([]);
    expect(dependent?.missingDeps).toEqual([]);
  });

  test("point-reads done dependencies omitted from the broad status scan", async () => {
    await seedCard(node, card({
      slug: "done-dep",
      title: "Completed dependency",
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

    const { report } = await pickupStatusResult({ cfg, node });
    const dependent = report.cards.find((c) => c.slug === "dependent");

    expect(dependent?.category).toBe("pickup-ready");
    expect(dependent?.blockedBy).toEqual([]);
    expect(dependent?.missingDeps).toEqual([]);
  });

  test("reports stale generated blocker metadata separately from real human gates", async () => {
    await seedCard(node, card({
      slug: "stale",
      repo: "EdgeVector/fkanban",
      base: "main",
      body: "Repo: EdgeVector/fkanban\nBase: main\n\nBLOCKED: fkanban-pickup cannot resolve Repo header.",
    }));
    await seedCard(node, card({
      slug: "real-human",
      repo: "EdgeVector/fkanban",
      base: "main",
      block_status: "needs_human",
      block_reason: "waiting on Tom",
    }));

    const { report } = await pickupStatusResult({ cfg, node });
    const bySlug = new Map(report.cards.map((c) => [c.slug, c.category]));
    expect(bySlug.get("stale")).toBe("stale-metadata");
    expect(bySlug.get("real-human")).toBe("human-gated");
  });

  test("reports non-done cards with done_at as stale metadata", async () => {
    await seedCard(node, card({
      slug: "reopened-with-done-at",
      repo: "EdgeVector/fkanban",
      base: "main",
      column: "backlog",
      done_at: "2026-07-17T08:00:00.000Z",
    }));

    const { report } = await pickupStatusResult({ cfg, node });
    const stale = report.cards.find((c) => c.slug === "reopened-with-done-at");

    expect(stale?.category).toBe("stale-metadata");
    expect(stale?.reason).toBe("non-done card still has done_at metadata");
    expect(stale?.suggestion).toContain("Clear done_at");
    expect(report.counts["stale-metadata"]).toBe(1);
  });

  test("preflights Situation-fenced pickup candidates and allows matching north-star cards", async () => {
    await seedCard(node, card({
      slug: "org-invite",
      repo: "EdgeVector/fold",
      base: "main",
      tags: ["fold_db_node"],
      north_star: "north-star-org-invite-via-link",
    }));
    await seedCard(node, card({
      slug: "strip-card",
      repo: "EdgeVector/fold",
      base: "main",
      tags: ["fold_db_node"],
      north_star: "north-star-lastdb-minimal-node",
    }));

    const { report } = await pickupStatusResult({ cfg, node, situationPreflight: foldDbNodeFencePreflight });
    const bySlug = new Map(report.cards.map((c) => [c.slug, c]));

    expect(bySlug.get("org-invite")?.category).toBe("situation-fenced");
    expect(bySlug.get("org-invite")?.ready).toBe(false);
    expect(bySlug.get("org-invite")?.reason).toContain("fold-db-node-major-simplification");
    expect(bySlug.get("strip-card")?.category).toBe("pickup-ready");
  });

  test("fences fold_db_node cards when only modify-fold-db-node is blocked", async () => {
    const checkedActions: string[] = [];
    const modifyOnlyFencePreflight: SituationPreflight = async ({ action }) => {
      checkedActions.push(action);
      if (action === "modify-fold-db-node") {
        return { ok: false, blocks: [modifyFoldDbNodeFence] };
      }
      return { ok: true, checked: { action } };
    };
    await seedCard(node, card({
      slug: "node-removal",
      repo: "EdgeVector/fold",
      base: "main",
      body: "Repo: EdgeVector/fold\nBase: main\n\nTouch fold_db_node cleanup.",
    }));

    const { report } = await pickupStatusResult({ cfg, node, situationPreflight: modifyOnlyFencePreflight });
    const fenced = report.cards.find((c) => c.slug === "node-removal");

    expect(checkedActions).toContain("file-fold-db-node-feature-card");
    expect(checkedActions).toContain("modify-fold-db-node");
    expect(fenced?.category).toBe("situation-fenced");
    expect(fenced?.ready).toBe(false);
    expect(fenced?.details).toContain("action: modify-fold-db-node");
  });

  test("leaves fold_db_node cards pickup-ready when neither relevant action is blocked", async () => {
    const checkedActions: string[] = [];
    const noFencePreflight: SituationPreflight = async ({ action }) => {
      checkedActions.push(action);
      return { ok: true, checked: { action } };
    };
    await seedCard(node, card({
      slug: "node-observability",
      repo: "EdgeVector/fold",
      base: "main",
      tags: ["fold_db_node"],
    }));

    const { report } = await pickupStatusResult({ cfg, node, situationPreflight: noFencePreflight });
    const eligible = report.cards.find((c) => c.slug === "node-observability");

    expect(checkedActions).toContain("file-fold-db-node-feature-card");
    expect(checkedActions).toContain("modify-fold-db-node");
    expect(eligible?.category).toBe("pickup-ready");
    expect(eligible?.ready).toBe(true);
  });

  test("refuses moving a Situation-fenced candidate to doing without writing", async () => {
    await seedCard(node, card({
      slug: "org-invite",
      repo: "EdgeVector/fold",
      base: "main",
      tags: ["fold_db_node"],
      north_star: "north-star-org-invite-via-link",
    }));

    await expect(moveCmd({
      cfg,
      node,
      slug: "org-invite",
      column: "doing",
      situationPreflight: foldDbNodeFencePreflight,
    })).rejects.toMatchObject({
      code: "situation_fenced",
    });
    expect((await findCard(node, cfg, "org-invite"))?.column).toBe("todo");
  });
});

describe("groom stale-blockers", () => {
  let node: NodeClient;

  beforeEach(async () => {
    node = fakeNode();
    await seedBoard(node, board({ slug: "default", columns: [...DEFAULT_COLUMNS] }));
  });

  test("dry-run reports applyable generated cleanup without writing", async () => {
    await seedCard(node, card({
      slug: "routing-fixed",
      body:
        "Repo: EdgeVector/fkanban  # stale inline note\nBase: main\n\n" +
        "BLOCKED: fkanban-pickup cannot resolve Repo header.\nKeep this context.",
    }));

    const { report } = await groomStaleBlockersResult({ cfg, node });
    expect(report.dryRun).toBe(true);
    expect(report.changed).toBe(1);
    expect(report.cards[0]?.issues.map((i) => i.kind)).toContain("malformed-repo-header");
    expect(report.cards[0]?.issues.map((i) => i.kind)).toContain("stale-blocked-prose");

    const after = await findCard(node, cfg, "routing-fixed");
    expect(after?.body).toContain("# stale inline note");
    expect(after?.body).toContain("BLOCKED:");
  });

  test("apply rewrites only generated blocker artifacts", async () => {
    await seedCard(node, card({
      slug: "routing-fixed",
      body:
        "Repo: EdgeVector/fkanban  # stale inline note\nBase: main\n\n" +
        "BLOCKED: fkanban-pickup cannot resolve Repo header.\nKeep this context.",
    }));
    await seedCard(node, card({
      slug: "overlap-stale",
      repo: "EdgeVector/fkanban",
      base: "main",
      block_status: "needs_human",
      block_reason: "Pickup area overlap: shares area:fkanban-list with old-peer in doing; serialize or retag one card.",
    }));
    await seedCard(node, card({
      slug: "real-human",
      repo: "EdgeVector/fkanban",
      base: "main",
      block_status: "needs_human",
      block_reason: "waiting on Tom",
    }));

    const { report } = await groomStaleBlockersResult({ cfg, node, apply: true });
    expect(report.dryRun).toBe(false);
    expect(report.changed).toBe(3);

    const routing = await findCard(node, cfg, "routing-fixed");
    expect(routing?.body).toContain("Repo: EdgeVector/fkanban\n");
    expect(routing?.body).not.toContain("BLOCKED:");
    expect(routing?.body).toContain("Keep this context.");

    const overlap = await findCard(node, cfg, "overlap-stale");
    expect(overlap?.block_status).toBe("none");
    expect(overlap?.block_reason).toBe("");
    const overlapReport = report.cards.find((c) => c.slug === "overlap-stale");
    expect(overlapReport?.issues.map((i) => i.kind)).not.toContain("block-status-mismatch");

    const human = await findCard(node, cfg, "real-human");
    expect(human?.column).toBe("backlog");
    expect(human?.block_status).toBe("needs_human");
    expect(human?.block_reason).toBe("waiting on Tom");
    const humanReport = report.cards.find((c) => c.slug === "real-human");
    expect(humanReport?.changed).toBe(true);
    expect(humanReport?.issues.map((i) => i.kind)).toContain("human-parking-candidate");
  });

  test("reports a copyable missing DONE-WHEN fix list for supported non-PR cards", async () => {
    await seedCard(node, card({
      slug: "tracker-missing",
      kind: "tracker",
      column: "backlog",
      body: "Kind: tracker\n\nTrack the rollout.",
    }));
    await seedCard(node, card({
      slug: "validation-malformed",
      kind: "validation",
      column: "doing",
      body: "Kind: validation\nDONE-WHEN: production looks healthy\n",
    }));
    await seedCard(node, card({
      slug: "meta-supported",
      kind: "meta",
      column: "backlog",
      body: "Kind: meta\nDONE-WHEN: brain active-programs updated-after 2026-07-17\n",
    }));

    const { text, report } = await groomStaleBlockersResult({ cfg, node });
    const bySlug = new Map(report.cards.map((c) => [c.slug, c]));

    expect(bySlug.get("tracker-missing")?.kind).toBe("tracker");
    expect(bySlug.get("tracker-missing")?.column).toBe("backlog");
    expect(bySlug.get("tracker-missing")?.issues.map((i) => i.kind)).toContain("missing-done-when-predicate");
    expect(bySlug.get("validation-malformed")?.issues.map((i) => i.kind)).toContain("malformed-done-when-predicate");
    expect(bySlug.has("meta-supported")).toBe(false);

    expect(text).toContain("missing DONE-WHEN fix list:");
    expect(text).toContain("tracker-missing kind=tracker column=backlog");
    expect(text).toContain("validation-malformed kind=validation column=doing");
    expect(text).toContain("DONE-WHEN: brain <slug> exists");
  });
});
