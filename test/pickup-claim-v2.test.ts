import { describe, expect, test } from "bun:test";

import { boardCardFieldsFromCard, boardCardSk } from "../src/board-cards.ts";
import { FkanbanError, type CasExpectation, type NodeClient, type QueryFilter, type QueryResponse, type QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { pickupClaimV2Result } from "../src/commands/pickup_claim_v2.ts";
import { claimCard } from "../src/commands/move.ts";
import { cardToFields, emptyStructuredFields, findCard, setMembershipRetryDelaysForTests, type Card } from "../src/record.ts";
import { setBoardCardJanitorRetryDelaysForTests } from "../src/board-card-janitor.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: {
    card: "cardhash",
    board: "boardhash",
    board_cards: "boardcardshash",
  },
};

type StoredRecord = {
  keyHash: string;
  rangeKey: string | null;
  fields: Record<string, unknown>;
};

type QueryLog = {
  schemaHash: string;
  fields: string[];
  filter?: QueryFilter;
};

type MutationLog = {
  schemaHash: string;
  keyHash: string;
  fields: Record<string, unknown>;
  expected?: CasExpectation;
};

function casError(actual: unknown): FkanbanError {
  return new FkanbanError({
    code: "cas_conflict",
    message: "CAS precondition failed.",
    cause: { field: "column", expected: "todo", actual },
  });
}

