import { describe, expect, test } from "bun:test";
import type { NodeClient, QueryFilter, QueryResponse, QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { milestoneAddCmd, milestoneDetailResult, milestoneGapReportResult, milestoneListResult, milestonePortfolioResult, milestoneReconcileResult } from "../src/commands/milestone.ts";
import { addCmd } from "../src/commands/add.ts";
import {
  boardToFields,
  findCard,
  listMilestones,
  nowIso,
} from "../src/record.ts";
import { listMilestoneCardsPartition, milestoneCardFieldsFromCard } from "../src/milestone-cards.ts";
import { listBoardMilestonesPartition } from "../src/board-milestones.ts";
import { DEFAULT_COLUMNS, MILESTONE_CARDS_LAYOUT } from "../src/schemas.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: {
    card: "cardhash",
    board: "boardhash",
    milestone: "milestonehash",
    board_cards: "boardcards-hash",
    board_milestones: "boardms-hash",
    milestone_cards: "mscards-hash",
  },
};

type FakeNode = NodeClient & { directMilestoneCardMutations: string[] };

function fakeNode(): FakeNode {
  const store = new Map<string, Map<string, Record<string, unknown>>>();
  const directMilestoneCardMutations: string[] = [];
  let foldingMembership = false;
  // HashRange: key = `${hash}\0${range}`
  const table = (hash: string) => {
    let value = store.get(hash);
    if (!value) {
      value = new Map();
      store.set(hash, value);
    }
    return value;
  };
  const rowKey = (keyHash: string, rangeKey?: string | null) =>
    rangeKey != null && rangeKey !== "" ? `${keyHash}\0${rangeKey}` : keyHash;

  const rows = (schemaHash: string, filter?: QueryFilter): QueryRow[] => {
    const source = table(schemaHash);
    const entries = [...source.entries()];
    if (filter?.HashKey) {
      const hk = filter.HashKey;
      return entries
        .filter(([k]) => k === hk || k.startsWith(`${hk}\0`))
        .map(([k, fields]) => {
          const range = k.includes("\0") ? k.slice(k.indexOf("\0") + 1) : null;
          return { fields, key: { hash: hk, range } };
        });
    }
    // unfiltered
    return entries.map(([k, fields]) => {
      const i = k.indexOf("\0");
      return {
        fields,
        key: i >= 0 ? { hash: k.slice(0, i), range: k.slice(i + 1) } : { hash: k, range: null },
      };
    });
  };

  const notImplemented = async (): Promise<never> => {
    throw new Error("not implemented");
  };
  const foldBoardCardToMilestoneCard = async (
    action: "upsert" | "delete",
    fields: Record<string, unknown> | undefined,
  ) => {
    const milestoneHash = cfg.schemaHashes.milestone_cards;
    if (!milestoneHash || !fields) return;
    const milestone = typeof fields.milestone === "string" ? fields.milestone.trim() : "";
    const sk = typeof fields.sk === "string" ? fields.sk : "";
    if (!milestone || !sk) return;
    foldingMembership = true;
    try {
      if (action === "delete") {
        await node.deleteRecord({ schemaHash: milestoneHash, keyHash: milestone, rangeKey: sk });
      } else {
        await node.updateRecord({
          schemaHash: milestoneHash,
          keyHash: milestone,
          rangeKey: sk,
          fields: { ...fields, layout: MILESTONE_CARDS_LAYOUT },
        });
      }
    } finally {
      foldingMembership = false;
    }
  };

  const node: FakeNode = {
    baseUrl: cfg.nodeUrl,
    userHash: cfg.userHash,
    autoIdentity: notImplemented,
    bootstrap: notImplemented,
    loadSchemas: notImplemented,
    listSchemas: notImplemented,
    async createRecord({ schemaHash, keyHash, fields, rangeKey }) {
      table(schemaHash).set(rowKey(keyHash, rangeKey), { ...fields });
      if (schemaHash === cfg.schemaHashes.milestone_cards && !foldingMembership) {
        directMilestoneCardMutations.push("create");
      }
      if (schemaHash === cfg.schemaHashes.board_cards) {
        await foldBoardCardToMilestoneCard("upsert", fields);
      }
    },
    async updateRecord({ schemaHash, keyHash, fields, rangeKey }) {
      const previous = table(schemaHash).get(rowKey(keyHash, rangeKey));
      table(schemaHash).set(rowKey(keyHash, rangeKey), { ...fields });
      if (schemaHash === cfg.schemaHashes.milestone_cards && !foldingMembership) {
        directMilestoneCardMutations.push("update");
      }
      if (schemaHash === cfg.schemaHashes.board_cards) {
        await foldBoardCardToMilestoneCard("delete", previous);
        await foldBoardCardToMilestoneCard("upsert", fields);
      }
    },
    async deleteRecord({ schemaHash, keyHash, rangeKey }) {
      const previous = table(schemaHash).get(rowKey(keyHash, rangeKey));
      table(schemaHash).delete(rowKey(keyHash, rangeKey));
      if (schemaHash === cfg.schemaHashes.milestone_cards && !foldingMembership) {
        directMilestoneCardMutations.push("delete");
      }
      if (schemaHash === cfg.schemaHashes.board_cards) {
        await foldBoardCardToMilestoneCard("delete", previous);
      }
    },
    async queryAll({ schemaHash, filter }): Promise<QueryResponse> {
      const results = rows(schemaHash, filter);
      return { ok: true, results, returned_count: results.length, total_count: results.length };
    },
    rawCall: notImplemented,
    nodeTransport: () => ({ transport: "unavailable" as const }),
    directMilestoneCardMutations,
  };
  return node;
}

