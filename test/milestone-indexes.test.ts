import { describe, expect, test } from "bun:test";
import type { NodeClient, QueryFilter, QueryResponse, QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { milestoneAddCmd, milestoneDetailResult, milestoneGapReportResult, milestoneListResult, milestonePortfolioResult, milestoneReconcileResult } from "../src/commands/milestone.ts";
import { addCmd } from "../src/commands/add.ts";
import {
  boardToFields,
  findCard,
  listMilestones,
  type Milestone,
  nowIso,
} from "../src/record.ts";
import { listMilestoneCardsPartition, milestoneCardFieldsFromCard } from "../src/milestone-cards.ts";
import { boardMilestoneFieldsFromMilestone, boardMilestoneSk, listBoardMilestonesPartition } from "../src/board-milestones.ts";
import {
  boardCardsSchema,
  DEFAULT_COLUMNS,
  milestoneCardsSchema,
  MILESTONE_CARDS_LAYOUT,
} from "../src/schemas.ts";

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
  const foldMilestoneToBoardMilestone = (fields: Record<string, unknown> | undefined) => {
    const boardMilestonesHash = cfg.schemaHashes.board_milestones;
    if (!boardMilestonesHash || !fields) return;
    const milestone = fields as Milestone;
    const board = milestone.board || "default";
    const sk = boardMilestoneSk(milestone.state, milestone.position, milestone.slug);
    table(boardMilestonesHash).set(rowKey(board, sk), {
      ...boardMilestoneFieldsFromMilestone(milestone),
      completed_at: milestone.completed_at,
    });
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
      if (schemaHash === cfg.schemaHashes.milestone) {
        foldMilestoneToBoardMilestone(fields);
      }
    },
    async updateRecord({ schemaHash, keyHash, fields, rangeKey }) {
      const previous = table(schemaHash).get(rowKey(keyHash, rangeKey));
      const merged = { ...table(schemaHash).get(rowKey(keyHash, rangeKey)), ...fields };
      table(schemaHash).set(rowKey(keyHash, rangeKey), merged);
      if (schemaHash === cfg.schemaHashes.milestone_cards && !foldingMembership) {
        directMilestoneCardMutations.push("update");
      }
      if (schemaHash === cfg.schemaHashes.board_cards) {
        await foldBoardCardToMilestoneCard("delete", previous);
        await foldBoardCardToMilestoneCard("upsert", fields);
      }
      if (schemaHash === cfg.schemaHashes.milestone) {
        foldMilestoneToBoardMilestone(merged);
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
  test("folds BoardMilestones on milestone add; list uses partition not scan", async () => {
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

    const boardRows = await node.queryAll({
      schemaHash: cfg.schemaHashes.board_cards!,
      fields: [...boardCardsSchema.schema.fields],
      filter: { HashKey: "default" },
    });
    const milestoneRows = await node.queryAll({
      schemaHash: cfg.schemaHashes.milestone_cards!,
      fields: [...milestoneCardsSchema.schema.fields],
      filter: { HashKey: "ms-b" },
    });
    expect(boardRows.results).toHaveLength(1);
    expect(milestoneRows.results).toHaveLength(1);

    const boardFields = boardRows.results[0]!.fields;
    const milestoneFields = milestoneRows.results[0]!.fields;
    const sharedFields = boardCardsSchema.schema.fields.filter(
      (field) => field !== "layout" && milestoneCardsSchema.schema.fields.includes(field),
    );
    for (const field of sharedFields) {
      expect(milestoneFields[field], `${field} should fold from BoardCards`).toEqual(boardFields[field]);
    }
    expect(milestoneFields.layout).toBe(MILESTONE_CARDS_LAYOUT);
    expect(milestoneFields.layout).not.toBe(boardFields.layout);

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

    node.directMilestoneCardMutations.length = 0;
    const detail = await milestoneDetailResult({ cfg, node, slug: "ms-orphan" });

    // The ANSWER drops the orphan: its Card primary is gone, so it is not a
    // child however the index rows read.
    expect(detail.detail.children.map((card) => card.slug)).not.toContain("orphan-pr");
    expect(detail.detail.columns.done ?? []).toEqual([]);

    // But `detail` does not REPAIR it. This assertion used to require the
    // opposite — that detail had deleted the stale index row — which made a
    // LOOK command issue writes to the shared primary, seconds per row. The
    // orphan row survives, and detail reports it instead of silently fixing it.
    expect(node.directMilestoneCardMutations).toEqual([]);
    expect((await listMilestoneCardsPartition(node, cfg, "ms-orphan"))?.map((card) => card.slug)).toEqual(["orphan-pr"]);
    expect(detail.repairs).toMatchObject({ applied: false, removals: 1, issued: 0, deferred: 1 });
    expect(detail.text).toContain("kanban milestone reconcile ms-orphan");
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

  // `milestone reconcile` unions the MilestoneCards partition with board
  // membership so a lagging index cannot hide a live child. That union is a
  // DISCOVERY mechanism, and for a while it was also being read as evidence of
  // drift: staleness was `rows.length !== 1` over the merged list, so every
  // correctly-indexed card (present in both) looked stale and was rewritten,
  // while every card missing from the index (present in one) looked clean and
  // was skipped. Measured on the live primary via
  // scripts/probe-milestone-reconcile-shape.ts: 47 needless writes, 0 real
  // drift, 22 missing rows never repaired.
  async function seedMilestoneWithCards(node: FakeNode, milestone: string, slugs: string[]): Promise<void> {
    await seedBoard(node);
    await milestoneAddCmd({
      cfg,
      node,
      slug: milestone,
      title: `Outcome ${milestone}`,
      state: "active",
      northStar: `ns-${milestone}`,
      driver: "driver",
    });
    for (const slug of slugs) {
      await addCmd({
        cfg,
        node,
        slug,
        title: `PR ${slug}`,
        milestone,
        northStar: `ns-${milestone}`,
        repo: "EdgeVector/fkanban",
        base: "main",
        kind: "pr",
        column: "todo",
        body: `Repo: EdgeVector/fkanban\nBase: main\n\n## GOAL\nWork ${slug}.\n\n## END STATE\nDone.\n`,
      });
    }
  }

  async function dropIndexRow(node: FakeNode, milestone: string, slug: string): Promise<void> {
    const card = await findCard(node, cfg, slug);
    const fields = milestoneCardFieldsFromCard(card!);
    await node.deleteRecord({
      schemaHash: cfg.schemaHashes.milestone_cards!,
      keyHash: milestone,
      rangeKey: String(fields!.sk),
    });
  }

  test("reconcile on a converged milestone writes nothing", async () => {
    const node = fakeNode();
    await seedMilestoneWithCards(node, "ms-converged", ["conv-a", "conv-b", "conv-c"]);
    expect((await listMilestoneCardsPartition(node, cfg, "ms-converged"))?.map((c) => c.slug).sort())
      .toEqual(["conv-a", "conv-b", "conv-c"]);

    node.directMilestoneCardMutations.length = 0;
    const rec = await milestoneReconcileResult({ cfg, node, slug: "ms-converged" });

    expect(rec.children.map((c) => c.slug).sort()).toEqual(["conv-a", "conv-b", "conv-c"]);
    // The load-bearing assertion: every child is indexed and matches truth, so
    // there is nothing to repair. Before the fix this was three updates.
    expect(node.directMilestoneCardMutations).toEqual([]);
  });

  test("reconcile writes back a child that is missing from the index", async () => {
    const node = fakeNode();
    await seedMilestoneWithCards(node, "ms-missing", ["miss-a", "miss-b"]);
    await dropIndexRow(node, "ms-missing", "miss-a");
    expect((await listMilestoneCardsPartition(node, cfg, "ms-missing"))?.map((c) => c.slug)).toEqual(["miss-b"]);

    node.directMilestoneCardMutations.length = 0;
    const rec = await milestoneReconcileResult({ cfg, node, slug: "ms-missing" });

    expect(rec.children.map((c) => c.slug).sort()).toEqual(["miss-a", "miss-b"]);
    // Repaired, not merely reported. Before the fix the board-only row read as
    // a single clean row and reconcile left the index short.
    expect((await listMilestoneCardsPartition(node, cfg, "ms-missing"))?.map((c) => c.slug).sort())
      .toEqual(["miss-a", "miss-b"]);
    expect(node.directMilestoneCardMutations).toContain("update");
  });

  test("reconcile repairs only the missing child, not its converged sibling", async () => {
    const node = fakeNode();
    await seedMilestoneWithCards(node, "ms-mixed", ["mix-indexed", "mix-missing"]);
    await dropIndexRow(node, "ms-mixed", "mix-missing");

    node.directMilestoneCardMutations.length = 0;
    await milestoneReconcileResult({ cfg, node, slug: "ms-mixed" });

    // Exactly one row was written, and it was the missing one. The converged
    // sibling is present in BOTH the index and board membership; that
    // duplication is the union working, not drift, and it must not cost a
    // write. Asserting the write COUNT alone is not enough — the pre-fix code
    // also issued exactly one upsert here, just for the wrong card.
    expect(node.directMilestoneCardMutations.filter((m) => m !== "delete")).toEqual(["update"]);
    expect((await listMilestoneCardsPartition(node, cfg, "ms-mixed"))?.map((c) => c.slug).sort())
      .toEqual(["mix-indexed", "mix-missing"]);
  });

  test("reconcile still rewrites an index row that disagrees with Card truth", async () => {
    const node = fakeNode();
    await seedMilestoneWithCards(node, "ms-stale", ["stale-pr"]);
    const card = await findCard(node, cfg, "stale-pr");
    const fields = milestoneCardFieldsFromCard(card!);
    await node.updateRecord({
      schemaHash: cfg.schemaHashes.milestone_cards!,
      keyHash: "ms-stale",
      rangeKey: String(fields!.sk),
      fields: { ...fields, title: "Stale title from an older write" },
    });

    node.directMilestoneCardMutations.length = 0;
    await milestoneReconcileResult({ cfg, node, slug: "ms-stale" });

    const rows = await listMilestoneCardsPartition(node, cfg, "ms-stale");
    expect(rows?.map((c) => c.title)).toEqual(["PR stale-pr"]);
    expect(node.directMilestoneCardMutations).toContain("update");
  });

  test("reconcile retires an index row whose card no longer exists", async () => {
    const node = fakeNode();
    await seedMilestoneWithCards(node, "ms-orphan", ["orphan-pr", "live-pr"]);
    // Remove the Card primary and the board row, then put the index row back:
    // deleting the board row folds the index row away too, and the state under
    // test is an index row that OUTLIVED its card.
    const orphan = await findCard(node, cfg, "orphan-pr");
    const orphanFields = milestoneCardFieldsFromCard(orphan!);
    await node.deleteRecord({ schemaHash: cfg.schemaHashes.card!, keyHash: "orphan-pr" });
    await node.deleteRecord({
      schemaHash: cfg.schemaHashes.board_cards!,
      keyHash: "default",
      rangeKey: String(orphanFields!.sk),
    });
    await node.createRecord({
      schemaHash: cfg.schemaHashes.milestone_cards!,
      keyHash: "ms-orphan",
      rangeKey: String(orphanFields!.sk),
      fields: orphanFields!,
    });
    expect((await listMilestoneCardsPartition(node, cfg, "ms-orphan"))?.map((c) => c.slug).sort())
      .toEqual(["live-pr", "orphan-pr"]);

    node.directMilestoneCardMutations.length = 0;
    const rec = await milestoneReconcileResult({ cfg, node, slug: "ms-orphan" });

    expect(rec.children.map((c) => c.slug)).toEqual(["live-pr"]);
    expect((await listMilestoneCardsPartition(node, cfg, "ms-orphan"))?.map((c) => c.slug)).toEqual(["live-pr"]);
    expect(node.directMilestoneCardMutations).toContain("delete");
  });

  // A slug holding two MilestoneCards rows is the drift `reconcile` is meant to
  // collapse, and `rows.length !== 1` does classify it as stale. But the sweep
  // that actually removes the extra row lives inside `upsertMilestoneCard` and
  // used to be gated on `previous.sk !== next.sk` — with `previous` set to
  // `rows[0]`, one arbitrarily-ordered member of the group. When `rows[0]` is
  // the row that is already CORRECT, that gate reads "nothing moved", the sweep
  // is skipped, and reconcile rewrites the good row forever while the orphan
  // survives every run. Column sks sort `backlog < doing < done < todo`, so on
  // an sk-ordered partition read this is every backward move.
  async function addOrphanIndexRow(
    node: FakeNode,
    milestone: string,
    slug: string,
    column: string,
  ): Promise<string> {
    const card = await findCard(node, cfg, slug);
    const fields = { ...milestoneCardFieldsFromCard(card!)! };
    const sk = `${column}#${String(card!.position).padStart(8, "0")}#${slug}`;
    await node.createRecord({
      schemaHash: cfg.schemaHashes.milestone_cards!,
      keyHash: milestone,
      rangeKey: sk,
      fields: { ...fields, sk, column },
    });
    return sk;
  }

  test("reconcile clears a duplicate index row even when the CORRECT row comes back first", async () => {
    const node = fakeNode();
    await seedMilestoneWithCards(node, "ms-dup-first", ["dup-a"]);
    // Insert order = read order in the fake, so the true `todo#…` row is
    // rows[0] and the `done#…` orphan is rows[1] — the un-sweepable case.
    const orphanSk = await addOrphanIndexRow(node, "ms-dup-first", "dup-a", "done");
    const before = await listMilestoneCardsPartition(node, cfg, "ms-dup-first");
    expect(before?.length).toBe(2);
    expect(before?.[0]?.column).toBe("todo");

    const rec = await milestoneReconcileResult({ cfg, node, slug: "ms-dup-first" });

    expect(rec.children.map((c) => c.slug)).toEqual(["dup-a"]);
    const after = await listMilestoneCardsPartition(node, cfg, "ms-dup-first");
    expect(after?.length).toBe(1);
    expect(after?.[0]?.column).toBe("todo");
    expect(after?.map((c) => `${c.column}#${String(c.position).padStart(8, "0")}#${c.slug}`))
      .not.toContain(orphanSk);
  });

  test("a duplicate that reconcile cannot sweep is re-reported on every run", async () => {
    const node = fakeNode();
    await seedMilestoneWithCards(node, "ms-dup-conv", ["dup-b"]);
    await addOrphanIndexRow(node, "ms-dup-conv", "dup-b", "done");

    await milestoneReconcileResult({ cfg, node, slug: "ms-dup-conv" });
    node.directMilestoneCardMutations.length = 0;
    // Convergence is the property, not the single repair: a second run has
    // nothing left to do. Before the fix the orphan was still there, so this
    // run classified `dup-b` stale again and spent another write on it.
    const second = await milestoneReconcileResult({ cfg, node, slug: "ms-dup-conv" });
    expect(second.repairs).toMatchObject({ upserts: 0, removals: 0, issued: 0 });
    expect(node.directMilestoneCardMutations).toEqual([]);
  });

  test("the orphan is swept regardless of which row the partition returns first", async () => {
    // The mirror case — orphan first — already converged through the sk gate.
    // It must keep converging: the fix widens when the sweep runs, it must not
    // narrow it.
    const node = fakeNode();
    await seedMilestoneWithCards(node, "ms-dup-last", ["dup-c"]);
    const card = await findCard(node, cfg, "dup-c");
    const trueFields = { ...milestoneCardFieldsFromCard(card!)! };
    await node.deleteRecord({
      schemaHash: cfg.schemaHashes.milestone_cards!,
      keyHash: "ms-dup-last",
      rangeKey: String(trueFields.sk),
    });
    await addOrphanIndexRow(node, "ms-dup-last", "dup-c", "backlog");
    await node.createRecord({
      schemaHash: cfg.schemaHashes.milestone_cards!,
      keyHash: "ms-dup-last",
      rangeKey: String(trueFields.sk),
      fields: trueFields,
    });
    expect((await listMilestoneCardsPartition(node, cfg, "ms-dup-last"))?.[0]?.column).toBe("backlog");

    await milestoneReconcileResult({ cfg, node, slug: "ms-dup-last" });

    const after = await listMilestoneCardsPartition(node, cfg, "ms-dup-last");
    expect(after?.length).toBe(1);
    expect(after?.[0]?.column).toBe("todo");
  });

  test("a single stale row still repairs without a partition sweep", async () => {
    // The sweep costs a whole-partition read. Widening it to "whenever the
    // caller saw siblings" must not widen it to "always": one stale row with a
    // known previous sk is still repairable by targeted delete + write.
    const node = fakeNode();
    await seedMilestoneWithCards(node, "ms-one-stale", ["one-stale"]);
    const card = await findCard(node, cfg, "one-stale");
    const fields = milestoneCardFieldsFromCard(card!)!;
    await node.updateRecord({
      schemaHash: cfg.schemaHashes.milestone_cards!,
      keyHash: "ms-one-stale",
      rangeKey: String(fields.sk),
      fields: { ...fields, title: "Stale title" },
    });

    let partitionReads = 0;
    const counting: FakeNode = {
      ...node,
      queryAll: async (req) => {
        if (req.schemaHash === cfg.schemaHashes.milestone_cards) partitionReads += 1;
        return node.queryAll(req);
      },
    };
    await milestoneReconcileResult({ cfg, node: counting, slug: "ms-one-stale" });
    partitionReads = 0;
    await milestoneReconcileResult({ cfg, node: counting, slug: "ms-one-stale" });

    // Exactly the one read `milestoneReconcileResult` makes itself. A sweep
    // inside the upsert would show up as a second.
    expect(partitionReads).toBe(1);
    expect((await listMilestoneCardsPartition(node, cfg, "ms-one-stale"))?.map((c) => c.title))
      .toEqual(["PR one-stale"]);
  });

  test("reconcile --dry-run classifies the repair without issuing it", async () => {
    const node = fakeNode();
    await seedMilestoneWithCards(node, "ms-dry", ["dry-a", "dry-b"]);
    await dropIndexRow(node, "ms-dry", "dry-a");

    node.directMilestoneCardMutations.length = 0;
    const rec = await milestoneReconcileResult({ cfg, node, slug: "ms-dry", apply: false });

    expect(node.directMilestoneCardMutations).toEqual([]);
    expect(rec.repairs).toMatchObject({ applied: false, upserts: 1, removals: 0, issued: 0, deferred: 1 });
    // Left exactly as found — the drift is reported, not repaired.
    expect((await listMilestoneCardsPartition(node, cfg, "ms-dry"))?.map((c) => c.slug)).toEqual(["dry-b"]);
    expect(rec.text).toContain("index drift");
  });

  // The justification for making `detail` read-only. If skipping the repair
  // could change the answer, dry-run-by-default would be trading correctness
  // for latency; it cannot, because children are built from freshly-read Card
  // truth and never from the index rows the repair writes.
  test("skipping the repair does not change the answer", async () => {
    const drifted = async (slug: string) => {
      const node = fakeNode();
      await seedMilestoneWithCards(node, slug, ["same-a", "same-b"]);
      await dropIndexRow(node, slug, "same-a");
      return node;
    };

    const looked = await milestoneReconcileResult({ cfg, node: await drifted("ms-same"), slug: "ms-same", apply: false });
    const repaired = await milestoneReconcileResult({ cfg, node: await drifted("ms-same"), slug: "ms-same" });

    expect(looked.children).toEqual(repaired.children);
    expect(looked.ready).toEqual(repaired.ready);
    expect(looked.repairs.issued).toBe(0);
    expect(repaired.repairs.issued).toBe(1);
  });

  test("--max-repairs bounds one run, and the next run continues from there", async () => {
    const node = fakeNode();
    await seedMilestoneWithCards(node, "ms-budget", ["bud-a", "bud-b", "bud-c"]);
    for (const slug of ["bud-a", "bud-b", "bud-c"]) await dropIndexRow(node, "ms-budget", slug);
    expect(await listMilestoneCardsPartition(node, cfg, "ms-budget")).toEqual([]);

    const first = await milestoneReconcileResult({ cfg, node, slug: "ms-budget", maxRepairs: 2 });
    expect(first.repairs).toMatchObject({ applied: true, upserts: 3, issued: 2, deferred: 1, budget: 2 });
    expect((await listMilestoneCardsPartition(node, cfg, "ms-budget"))?.length).toBe(2);
    expect(first.text).toContain("1 deferred");
    // The ANSWER is complete even though the repair was not: a capped run
    // reports every child, it just leaves some index rows unwritten.
    expect(first.children.map((c) => c.slug).sort()).toEqual(["bud-a", "bud-b", "bud-c"]);

    // Convergent and idempotent, so a capped run makes strict progress —
    // running again finishes the job rather than redoing it.
    const second = await milestoneReconcileResult({ cfg, node, slug: "ms-budget", maxRepairs: 2 });
    expect(second.repairs).toMatchObject({ upserts: 1, issued: 1, deferred: 0 });
    expect((await listMilestoneCardsPartition(node, cfg, "ms-budget"))?.map((c) => c.slug).sort())
      .toEqual(["bud-a", "bud-b", "bud-c"]);

    // And once converged there is nothing left to classify.
    const third = await milestoneReconcileResult({ cfg, node, slug: "ms-budget", maxRepairs: 2 });
    expect(third.repairs).toMatchObject({ upserts: 0, removals: 0, issued: 0, deferred: 0 });
    expect(third.text).not.toContain("index");
  });

  test("--max-repairs unlimited lifts the cap", async () => {
    const node = fakeNode();
    await seedMilestoneWithCards(node, "ms-unbounded", ["unb-a", "unb-b", "unb-c"]);
    for (const slug of ["unb-a", "unb-b", "unb-c"]) await dropIndexRow(node, "ms-unbounded", slug);

    const rec = await milestoneReconcileResult({ cfg, node, slug: "ms-unbounded", maxRepairs: null });

    expect(rec.repairs).toMatchObject({ upserts: 3, issued: 3, deferred: 0, budget: null });
    expect((await listMilestoneCardsPartition(node, cfg, "ms-unbounded"))?.length).toBe(3);
  });

  test("detail reports a missing index row without repairing it", async () => {
    const node = fakeNode();
    await seedMilestoneWithCards(node, "ms-look", ["look-a", "look-b"]);
    await dropIndexRow(node, "ms-look", "look-a");

    node.directMilestoneCardMutations.length = 0;
    const detail = await milestoneDetailResult({ cfg, node, slug: "ms-look" });

    // Reported from Card truth ...
    expect(detail.detail.children.map((c) => c.slug).sort()).toEqual(["look-a", "look-b"]);
    // ... and the index left exactly as found.
    expect(node.directMilestoneCardMutations).toEqual([]);
    expect((await listMilestoneCardsPartition(node, cfg, "ms-look"))?.map((c) => c.slug)).toEqual(["look-b"]);
    expect(detail.repairs).toMatchObject({ applied: false, upserts: 1, issued: 0, deferred: 1 });
    expect(detail.text).toContain("kanban milestone reconcile ms-look");
  });

  test("gap-report sees north_star via folded BoardMilestones", async () => {
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