function fakeNode(opts: {
  conflictSlug?: string;
  failColumnRead?: "todo" | "doing";
  failMultiRead?: boolean;
  holdAtClaimSlug?: string;
  failCardUpdate?: string;
  failFeatureFlowUpdate?: boolean;
  failClaimMarkerUpdates?: number;
  /** Throw service_timeout on this many row deletes, then succeed. */
  failDeletes?: number;
} = {}): NodeClient & {
  /** Throw service_timeout on the next `n` BoardCards row writes (armed after seeding). */
  failNextBoardCardsWrites(n: number): void;
  queries: QueryLog[];
  mutations: MutationLog[];
  deletions: Array<{ schemaHash: string; keyHash: string; rangeKey?: string | null }>;
} {
  const store = new Map<string, Map<string, StoredRecord>>();
  const queries: QueryLog[] = [];
  const mutations: MutationLog[] = [];
  const deletions: Array<{ schemaHash: string; keyHash: string; rangeKey?: string | null }> = [];
  let injectedConflict = false;
  let targetReads = 0;
  let remainingMarkerUpdateFailures = opts.failClaimMarkerUpdates ?? 0;
  let remainingBoardCardsWriteFailures = 0;
  let remainingDeleteFailures = opts.failDeletes ?? 0;
  const maybeFailBoardCardsWrite = (schemaHash: string) => {
    if (schemaHash !== "boardcardshash" || remainingBoardCardsWriteFailures <= 0) return;
    remainingBoardCardsWriteFailures -= 1;
    throw new FkanbanError({ code: "service_timeout", message: "Injected BoardCards write timeout." });
  };
  const storeKey = (keyHash: string, rangeKey?: string | null) => `${keyHash}\0${rangeKey ?? ""}`;
  const tableFor = (schemaHash: string) => {
    let table = store.get(schemaHash);
    if (!table) {
      table = new Map();
      store.set(schemaHash, table);
    }
    return table;
  };
  const rowsFor = (schemaHash: string, filter?: QueryFilter): QueryRow[] => {
    const table = tableFor(schemaHash);
    const prefix = (filter as { HashRangePrefix?: { hash?: string; prefix?: string } } | undefined)?.HashRangePrefix;
    const keys = (filter as { HashRangeKeys?: Array<[string, string]> } | undefined)?.HashRangeKeys;
    let records: StoredRecord[];
    if (keys) {
      const wanted = new Set(keys.map(([hash, range]) => storeKey(hash, range)));
      records = [...table.values()].filter((record) => wanted.has(storeKey(record.keyHash, record.rangeKey)));
    } else if (prefix?.hash && prefix.prefix !== undefined) {
      records = [...table.values()].filter((record) =>
        record.keyHash === prefix.hash &&
        typeof record.rangeKey === "string" &&
        record.rangeKey.startsWith(prefix.prefix!)
      );
    } else if (filter?.HashKey) {
      records = [...table.values()].filter((record) => record.keyHash === filter.HashKey);
    } else {
      records = [...table.values()];
    }
    return records.map((record) => ({
      fields: record.fields,
      key: { hash: record.keyHash, range: record.rangeKey },
    }));
  };
  const checkExpected = (fields: Record<string, unknown>, expected?: CasExpectation) => {
    if (!expected) return;
    const actual = fields[expected.field];
    if (expected.type === "absent") {
      if (actual !== undefined && actual !== "") throw casError(actual);
    } else if (actual !== expected.value) {
      throw casError(actual);
    }
  };
  const notImplemented = (name: string) => async (): Promise<never> => {
    throw new Error(`fakeNode.${name} not implemented`);
  };

  return {
    baseUrl: cfg.nodeUrl,
    userHash: cfg.userHash,
    queries,
    mutations,
    deletions,
    failNextBoardCardsWrites(n: number) {
      remainingBoardCardsWriteFailures = n;
    },
    autoIdentity: notImplemented("autoIdentity"),
    bootstrap: notImplemented("bootstrap"),
    loadSchemas: notImplemented("loadSchemas"),
    listSchemas: notImplemented("listSchemas"),
    async createRecord({ schemaHash, fields, keyHash, rangeKey, expected }) {
      maybeFailBoardCardsWrite(schemaHash);
      const table = tableFor(schemaHash);
      const key = storeKey(keyHash, rangeKey);
      checkExpected(table.get(key)?.fields ?? {}, expected);
      table.set(key, { keyHash, rangeKey: rangeKey ?? null, fields });
    },
    async updateRecord({ schemaHash, fields, keyHash, rangeKey, expected }) {
      maybeFailBoardCardsWrite(schemaHash);
      const table = tableFor(schemaHash);
      const key = storeKey(keyHash, rangeKey);
      if (schemaHash === "featureflowhash" && opts.failFeatureFlowUpdate) {
        throw new FkanbanError({
          code: "service_timeout",
          message: "Injected feature-flow update timeout.",
        });
      }
      if (schemaHash === "cardhash" && keyHash === opts.failCardUpdate) {
        throw new FkanbanError({
          code: "service_timeout",
          message: "Injected Card update timeout.",
        });
      }
      if (
        schemaHash === "cardhash" &&
        fields.block_status === "needs_human" &&
        !("column" in fields) &&
        remainingMarkerUpdateFailures > 0
      ) {
        remainingMarkerUpdateFailures -= 1;
        throw new FkanbanError({
          code: "service_timeout",
          message: "Injected claim marker update timeout.",
        });
      }
      if (!injectedConflict && schemaHash === "cardhash" && keyHash === opts.conflictSlug) {
        const previous = table.get(key);
        if (previous) previous.fields = {
          ...previous.fields,
          column: "doing",
          assignee: fields.assignee,
        };
        injectedConflict = true;
      }
      checkExpected(table.get(key)?.fields ?? {}, expected);
      mutations.push({ schemaHash, keyHash, fields, expected });
      table.set(key, {
        keyHash,
        rangeKey: rangeKey ?? null,
        fields: { ...table.get(key)?.fields, ...fields },
      });
    },
    async deleteRecord({ schemaHash, keyHash, rangeKey }) {
      deletions.push({ schemaHash, keyHash, rangeKey });
      if (remainingDeleteFailures > 0) {
        remainingDeleteFailures -= 1;
        throw new FkanbanError({ code: "service_timeout", message: "Injected delete timeout." });
      }
      tableFor(schemaHash).delete(storeKey(keyHash, rangeKey));
    },
    async queryAll({ schemaHash, fields, filter }): Promise<QueryResponse> {
      queries.push({ schemaHash, fields, filter });
      if (schemaHash === "cardhash" && opts.holdAtClaimSlug && filter?.HashKey === opts.holdAtClaimSlug) {
        targetReads += 1;
        if (targetReads === 2) {
          const record = tableFor(schemaHash).get(storeKey(opts.holdAtClaimSlug));
          if (record) record.fields.body = "VALIDATE-ONLY: awaiting host-track";
        }
      }
      if (opts.failMultiRead && filter && "HashRangeKeys" in filter) {
        throw new FkanbanError({ code: "service_timeout", message: "Injected multi-key read timeout." });
      }
      const prefix = (filter as { HashRangePrefix?: { prefix?: string } } | undefined)?.HashRangePrefix?.prefix;
      if (schemaHash === "boardcardshash" && prefix === `${opts.failColumnRead}#`) {
        throw new FkanbanError({
          code: "service_timeout",
          message: `Injected ${opts.failColumnRead} read timeout.`,
        });
      }
      const results = rowsFor(schemaHash, filter);
      return { ok: true, results, returned_count: results.length, total_count: results.length };
    },
    rawCall: notImplemented("rawCall") as NodeClient["rawCall"],
    nodeTransport: () => ({ transport: "unavailable" as const }),
  };
}