async function seedBoard(node: NodeClient): Promise<void> {
  const now = nowIso();
  await node.createRecord({
    schemaHash: cfg.schemaHashes.board!,
    keyHash: "default",
    fields: boardToFields({
      slug: "default",
      title: "Default",
      body: "",
      columns: [...DEFAULT_COLUMNS],
      created_at: now,
      updated_at: now,
    }),
  });
}

describe("milestone HashRange indexes", () => {
  test("dual-write BoardMilestones on milestone add; list uses partition not scan", async () => {
    const node = fakeNode();
    await seedBoard(node);
    await milestoneAddCmd({
      cfg,
      node,
      slug: "ms-a",
      title: "Outcome A",
      state: "active",
      northStar: "north-star-x",
      driver: "last-stack-milestone-driver",
    });

    const part = await listBoardMilestonesPartition(node, cfg, "default");
    expect(part?.map((m) => m.slug)).toEqual(["ms-a"]);
    expect(part?.[0]?.north_star).toBe("north-star-x");

    const listed = await listMilestones(node, cfg);
    expect(listed.find((m) => m.slug === "ms-a")?.title).toBe("Outcome A");
  });

  test("list, portfolio, detail, and gap-report stay on milestone indexes", async () => {
    const base = fakeNode();
    await seedBoard(base);
    await milestoneAddCmd({
      cfg,
      node: base,
      slug: "ms-indexed",
      title: "Indexed outcome",
      state: "active",
      northStar: "north-star-indexed",
      driver: "last-stack-milestone-driver",
    });
    await milestoneAddCmd({
      cfg,
      node: base,
      slug: "ms-other",
      title: "Other outcome",
      state: "active",
      northStar: "north-star-other",
      driver: "last-stack-milestone-driver",
    });
    await addCmd({
      cfg,
      node: base,
      slug: "indexed-pr",
      title: "Indexed PR",
      milestone: "ms-indexed",
      northStar: "north-star-indexed",
      repo: "EdgeVector/fkanban",
      base: "main",
      kind: "pr",
      column: "todo",
      body: "Repo: EdgeVector/fkanban\nBase: main\n\n## GOAL\nIndexed child.\n\n## END STATE\nDone.\n",
    });
    await addCmd({
      cfg,
      node: base,
      slug: "other-pr",
      title: "Other PR",
      milestone: "ms-other",
      northStar: "north-star-other",
      repo: "EdgeVector/fkanban",
      base: "main",
      kind: "pr",
      column: "todo",
      body: "Repo: EdgeVector/fkanban\nBase: main\n\n## GOAL\nOther child.\n\n## END STATE\nDone.\n",
    });

    const fullScanAttempts: string[] = [];
    const node: NodeClient = {
      ...base,
      async queryAll(opts) {
        if (opts.schemaHash === cfg.schemaHashes.milestone && !opts.filter && opts.allowFullScan) {
          fullScanAttempts.push(opts.schemaHash);
          throw new Error("Milestone full scan is forbidden in indexed milestone read paths");
        }
        return base.queryAll(opts);
      },
    };

    const listed = await milestoneListResult({ cfg, node, board: "default" });
    expect(listed.milestones.map((m) => m.slug)).toEqual(["ms-indexed", "ms-other"]);
    expect(listed.milestones.find((m) => m.slug === "ms-indexed")?.north_star).toBe("north-star-indexed");

    const portfolio = await milestonePortfolioResult({ cfg, node, board: "default" });
    expect(portfolio.entries.find((entry) => entry.slug === "ms-indexed")).toMatchObject({
      title: "Indexed outcome",
      north_star: "north-star-indexed",
      ready: ["indexed-pr"],
    });

    const detail = await milestoneDetailResult({ cfg, node, slug: "ms-indexed" });
    expect(detail.detail.columns.todo?.map((card) => card.slug)).toEqual(["indexed-pr"]);
    expect(detail.detail.children.map((card) => card.slug)).not.toContain("other-pr");

    const { report } = await milestoneGapReportResult({ cfg, node, board: "default" });
    expect(report.milestones.find((m) => m.slug === "ms-indexed")).toMatchObject({
      title: "Indexed outcome",
      north_star: "north-star-indexed",
      status: "in_flight",
    });
    expect(fullScanAttempts).toEqual([]);
  });

  test("folds MilestoneCards from the BoardCards write; reconcile uses partition", async () => {
    const node = fakeNode();
    await seedBoard(node);
    await milestoneAddCmd({
      cfg,
      node,
      slug: "ms-b",
      title: "Outcome B",
      state: "active",
      northStar: "ns-b",
      driver: "driver",
    });
    await addCmd({
      cfg,
      node,
      slug: "pr-b",
      title: "PR B",
      milestone: "ms-b",
      northStar: "ns-b",
      repo: "EdgeVector/fkanban",
      base: "main",
      kind: "pr",
      column: "todo",
      body: "Repo: EdgeVector/fkanban\nBase: main\n\n## GOAL\nWork.\n\n## END STATE\nDone.\n",
    });

    const kids = await listMilestoneCardsPartition(node, cfg, "ms-b");
    expect(kids?.map((c) => c.slug)).toEqual(["pr-b"]);
    expect(kids?.[0]?.body).toBe(""); // thin index
    expect(node.directMilestoneCardMutations).toEqual([]);

    const rec = await milestoneReconcileResult({ cfg, node, slug: "ms-b" });
    expect(rec.children.map((c) => c.slug)).toContain("pr-b");
    expect(rec.ready.map((c) => c.slug)).toContain("pr-b");
  });

  test("milestone detail dedupes stale membership rows against Card truth", async () => {
    const node = fakeNode();
    await seedBoard(node);
    await milestoneAddCmd({
      cfg,
      node,
      slug: "ms-drift",
      title: "Drift outcome",
      state: "active",
      northStar: "ns-drift",
      driver: "driver",
    });
    await addCmd({
      cfg,
      node,
      slug: "drift-pr",
      title: "Current PR title",
      milestone: "ms-drift",
      northStar: "ns-drift",
      repo: "EdgeVector/fkanban",
      base: "main",
      kind: "pr",
      column: "done",
      body: "Repo: EdgeVector/fkanban\nBase: main\n\n## GOAL\nCurrent child.\n\n## END STATE\nDone.\n",
    });

    const current = await findCard(node, cfg, "drift-pr");
    expect(current).not.toBeNull();
    const staleFields = milestoneCardFieldsFromCard({
      ...current!,
      title: "Stale PR title",
      column: "doing",
      position: "1",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    expect(staleFields).not.toBeNull();
    await node.createRecord({
      schemaHash: cfg.schemaHashes.milestone_cards!,
      keyHash: "ms-drift",
      rangeKey: String(staleFields!.sk),
      fields: staleFields!,
    });

    const detail = await milestoneDetailResult({ cfg, node, slug: "ms-drift" });
    expect(detail.detail.children).toEqual([
      { slug: "drift-pr", title: "Current PR title", column: "done", blocked: false, blockedBy: [] },
    ]);
    expect(detail.detail.columns.doing ?? []).toEqual([]);
    expect(detail.detail.columns.done?.map((card) => card.slug)).toEqual(["drift-pr"]);
  });

  test("milestone detail drops membership rows whose Card primary is missing", async () => {
    const node = fakeNode();
    await seedBoard(node);
    await milestoneAddCmd({
      cfg,
      node,
      slug: "ms-orphan",
      title: "Orphan outcome",
      state: "active",
      northStar: "ns-orphan",
      driver: "driver",
    });

    await node.createRecord({
      schemaHash: cfg.schemaHashes.milestone_cards!,
      keyHash: "ms-orphan",
      rangeKey: "done#00000001#orphan-pr",
      fields: {
        milestone: "ms-orphan",
        sk: "done#00000001#orphan-pr",
        slug: "orphan-pr",
        title: "Deleted PR",
        board: "default",
        column: "done",
        position: "1",
        assignee: "",
        tags: [],
        deps: [],
        surfaces: [],
        created_at: "2026-01-01T00:00:00.000Z",
        created_by: "test",
        updated_at: "2026-01-02T00:00:00.000Z",
        db: "",
        repo: "EdgeVector/fkanban",
        base: "main",
        kind: "pr",
        block_status: "",
        block_reason: "",
        north_star: "ns-orphan",
        pr_url: "",
        branch: "",
        layout: MILESTONE_CARDS_LAYOUT,
      },
    });

    const detail = await milestoneDetailResult({ cfg, node, slug: "ms-orphan" });
    expect(detail.detail.children.map((card) => card.slug)).not.toContain("orphan-pr");
    expect(detail.detail.columns.done ?? []).toEqual([]);
    expect(await listMilestoneCardsPartition(node, cfg, "ms-orphan")).toEqual([]);
  });

  test("milestone detail includes current board membership when milestone partition lags", async () => {
    const node = fakeNode();
    await seedBoard(node);
    await milestoneAddCmd({
      cfg,
      node,
      slug: "ms-board-only",
      title: "Board-only outcome",
      state: "active",
      northStar: "ns-board-only",
      driver: "driver",
    });
    await addCmd({
      cfg,
      node,
      slug: "board-only-pr",
      title: "Board-only PR",
      milestone: "ms-board-only",
      northStar: "ns-board-only",
      repo: "EdgeVector/fkanban",
      base: "main",
      kind: "pr",
      column: "todo",
      body: "Repo: EdgeVector/fkanban\nBase: main\n\n## GOAL\nBoard child.\n\n## END STATE\nDone.\n",
    });

    const current = await findCard(node, cfg, "board-only-pr");
    expect(current).not.toBeNull();
    const fields = milestoneCardFieldsFromCard(current!);
    expect(fields).not.toBeNull();
    await node.deleteRecord({
      schemaHash: cfg.schemaHashes.milestone_cards!,
      keyHash: "ms-board-only",
      rangeKey: String(fields!.sk),
    });

    expect(await listMilestoneCardsPartition(node, cfg, "ms-board-only")).toEqual([]);
    const detail = await milestoneDetailResult({ cfg, node, slug: "ms-board-only" });
    expect(detail.detail.children.map((card) => card.slug)).toEqual(["board-only-pr"]);
    expect(detail.detail.ready.map((card) => card.slug)).toEqual(["board-only-pr"]);
  });

  test("gap-report sees north_star via BoardMilestones dual-write", async () => {
    const node = fakeNode();
    await seedBoard(node);
    await milestoneAddCmd({
      cfg,
      node,
      slug: "ms-empty",
      title: "Empty",
      state: "planned",
      northStar: "ns-c",
      driver: "driver",
    });
    const { report } = await milestoneGapReportResult({ cfg, node });
    const entry = report.milestones.find((m) => m.slug === "ms-empty");
    expect(entry?.north_star).toBe("ns-c");
    expect(entry?.status).toBe("idle_empty");
    expect(entry?.action).toBe("decompose");
  });
});
