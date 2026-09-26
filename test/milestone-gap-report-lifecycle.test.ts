/**
 * Gap-report and portfolio must derive from the same HashKey lifecycle that
 * `milestone show` reads, and must never queue an action the state CLI refuses.
 *
 * Live 2026-08-26: BoardMilestones still said `state=active` for
 * lastdb-status-gauge-contract while show said complete, and blanked
 * north_star on uuid-hash-group-addressing-warm-set-as-is-proof.
 */
import { describe, expect, test } from "bun:test";

import type { Config } from "../src/config.ts";
import { fakeNode, type FakeNode } from "./fake-node.ts";
import {
  classifyMilestoneGap,
  isMilestoneGapActionLegal,
  milestoneGapReportResult,
  milestonePortfolioResult,
  milestoneShowResult,
} from "../src/commands/milestone.ts";
import { boardCardSk } from "../src/board-cards.ts";
import { boardMilestoneFieldsFromMilestone, boardMilestoneSk } from "../src/board-milestones.ts";
import { nowIso, type Milestone } from "../src/record.ts";
import { POINT_READ_CONCURRENCY } from "../src/concurrency.ts";
import type { NodeClient } from "../src/client.ts";

const CARD = "cardhash";
const BOARD = "boardhash";
const MILESTONE = "milestonehash";
const BOARD_CARDS = "boardcards-hash";
const BOARD_MILESTONES = "boardms-hash";
const MILESTONE_CARDS = "mscards-hash";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: {
    card: CARD,
    board: BOARD,
    milestone: MILESTONE,
    board_cards: BOARD_CARDS,
    board_milestones: BOARD_MILESTONES,
    milestone_cards: MILESTONE_CARDS,
  },
};

function ms(partial: Partial<Milestone> = {}): Milestone {
  const now = nowIso();
  return {
    slug: "ms",
    title: "M",
    body: "",
    board: "default",
    state: "active",
    position: "10",
    north_star: "ns-x",
    driver: "last-stack-milestone-driver",
    deps: [],
    proof_card: "",
    proof_status: "pending",
    block_reason: "",
    created_at: now,
    updated_at: now,
    completed_at: "",
    ...partial,
  };
}