function card(partial: Partial<Card> & { slug: string }): Card {
  const { slug, ...overrides } = partial;
  return {
    slug,
    title: partial.title ?? slug,
    body: partial.body ?? "## GOAL\nfixture\n\n## END STATE\ndone\n",
    board: partial.board ?? "default",
    column: partial.column ?? "todo",
    position: partial.position ?? "1",
    assignee: partial.assignee ?? "",
    tags: partial.tags ?? [],
    deps: partial.deps ?? [],
    ...emptyStructuredFields(),
    repo: partial.repo ?? "EdgeVector/fkanban",
    base: partial.base ?? "main",
    kind: partial.kind ?? "pr",
    surfaces: partial.surfaces ?? ["src/a.ts"],
    created_at: partial.created_at ?? "2026-01-01T00:00:00.000Z",
    updated_at: partial.updated_at ?? "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

async function seedCard(node: NodeClient, value: Card, membership = true): Promise<void> {
  await node.createRecord({
    schemaHash: cfg.schemaHashes.card!,
    keyHash: value.slug,
    fields: cardToFields(value),
  });
  if (!membership) return;
  await node.createRecord({
    schemaHash: cfg.schemaHashes.board_cards!,
    keyHash: value.board,
    rangeKey: boardCardSk(value.column, value.position, value.slug),
    fields: boardCardFieldsFromCard(value),
  });
}

function prefixOf(query: QueryLog): string | undefined {
  return (query.filter as { HashRangePrefix?: { prefix?: string } } | undefined)?.HashRangePrefix?.prefix;
}

describe("pickup claim v2 LastDB adapter", () => {
  test("uses two column reads and point-reads an unresolved dependency", async () => {
    const node = fakeNode();
    await seedCard(node, card({ slug: "candidate", deps: ["done-dep"] }));
    await seedCard(node, card({ slug: "done-dep", column: "done" }), false);

    const result = await pickupClaimV2Result({ cfg, node, dryRun: true });

    expect(result).toMatchObject({ result: "claimed", dry_run: true, card: { slug: "candidate" } });
    const boardReads = node.queries.filter((query) => query.schemaHash === "boardcardshash");
    // Column prefixes only. The HashKey spine that drops other-column leftovers
    // belongs on `healStaleRows: true`, not the claim hot path.
    expect(boardReads.map(prefixOf).filter((prefix) => prefix !== undefined)).toEqual([
      "todo#",
      "doing#",
    ]);
    expect(boardReads.some((query) => query.filter && "HashKey" in query.filter)).toBe(false);
    const dependencyReads = node.queries.filter((query) =>
      query.schemaHash === "cardhash" && query.filter?.HashKey === "done-dep"
    );
    expect(dependencyReads).toHaveLength(1);
  });

  test("the Card CAS write moves and stamps the worker together", async () => {
    const node = fakeNode();
    await seedCard(node, card({ slug: "candidate" }));

    const result = await pickupClaimV2Result({ cfg, node, worker: "worker-a" });

    expect(result).toMatchObject({
      result: "claimed",
      worker: "worker-a",
      card: { slug: "candidate", column: "doing", assignee: "worker-a" },
    });
    const cardWrites = node.mutations.filter((mutation) => mutation.schemaHash === "cardhash");
    expect(cardWrites).toHaveLength(2);
    expect(cardWrites[0]).toMatchObject({
      keyHash: "candidate",
      fields: {
        column: "doing",
        assignee: "worker-a",
        block_status: "needs_human",
        block_reason: expect.stringContaining("claim recovery pending"),
      },
      expected: { type: "value", field: "column", value: "todo" },
    });
    expect(cardWrites[1]).toMatchObject({
      keyHash: "candidate",
      fields: { assignee: "worker-a", block_status: "none", block_reason: "" },
      expected: { type: "value", field: "assignee", value: "worker-a" },
    });
    expect(await findCard(node, cfg, "candidate")).toMatchObject({
      column: "doing",
      assignee: "worker-a",
    });
  });

  test("a missing surface reserves the repository", async () => {
    const node = fakeNode();
    await seedCard(node, card({ slug: "candidate", surfaces: [] }));
    await seedCard(node, card({ slug: "peer", column: "doing", surfaces: ["README.md"] }));

    await expect(pickupClaimV2Result({ cfg, node, dryRun: true })).resolves.toEqual({
      result: "none",
      dry_run: true,
      scanned: 1,
      skipped: [{ slug: "candidate", reason: "surface overlap with doing card peer" }],
    });
  });

  test("a card whose brief declares a human actor is not claimed, and the miss names why", async () => {
    const node = fakeNode();
    await seedCard(
      node,
      card({ slug: "gated", body: "Repo: EdgeVector/fkanban\nRequires-Actor: interactive\n\n## GOAL\nx\n" }),
    );

    const res = await pickupClaimV2Result({ cfg, node, worker: "worker-a" });
    expect(res.result).toBe("none");
    if (res.result !== "none") return;
    expect(res.skipped).toEqual([{ slug: "gated", reason: "body declares Requires-Actor: interactive" }]);
    expect(await findCard(node, cfg, "gated")).toMatchObject({ column: "todo" });
  });

  test("a merged card reopened for validation is never claimed, in a real claim or a dry-run", async () => {
    // 2026-09-24: a Loom land-card walk claimed a reopened CLOSED-ON-MERGE card
    // and IMPLEMENT failed on "agent produced no commit". The todo projection
    // is body-free, so the point read before the claim must catch it.
    const body =
      "Repo: EdgeVector/last-stack\n\n## GOAL\nx\n\n## END STATE\nlive\n" +
      "CLOSED-ON-MERGE 2026-09-24T02:14:05Z — card moved to done because a PR merged\n" +
      "PROOF[reopened-end-state-unmet]: reopened from CLOSED-ON-MERGE: live --list omits it\n";
    const node = fakeNode();
    await seedCard(node, card({ slug: "reopened", position: "1", body, surfaces: ["src/a.ts"] }));
    await seedCard(node, card({ slug: "real-work", position: "2", surfaces: ["src/b.ts"] }));

    const dry = await pickupClaimV2Result({ cfg, node, dryRun: true });
    expect(dry).toMatchObject({ result: "claimed", dry_run: true, card: { slug: "real-work" } });

    const res = await pickupClaimV2Result({ cfg, node, worker: "worker-a" });
    expect(res).toMatchObject({ result: "claimed", card: { slug: "real-work" } });
    expect(await findCard(node, cfg, "reopened")).toMatchObject({ column: "todo", assignee: "" });
  });

  test("a dry-run names the validate-only hold when nothing else is ready", async () => {
    const node = fakeNode();
    await seedCard(node, card({ slug: "reopened", body: "## GOAL\nx\nVALIDATE-ONLY: awaiting host-track\n" }));

    const res = await pickupClaimV2Result({ cfg, node, dryRun: true });
    expect(res.result).toBe("none");
    if (res.result !== "none") return;
    expect(res.skipped[0]?.slug).toBe("reopened");
    expect(res.skipped[0]?.reason).toContain("validate-only");
  });

  test("a claim conflict continues to the next eligible card", async () => {
    const node = fakeNode({ conflictSlug: "first" });
    await seedCard(node, card({ slug: "first", position: "1", surfaces: ["src/a.ts"] }));
    await seedCard(node, card({ slug: "second", position: "2", surfaces: ["src/b.ts"] }));

    const result = await pickupClaimV2Result({ cfg, node, worker: "worker-a" });

    expect(result).toMatchObject({ result: "claimed", card: { slug: "second" } });
    expect(await findCard(node, cfg, "first")).toMatchObject({
      column: "doing",
      assignee: "worker-a",
      block_status: "",
    });
  });

  test("an old todo membership row cannot claim a Card that is already doing", async () => {
    const node = fakeNode();
    const current = card({ slug: "stale", column: "doing", assignee: "other-worker" });
    await seedCard(node, current, false);
    await node.createRecord({
      schemaHash: cfg.schemaHashes.board_cards!,
      keyHash: current.board,
      rangeKey: boardCardSk("todo", current.position, current.slug),
      fields: boardCardFieldsFromCard({ ...current, column: "todo", assignee: "" }),
    });

    await expect(pickupClaimV2Result({ cfg, node, worker: "worker-a" })).resolves.toEqual({
      result: "none",
      dry_run: false,
      scanned: 1,
      skipped: [{ slug: "stale", reason: "claim conflict (current=doing)" }],
    });
    expect(await findCard(node, cfg, "stale")).toMatchObject({
      column: "doing",
      assignee: "other-worker",
    });
  });

  test("the atomic primitive rejects an empty worker", async () => {
    const node = fakeNode();
    await seedCard(node, card({ slug: "candidate" }));
    await expect(claimCard({ cfg, node, slug: "candidate", worker: "" })).rejects.toMatchObject({
      code: "missing_worker",
    });
  });

  test("a keyed todo read failure is an error, not none", async () => {
    const node = fakeNode({ failColumnRead: "todo" });
    await seedCard(node, card({ slug: "candidate" }));

    await expect(pickupClaimV2Result({ cfg, node, dryRun: true })).rejects.toMatchObject({
      code: "service_timeout",
      message: "Injected todo read timeout.",
    });
  });

  test("a keyed doing read failure is an error, not a clear overlap result", async () => {
    const node = fakeNode({ failColumnRead: "doing" });
    await seedCard(node, card({ slug: "candidate" }));

    await expect(pickupClaimV2Result({ cfg, node, dryRun: true })).rejects.toMatchObject({
      code: "service_timeout",
      message: "Injected doing read timeout.",
    });
  });

  test("a failed Card CAS mutation does not stamp an assignee", async () => {
    const node = fakeNode({ failCardUpdate: "candidate" });
    await seedCard(node, card({ slug: "candidate" }));

    await expect(pickupClaimV2Result({ cfg, node, worker: "worker-a" })).rejects.toMatchObject({
      code: "service_timeout",
      message: "Injected Card update timeout.",
    });
    expect(await findCard(node, cfg, "candidate")).toMatchObject({
      column: "todo",
      assignee: "",
    });
  });

  test("a post-claim failure marks the claimed card for recovery", async () => {
    const node = fakeNode({ failFeatureFlowUpdate: true });
    const flowCfg: Config = {
      ...cfg,
      schemaHashes: { ...cfg.schemaHashes, feature_flow_events: "featureflowhash" },
    };
    await seedCard(node, card({
      slug: "candidate",
      north_star: "north-star-delivery",
      milestone: "milestone-delivery",
    }));

    await expect(pickupClaimV2Result({ cfg: flowCfg, node, worker: "worker-a" })).rejects.toMatchObject({
      code: "claim_post_commit_failed",
    });
    expect(await findCard(node, flowCfg, "candidate")).toMatchObject({
      column: "doing",
      assignee: "worker-a",
      block_status: "needs_human",
      block_reason: expect.stringContaining("claim post-commit failure"),
    });
  });

  test("retries the post-claim marker before reporting the recovered failure", async () => {
    const node = fakeNode({ failFeatureFlowUpdate: true, failClaimMarkerUpdates: 2 });
    const flowCfg: Config = {
      ...cfg,
      schemaHashes: { ...cfg.schemaHashes, feature_flow_events: "featureflowhash" },
    };
    await seedCard(node, card({
      slug: "candidate",
      north_star: "north-star-delivery",
      milestone: "milestone-delivery",
    }));

    await expect(pickupClaimV2Result({ cfg: flowCfg, node, worker: "worker-a" })).rejects.toMatchObject({
      code: "claim_post_commit_failed",
    });
    expect(await findCard(node, flowCfg, "candidate")).toMatchObject({
      block_status: "needs_human",
    });
  });

  test("keeps the atomic recovery hold when all post-claim marker writes fail", async () => {
    const node = fakeNode({ failFeatureFlowUpdate: true, failClaimMarkerUpdates: 3 });
    const flowCfg: Config = {
      ...cfg,
      schemaHashes: { ...cfg.schemaHashes, feature_flow_events: "featureflowhash" },
    };
    await seedCard(node, card({
      slug: "candidate",
      north_star: "north-star-delivery",
      milestone: "milestone-delivery",
    }));

    await expect(pickupClaimV2Result({ cfg: flowCfg, node, worker: "worker-a" })).rejects.toMatchObject({
      code: "claim_post_commit_failed",
    });
    expect(await findCard(node, flowCfg, "candidate")).toMatchObject({
      column: "doing",
      assignee: "worker-a",
      block_status: "needs_human",
      block_reason: expect.stringContaining("claim recovery pending"),
    });
  });

  test("concurrent requests produce one winner for one card", async () => {
    const node = fakeNode();
    await seedCard(node, card({ slug: "candidate" }));

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        pickupClaimV2Result({ cfg, node, worker: `worker-${index}` })
      ),
    );

    const claimed = results.filter((result) => result.result === "claimed");
    expect(claimed).toHaveLength(1);
    expect(results.filter((result) => result.result === "none")).toHaveLength(19);
    const stored = await findCard(node, cfg, "candidate");
    expect(stored).toMatchObject({
      column: "doing",
      assignee: claimed[0]?.result === "claimed" ? claimed[0].worker : "unreachable",
    });
  });

  test("concurrent conflicts continue until each available card has one winner", async () => {
    const node = fakeNode();
    await seedCard(node, card({ slug: "first", position: "1", surfaces: ["src/a.ts"] }));
    await seedCard(node, card({ slug: "second", position: "2", surfaces: ["src/b.ts"] }));

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        pickupClaimV2Result({ cfg, node, worker: `worker-${index}` })
      ),
    );

    const winners = results.flatMap((result) => result.result === "claimed" ? [result.card.slug] : []);
    expect(winners.sort()).toEqual(["first", "second"]);
    expect(new Set(winners).size).toBe(2);
  });

  test("a phantom doing row does not block an overlapping todo card, and is retired", async () => {
    const node = fakeNode();
    // `shipped` is done on its Card, but its doing row was never retired.
    await seedCard(node, card({ slug: "shipped", column: "done", surfaces: ["src/a.ts"] }), false);
    await node.createRecord({
      schemaHash: cfg.schemaHashes.board_cards!,
      keyHash: "default",
      rangeKey: boardCardSk("doing", "5", "shipped"),
      fields: boardCardFieldsFromCard(card({ slug: "shipped", column: "doing", position: "5", surfaces: ["src/a.ts"] })),
    });
    await seedCard(node, card({ slug: "next", surfaces: ["src/a.ts"] }));

    const result = await pickupClaimV2Result({ cfg, node, worker: "worker-a" });

    expect(result).toMatchObject({ result: "claimed", card: { slug: "next" } });
    const doingRows = await node.queryAll({
      schemaHash: "boardcardshash",
      fields: ["slug"],
      filter: { HashRangePrefix: { hash: "default", prefix: "doing#" } } as unknown as QueryFilter,
    });
    expect(doingRows.results.map((row) => row.fields.slug)).toEqual(["next"]);
  });

  test("a live doing card still blocks an overlapping todo card", async () => {
    const node = fakeNode();
    await seedCard(node, card({ slug: "busy", column: "doing", position: "5", surfaces: ["src/a.ts"] }));
    await seedCard(node, card({ slug: "next", surfaces: ["src/a.ts"] }));

    const result = await pickupClaimV2Result({ cfg, node, worker: "worker-a" });

    expect(result.result).toBe("none");
  });

  test("a stale todo row for a card already in doing is retired after the conflict", async () => {
    const node = fakeNode();
    await seedCard(node, card({ slug: "gone", column: "doing", position: "9", surfaces: ["src/z.ts"] }), false);
    await node.createRecord({
      schemaHash: cfg.schemaHashes.board_cards!,
      keyHash: "default",
      rangeKey: boardCardSk("todo", "1", "gone"),
      fields: boardCardFieldsFromCard(card({ slug: "gone", column: "todo", position: "1", surfaces: ["src/z.ts"] })),
    });

    const result = await pickupClaimV2Result({ cfg, node, worker: "worker-a" });

    expect(result.result).toBe("none");
    const todoRows = await node.queryAll({
      schemaHash: "boardcardshash",
      fields: ["slug"],
      filter: { HashRangePrefix: { hash: "default", prefix: "todo#" } } as unknown as QueryFilter,
    });
    expect(todoRows.results).toHaveLength(0);
  });

  test("a claim survives a BoardCards write timeout and leaves the card listed in doing", async () => {
    setMembershipRetryDelaysForTests([0, 0]);
    try {
      const node = fakeNode();
      await seedCard(node, card({ slug: "candidate" }));
      // Two: upsertBoardCardOnHash already falls back from update to create once.
      node.failNextBoardCardsWrites(2);

      const result = await pickupClaimV2Result({ cfg, node, worker: "worker-a" });

      expect(result).toMatchObject({ result: "claimed", card: { slug: "candidate" } });
      const doingRows = await node.queryAll({
        schemaHash: "boardcardshash",
        fields: ["slug"],
        filter: { HashRangePrefix: { hash: "default", prefix: "doing#" } } as unknown as QueryFilter,
      });
      expect(doingRows.results.map((row) => row.fields.slug)).toEqual(["candidate"]);
      const todoRows = await node.queryAll({
        schemaHash: "boardcardshash",
        fields: ["slug"],
        filter: { HashRangePrefix: { hash: "default", prefix: "todo#" } } as unknown as QueryFilter,
      });
      expect(todoRows.results).toHaveLength(0);
    } finally {
      setMembershipRetryDelaysForTests([1000, 3000]);
    }
  });

  test("a delete timeout on the source row is re-sent, so the todo row does not survive the claim", async () => {
    setBoardCardJanitorRetryDelaysForTests([0, 0]);
    try {
      const node = fakeNode({ failDeletes: 2 });
      await seedCard(node, card({ slug: "candidate" }));

      const result = await pickupClaimV2Result({ cfg, node, worker: "worker-a" });

      expect(result).toMatchObject({ result: "claimed" });
      const todoRows = await node.queryAll({
        schemaHash: "boardcardshash",
        fields: ["slug"],
        filter: { HashRangePrefix: { hash: "default", prefix: "todo#" } } as unknown as QueryFilter,
      });
      expect(todoRows.results).toHaveLength(0);
    } finally {
      setBoardCardJanitorRetryDelaysForTests([500, 2000]);
    }
  });
});