function seedBoard(node: FakeNode): void {
  node.seed({
    schemaHash: BOARD,
    keyHash: "default",
    fields: {
      slug: "default",
      title: "Default",
      body: "",
      columns: ["backlog", "todo", "doing", "done"],
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
  });
}

function seedMilestone(node: FakeNode, milestone: Milestone, indexOverride: Partial<Milestone> = {}): void {
  node.seed({ schemaHash: MILESTONE, keyHash: milestone.slug, fields: { ...milestone } });
  const index = { ...milestone, ...indexOverride };
  node.seed({
    schemaHash: BOARD_MILESTONES,
    keyHash: index.board,
    rangeKey: boardMilestoneSk(index.state, index.position, index.slug),
    fields: { ...boardMilestoneFieldsFromMilestone(index), completed_at: index.completed_at },
  });
}

function cardFields(partial: Record<string, unknown>): Record<string, unknown> {
  return {
    slug: "c",
    title: "A card",
    body: "Repo: EdgeVector/fkanban\nBase: main\n\n## GOAL\nWork.\n\n## END STATE\nDone.\n",
    board: "default",
    column: "todo",
    position: "10",
    assignee: "",
    tags: [],
    deps: [],
    surfaces: [],
    created_at: "2026-01-01T00:00:00.000Z",
    created_by: "test",
    updated_at: "2026-01-01T00:00:00.000Z",
    done_at: "",
    first_doing_at: "",
    db: "",
    repo: "EdgeVector/fkanban",
    base: "main",
    kind: "pr",
    block_status: "none",
    block_reason: "",
    north_star: "ns-x",
    milestone: "ms",
    pr_url: "",
    branch: "",
    ...partial,
  };
}

function seedBoardCard(node: FakeNode, partial: Record<string, unknown>): void {
  const fields = cardFields(partial);
  node.seed({ schemaHash: CARD, keyHash: String(fields.slug), fields });
  node.seed({
    schemaHash: BOARD_CARDS,
    keyHash: String(fields.board),
    rangeKey: boardCardSk(String(fields.column), String(fields.position), String(fields.slug)),
    fields: {
      ...fields,
      board: String(fields.board),
      sk: boardCardSk(String(fields.column), String(fields.position), String(fields.slug)),
    },
  });
}

describe("gap-report lifecycle legality", () => {
  test("complete_proof is legal from planned (state CLI hops via active) and from active with not_required", () => {
    // papercut-milestone-complete-proof-skipped-state-planned-20260924:
    // `milestone state complete --proof-status not_required` hops planned →
    // active → complete, so the gap-report must not skip a planned milestone.
    expect(isMilestoneGapActionLegal("planned", "complete_proof")).toBe(true);
    expect(isMilestoneGapActionLegal("blocked", "complete_proof")).toBe(false);
    expect(isMilestoneGapActionLegal("active", "complete_proof")).toBe(true);
    expect(isMilestoneGapActionLegal("proving", "complete_proof")).toBe(true);
    expect(isMilestoneGapActionLegal("complete", "decompose")).toBe(false);
    expect(isMilestoneGapActionLegal("planned", "decompose")).toBe(true);
  });

  test("a planned milestone with done PRs is no longer skipped", () => {
    const donePr = {
      slug: "done-pr",
      title: "Done",
      body: "Repo: EdgeVector/fkanban\nBase: main\n\n## GOAL\nWork.\n\n## END STATE\nDone.\n",
      board: "default",
      column: "done",
      position: "1",
      assignee: "",
      tags: [],
      deps: [],
      surfaces: [],
      created_at: nowIso(),
      created_by: "",
      updated_at: nowIso(),
      done_at: nowIso(),
      first_doing_at: "",
      db: "",
      repo: "EdgeVector/fkanban",
      base: "main",
      kind: "pr",
      block_status: "none",
      block_reason: "",
      north_star: "ns-x",
      milestone: "ms-planned",
      pr_url: "",
      branch: "",
    };
    const children = [{ slug: "done-pr", title: "Done", column: "done", blocked: false, blockedBy: [] }];

    // not_required: the same complete_proof an active milestone gets, flagged.
    const nr = classifyMilestoneGap(ms({ slug: "ms-planned", state: "planned", proof_status: "not_required" }), [donePr], children, null);
    expect(nr.state).toBe("planned");
    expect(nr.status).toBe("proof_ready");
    expect(nr.action).toBe("complete_proof");
    expect(nr.activate_first).toBe(true);
    expect(nr.reason).not.toContain("skipped");

    // pending proof, no proof card: the next slice, not a skip and not a close.
    const pending = classifyMilestoneGap(ms({ slug: "ms-planned", state: "planned" }), [donePr], children, null);
    expect(pending.status).toBe("needs_next_slice");
    expect(pending.action).toBe("decompose");
    expect(pending.next_slice).toBe(true);
    expect(pending.activate_first).toBe(true);

    // An active milestone never carries the flag.
    const active = classifyMilestoneGap(ms({ slug: "ms-planned", state: "active", proof_status: "not_required" }), [donePr], children, null);
    expect(active.action).toBe("complete_proof");
    expect(active.activate_first).toBeUndefined();
  });

  test("classifier skips decompose for a complete milestone with no children", () => {
    const entry = classifyMilestoneGap(ms({ state: "complete", north_star: "ns-x" }), [], [], null);
    expect(entry.action).toBe("skip");
    expect(entry.status).toBe("complete");
  });
});

describe("gap-report and portfolio hydrate from HashKey show source", () => {
  test("stale BoardMilestones state/north_star lose to HashKey; illegal queue is empty", async () => {
    const node = fakeNode({ dropIncompleteRows: false });
    seedBoard(node);

    seedMilestone(
      node,
      ms({
        slug: "ms-complete",
        title: "Already done",
        state: "complete",
        north_star: "ns-complete",
        proof_status: "not_required",
        completed_at: "2026-08-01T00:00:00.000Z",
        updated_at: "2026-08-01T00:00:00.000Z",
      }),
      { state: "active", north_star: "", updated_at: "2026-07-01T00:00:00.000Z" },
    );

    seedMilestone(
      node,
      ms({
        slug: "ms-planned",
        title: "Still planned",
        state: "planned",
        north_star: "ns-planned",
        position: "20",
      }),
    );
    seedBoardCard(node, {
      slug: "planned-done-pr",
      milestone: "ms-planned",
      north_star: "ns-planned",
      column: "done",
      position: "20",
    });

    seedMilestone(
      node,
      ms({
        slug: "ms-active",
        title: "Needs cards",
        state: "active",
        north_star: "ns-active",
        position: "30",
      }),
    );

    const shownComplete = await milestoneShowResult({ cfg, node, slug: "ms-complete" });
    const shownPlanned = await milestoneShowResult({ cfg, node, slug: "ms-planned" });
    const shownActive = await milestoneShowResult({ cfg, node, slug: "ms-active" });
    expect(shownComplete.milestone.state).toBe("complete");
    expect(shownComplete.milestone.north_star).toBe("ns-complete");
    expect(shownPlanned.milestone.state).toBe("planned");
    expect(shownActive.milestone.state).toBe("active");

    const { entries } = await milestonePortfolioResult({ cfg, node });
    const portfolioBySlug = Object.fromEntries(entries.map((e) => [e.slug, e]));
    expect(portfolioBySlug["ms-complete"]?.state).toBe(shownComplete.milestone.state);
    expect(portfolioBySlug["ms-complete"]?.north_star).toBe(shownComplete.milestone.north_star);
    expect(portfolioBySlug["ms-planned"]?.state).toBe(shownPlanned.milestone.state);
    expect(portfolioBySlug["ms-planned"]?.north_star).toBe(shownPlanned.milestone.north_star);
    expect(portfolioBySlug["ms-active"]?.state).toBe(shownActive.milestone.state);
    expect(portfolioBySlug["ms-active"]?.north_star).toBe(shownActive.milestone.north_star);

    const { report } = await milestoneGapReportResult({ cfg, node });
    const bySlug = Object.fromEntries(report.milestones.map((m) => [m.slug, m]));
    expect(bySlug["ms-complete"]?.state).toBe("complete");
    expect(bySlug["ms-complete"]?.north_star).toBe("ns-complete");
    expect(bySlug["ms-complete"]?.action).toBe("skip");
    // Planned, one done PR, proof pending, no proof card: the next slice.
    expect(bySlug["ms-planned"]?.action).toBe("decompose");
    expect(bySlug["ms-planned"]?.status).toBe("needs_next_slice");
    expect(bySlug["ms-planned"]?.activate_first).toBe(true);
    expect(bySlug["ms-active"]?.action).toBe("decompose");
    expect(report.counts.needs_next_slice).toBe(1);

    expect(report.work_queue.some((w) => w.slug === "ms-complete")).toBe(false);
    expect(report.work_queue.some((w) => w.action === "complete_proof" && w.slug === "ms-planned")).toBe(false);
    expect(report.work_queue.filter((w) => w.action === "decompose").map((w) => w.slug)).toEqual(["ms-planned", "ms-active"]);
  });
});

describe("HashKey hydrate fan-out is pooled", () => {
  test("listed-milestone HashKey reads peak at POINT_READ_CONCURRENCY", async () => {
    const MILESTONES = POINT_READ_CONCURRENCY * 2;
    const raw = fakeNode({ dropIncompleteRows: false });
    seedBoard(raw);
    for (let i = 0; i < MILESTONES; i++) {
      seedMilestone(
        raw,
        ms({
          slug: `m-${String(i).padStart(2, "0")}`,
          position: String(10 + i),
          north_star: `ns-${i}`,
        }),
      );
    }

    const inFlight = { n: 0, peak: 0 };
    const realQueryAll = raw.queryAll.bind(raw);
    const node = Object.assign(Object.create(Object.getPrototypeOf(raw)), raw, {
      queryAll: async (args: Parameters<NodeClient["queryAll"]>[0]) => {
        const h = (args as { schemaHash: string }).schemaHash;
        if (h === MILESTONE) {
          inFlight.n += 1;
          inFlight.peak = Math.max(inFlight.peak, inFlight.n);
        }
        try {
          await new Promise((resolve) => setTimeout(resolve, 0));
          return await realQueryAll(args);
        } finally {
          if (h === MILESTONE) inFlight.n -= 1;
        }
      },
    }) as NodeClient;

    await milestonePortfolioResult({ cfg, node });
    expect(inFlight.peak).toBeGreaterThan(1);
    expect(inFlight.peak).toBeLessThanOrEqual(POINT_READ_CONCURRENCY);
  });
});