describe("exact-card pickup", () => {
  test("exact-card: selects only the requested card after an earlier eligible card", async () => {
    const node = fakeNode();
    await seedCard(node, card({ slug: "earlier", position: "1" }));
    await seedCard(node, card({ slug: "authorized", position: "9", surfaces: ["src/b.ts"] }));
    expect(await pickupClaimV2Result({ cfg, node, onlyCard: "  authorized  ", dryRun: true })).toMatchObject({ result: "claimed", card: { slug: "authorized" } });
    expect(node.queries.filter((q) => q.schemaHash === "boardcardshash").map(prefixOf)).toEqual(["doing#"]);
    const result = await pickupClaimV2Result({ cfg, node, onlyCard: "authorized", worker: "repair-worker" });
    expect(result).toMatchObject({ result: "claimed", card: { slug: "authorized", assignee: "repair-worker" } });
    expect(await findCard(node, cfg, "earlier")).toMatchObject({ column: "todo", assignee: "" });
  });

  test("exact-card: an absent target never falls back", async () => {
    const node = fakeNode();
    await seedCard(node, card({ slug: "earlier" }));
    const result = await pickupClaimV2Result({ cfg, node, onlyCard: "absent", worker: "repair-worker" });
    expect(result).toMatchObject({ result: "none", skipped: [{ slug: "absent", reason: "card not found" }] });
    expect(node.mutations).toHaveLength(0);
  });

  test("exact-card: a blank selector rejects before any node read", async () => {
    const node = fakeNode();
    await expect(pickupClaimV2Result({ cfg, node, onlyCard: "  ", dryRun: true })).rejects.toMatchObject({ code: "invalid_only_card" });
    expect(node.queries).toHaveLength(0);
    expect(node.mutations).toHaveLength(0);
  });

  test("exact-card: a target on another board refuses without fallback", async () => {
    const node = fakeNode();
    await seedCard(node, card({ slug: "authorized", board: "other" }));
    await seedCard(node, card({ slug: "earlier" }));
    const result = await pickupClaimV2Result({ cfg, node, onlyCard: "authorized", dryRun: true });
    expect(result).toMatchObject({ result: "none", skipped: [{ slug: "authorized", reason: "not on board default (board=other)" }] });
    expect(node.mutations).toHaveLength(0);
  });

  test("exact-card: a target outside todo refuses without fallback", async () => {
    const node = fakeNode();
    await seedCard(node, card({ slug: "authorized", column: "done" }));
    await seedCard(node, card({ slug: "earlier" }));
    const result = await pickupClaimV2Result({ cfg, node, onlyCard: "authorized", dryRun: true });
    expect(result).toMatchObject({ result: "none", skipped: [{ slug: "authorized", reason: "not in todo (column=done)" }] });
    expect(node.mutations).toHaveLength(0);
  });

  test("exact-card: a stored hold remains a refusal", async () => {
    // Both eligibility and claimHoldReason protect a stored hold. The mutation
    // probe removes both checks; removing eligibility alone remains safe.
    const node = fakeNode();
    await seedCard(node, card({ slug: "authorized", block_status: "deferred" }));
    const result = await pickupClaimV2Result({ cfg, node, onlyCard: "authorized", dryRun: true });
    expect(result).toMatchObject({ result: "none", skipped: [{ slug: "authorized", reason: "deferred hold" }] });
    expect(node.mutations).toHaveLength(0);
  });

  test("exact-card: a body-only validation hold remains a refusal", async () => {
    const node = fakeNode();
    await seedCard(node, card({ slug: "authorized", body: "## GOAL\nrepair\nVALIDATE-ONLY: awaiting host-track\n" }));
    const result = await pickupClaimV2Result({ cfg, node, onlyCard: "authorized", dryRun: true });
    expect(result.result).toBe("none");
    if (result.result !== "none") return;
    expect(result.skipped[0]?.reason).toContain("validate-only");
    expect(node.mutations).toHaveLength(0);
  });

  test("exact-card: an unfinished dependency remains a refusal", async () => {
    const node = fakeNode();
    await seedCard(node, card({ slug: "authorized", deps: ["missing-dep"] }));
    const result = await pickupClaimV2Result({ cfg, node, onlyCard: "authorized", dryRun: true });
    expect(result).toMatchObject({ result: "none", skipped: [{ slug: "authorized", reason: "unfinished deps: missing-dep" }] });
    expect(node.mutations).toHaveLength(0);
  });

  test("exact-card: peer overlap uses the current Card surfaces", async () => {
    const node = fakeNode();
    await seedCard(node, card({ slug: "authorized", surfaces: ["src/a.ts"] }));
    const peer = card({ slug: "peer", column: "doing", surfaces: ["src/a.ts"] });
    await seedCard(node, peer, false);
    await node.createRecord({ schemaHash: cfg.schemaHashes.board_cards!, keyHash: "default", rangeKey: boardCardSk("doing", peer.position, peer.slug), fields: boardCardFieldsFromCard({ ...peer, surfaces: ["src/b.ts"] }) });
    const result = await pickupClaimV2Result({ cfg, node, onlyCard: "authorized", dryRun: true });
    expect(result).toMatchObject({ result: "none", skipped: [{ slug: "authorized", reason: "surface overlap with doing card peer" }] });
    expect(node.mutations).toHaveLength(0);
  });

  test("exact-card: stale peer rows remain untouched during a real claim", async () => {
    // The adapter and overlap predicate both exclude a terminal peer. The
    // column probe removes both checks to reach this negative fixture.
    const node = fakeNode();
    await seedCard(node, card({ slug: "authorized" }));
    const stale = card({ slug: "stale-peer", column: "done" });
    await seedCard(node, stale, false);
    await node.createRecord({ schemaHash: cfg.schemaHashes.board_cards!, keyHash: "default", rangeKey: boardCardSk("doing", stale.position, stale.slug), fields: boardCardFieldsFromCard({ ...stale, column: "doing" }) });
    const result = await pickupClaimV2Result({ cfg, node, onlyCard: "authorized", worker: "repair-worker" });
    expect(result).toMatchObject({ result: "claimed", card: { slug: "authorized" } });
    expect(node.deletions.some((d) => d.rangeKey?.includes("peer"))).toBe(false);
    expect(node.mutations.some((m) => m.keyHash.includes("peer"))).toBe(false);
  });

  test("exact-card: a missing canonical peer retains its known surface hold", async () => {
    const node = fakeNode();
    await seedCard(node, card({ slug: "authorized" }));
    const peer = card({ slug: "missing-peer", column: "doing" });
    await node.createRecord({ schemaHash: cfg.schemaHashes.board_cards!, keyHash: "default", rangeKey: boardCardSk("doing", peer.position, peer.slug), fields: boardCardFieldsFromCard(peer) });
    const result = await pickupClaimV2Result({ cfg, node, onlyCard: "authorized", worker: "repair-worker" });
    expect(result, "missing canonical peer keeps its surface hold").toMatchObject({ result: "none", skipped: [{ slug: "authorized", reason: "surface overlap with doing card missing-peer" }] });
    expect(node.mutations).toHaveLength(0);
    expect(node.deletions).toHaveLength(0);
  });

  for (const field of ["column", "board", "repo"] as const) {
    test(`exact-card: a sparse peer with absent ${field} retains its known surface hold`, async () => {
      const node = fakeNode();
      await seedCard(node, card({ slug: "authorized" }));
      const peer = card({ slug: "sparse-peer", column: "doing" });
      const fields = cardToFields(peer);
      delete fields[field];
      await node.createRecord({ schemaHash: cfg.schemaHashes.card!, keyHash: peer.slug, fields });
      await node.createRecord({ schemaHash: cfg.schemaHashes.board_cards!, keyHash: "default", rangeKey: boardCardSk("doing", peer.position, peer.slug), fields: boardCardFieldsFromCard(peer) });
      const result = await pickupClaimV2Result({ cfg, node, onlyCard: "authorized", worker: "repair-worker" });
      expect(result, `sparse peer without ${field} keeps its surface hold`).toMatchObject({ result: "none", skipped: [{ slug: "authorized", reason: "surface overlap with doing card sparse-peer" }] });
      expect(node.mutations).toHaveLength(0);
      expect(node.deletions).toHaveLength(0);
    });
  }

  test("exact-card: a stale peer from another board does not block", async () => {
    const node = fakeNode();
    await seedCard(node, card({ slug: "authorized" }));
    const peer = card({ slug: "peer", board: "other", column: "doing" });
    await seedCard(node, peer, false);
    await node.createRecord({ schemaHash: cfg.schemaHashes.board_cards!, keyHash: "default", rangeKey: boardCardSk("doing", peer.position, peer.slug), fields: boardCardFieldsFromCard({ ...peer, board: "default" }) });
    expect(await pickupClaimV2Result({ cfg, node, onlyCard: "authorized", dryRun: true })).toMatchObject({ result: "claimed", card: { slug: "authorized" } });
    expect(node.deletions).toHaveLength(0);
  });

  test("exact-card: peer and dependency keys share one native batch", async () => {
    const node = fakeNode();
    await seedCard(node, card({ slug: "authorized", deps: ["done-dep", "peer", "done-dep"], surfaces: ["src/a.ts"] }));
    await seedCard(node, card({ slug: "done-dep", column: "done" }), false);
    await seedCard(node, card({ slug: "peer", column: "doing", surfaces: ["src/b.ts"] }));
    await seedCard(node, card({ slug: "unrelated", column: "done" }), false);
    const result = await pickupClaimV2Result({ cfg, node, onlyCard: "authorized", dryRun: true });
    expect(result).toMatchObject({ result: "none", skipped: [{ reason: "unfinished deps: peer" }] });
    const reads = node.queries.filter((q) => q.schemaHash === "cardhash");
    expect(reads).toHaveLength(2);
    expect(reads[0]?.filter).toEqual({ HashKey: "authorized" });
    expect(reads[1]?.filter as unknown).toEqual({ HashRangeKeys: [["peer", ""], ["done-dep", ""]] });
    expect(reads[1]?.fields).toEqual(["slug", "board", "column", "repo", "surfaces"]);
    expect(node.mutations).toHaveLength(0);
  });

  test("exact-card: a peer batch error fails closed", async () => {
    const node = fakeNode({ failMultiRead: true });
    await seedCard(node, card({ slug: "authorized" }));
    await seedCard(node, card({ slug: "peer", column: "doing", surfaces: ["src/b.ts"] }));
    await expect(pickupClaimV2Result({ cfg, node, onlyCard: "authorized", worker: "repair-worker" })).rejects.toMatchObject({ code: "service_timeout" });
    expect(node.mutations).toHaveLength(0);
  });

  test("exact-card: a CAS conflict never claims the next card", async () => {
    const node = fakeNode({ conflictSlug: "authorized" });
    await seedCard(node, card({ slug: "authorized", surfaces: ["src/a.ts"] }));
    await seedCard(node, card({ slug: "earlier", position: "0", surfaces: ["src/b.ts"] }));
    const result = await pickupClaimV2Result({ cfg, node, onlyCard: "authorized", worker: "repair-worker" });
    expect(result).toMatchObject({ result: "none", skipped: [{ slug: "authorized", reason: "claim conflict (current=doing)" }] });
    expect(await findCard(node, cfg, "earlier")).toMatchObject({ column: "todo", assignee: "" });
    expect(node.deletions).toHaveLength(0);
  });

  test("exact-card: a hold added at claim time never selects another card", async () => {
    const node = fakeNode({ holdAtClaimSlug: "authorized" });
    await seedCard(node, card({ slug: "authorized", surfaces: ["src/a.ts"] }));
    await seedCard(node, card({ slug: "earlier", position: "0", surfaces: ["src/b.ts"] }));
    const result = await pickupClaimV2Result({ cfg, node, onlyCard: "authorized", worker: "repair-worker" });
    expect(result.result).toBe("none");
    if (result.result !== "none") return;
    expect(result.skipped[0]?.reason).toContain("validate-only");
    expect(node.mutations).toHaveLength(0);
  });

  test("exact-card: concurrent workers retain one CAS winner", async () => {
    const node = fakeNode();
    await seedCard(node, card({ slug: "authorized" }));
    const results = await Promise.all(Array.from({ length: 20 }, (_, n) => pickupClaimV2Result({ cfg, node, onlyCard: "authorized", worker: `worker-${n}` })));
    expect(results.filter((r) => r.result === "claimed")).toHaveLength(1);
    expect(node.mutations.filter((m) => m.schemaHash === "cardhash" && m.fields.column === "doing")).toHaveLength(1);
  });
});
