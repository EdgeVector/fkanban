/**
 * A milestone whose acceptance is already met by done Kind:pr cards that set
 * `north_star` but never `milestone` must not read `idle_empty` → `decompose`.
 *
 * Live 2026-08-29 through 2026-09-13 (brain
 * `papercut-milestone-gap-report-idle-empty-ignores-ns-only-completion-checkpoints`):
 * `kanban milestone detail ms-fold-gate-back-under-10-minutes --json` returned
 * `children=[]` while five merged PRs under `north-star-local-ci-under-10-minutes`
 * covered its acceptance verbatim. gap-report queued it for decomposition on
 * 8+ hourly driver runs; each run re-verified the same merged PRs by hand and
 * filed nothing. The evidence was on the board the whole time — the read just
 * keyed on the wrong field.
 */
import { describe, expect, test } from "bun:test";

import type { Config } from "../src/config.ts";
import { fakeNode, type FakeNode } from "./fake-node.ts";
import {
  classifyMilestoneGap,
  milestoneDetailResult,
  milestoneGapReportResult,
  milestoneReconcileFromSnapshot,
  northStarOnlyDoneCards,
} from "../src/commands/milestone.ts";
import { boardCardSk } from "../src/board-cards.ts";
import { boardMilestoneFieldsFromMilestone, boardMilestoneSk } from "../src/board-milestones.ts";
import { nowIso, type Card, type Milestone } from "../src/record.ts";

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
    slug: "ms-gate",
    title: "fold gate back under 10 minutes",
    body: "",
    board: "default",
    state: "planned",
    position: "10",
    north_star: "ns-ci",
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

function card(partial: Partial<Card> = {}): Card {
  const now = nowIso();
  return {
    slug: "c",
    title: "A card",
    body: "Repo: EdgeVector/fold\nBase: main\n\n## GOAL\nWork.\n\n## END STATE\nDone.\n",
    board: "default",
    column: "done",
    position: "10",
    assignee: "",
    tags: [],
    deps: [],
    surfaces: [],
    created_at: now,
    created_by: "test",
    updated_at: now,
    done_at: now,
    db: "",
    repo: "EdgeVector/fold",
    base: "main",
    kind: "pr",
    block_status: "none",
    block_reason: "",
    north_star: "ns-ci",
    milestone: "",
    pr_url: "",
    branch: "",
    ...partial,
  } as Card;
}

describe("northStarOnlyDoneCards", () => {
  test("returns done Kind:pr under the North Star with no milestone, and nothing else", () => {
    const milestone = ms({ proof_card: "ns-ci-proof" });
    const board = [
      card({ slug: "clippy-jobs" }),
      card({ slug: "changed-path-gating" }),
      // Claimed by another milestone: that milestone's business.
      card({ slug: "other-ms-pr", milestone: "ms-other" }),
      // Different North Star.
      card({ slug: "other-ns-pr", north_star: "ns-other" }),
      // Not done yet — not a completion checkpoint.
      card({ slug: "still-doing", column: "doing" }),
      // Not implementation work (`normalizeKind` folds unknown kinds to pr,
      // so use a kind the enum knows).
      card({ slug: "ns-ci-tracker", kind: "tracker" }),
      // The milestone's own proof card is never implementation evidence.
      card({ slug: "ns-ci-proof", kind: "validation" }),
      // Another board.
      card({ slug: "elsewhere", board: "scratch" }),
    ];
    expect(northStarOnlyDoneCards(milestone, board).map((c) => c.slug)).toEqual(["clippy-jobs", "changed-path-gating"]);
  });

  test("a milestone with no North Star has no NS-only evidence", () => {
    expect(northStarOnlyDoneCards(ms({ north_star: "" }), [card({ slug: "x" })])).toEqual([]);
  });
});

describe("classifyMilestoneGap honors NS-only completion checkpoints", () => {
  test("children=[] with done NS-only Kind:pr → idle_ns_evidence / skip, not idle_empty / decompose", () => {
    const milestone = ms();
    const board = [card({ slug: "clippy-jobs" }), card({ slug: "changed-path-gating" })];
    const entry = classifyMilestoneGap(milestone, board, [], null);
    expect(entry.status).toBe("idle_ns_evidence");
    expect(entry.action).toBe("skip");
    expect(entry.ns_only_done).toEqual(["clippy-jobs", "changed-path-gating"]);
    expect(entry.pr_done).toBe(0);
    expect(entry.reason).toContain("clippy-jobs");
    expect(entry.reason).toContain("kanban set <slug> --milestone ms-gate");
  });

  test("children=[] with NO NS-only evidence still reads idle_empty / decompose", () => {
    const entry = classifyMilestoneGap(ms(), [card({ slug: "other", north_star: "ns-other" })], [], null);
    expect(entry.status).toBe("idle_empty");
    expect(entry.action).toBe("decompose");
    expect(entry.ns_only_done).toEqual([]);
  });

  test("a live milestone-linked child outranks NS-only evidence (in_flight wins)", () => {
    const linked = card({ slug: "linked-todo", column: "todo", milestone: "ms-gate" });
    const entry = classifyMilestoneGap(
      ms(),
      [linked, card({ slug: "clippy-jobs" })],
      [{ slug: "linked-todo", title: "t", column: "todo", blocked: false, blockedBy: [] }],
      null,
    );
    expect(entry.status).toBe("in_flight");
    // Still reported, so a reader can relink; it just does not decide the status.
    expect(entry.ns_only_done).toEqual(["clippy-jobs"]);
  });

  test("relinking the evidence turns the read into an ordinary pr_done>0 read", () => {
    const relinked = card({ slug: "clippy-jobs", milestone: "ms-gate" });
    const entry = classifyMilestoneGap(
      ms({ state: "active", proof_status: "not_required" }),
      [relinked],
      [{ slug: "clippy-jobs", title: "t", column: "done", blocked: false, blockedBy: [] }],
      null,
    );
    expect(entry.pr_done).toBe(1);
    expect(entry.status).toBe("proof_ready");
    expect(entry.action).toBe("complete_proof");
    expect(entry.ns_only_done).toEqual([]);
  });
});

describe("milestoneReconcileFromSnapshot surfaces the disagreement", () => {
  test("children=[] + NS-only done cards → ns-only-done-evidence warning naming the slugs", () => {
    const milestone = ms();
    const evidence = [card({ slug: "clippy-jobs" }), card({ slug: "changed-path-gating" })];
    const result = milestoneReconcileFromSnapshot(milestone, [], [], null, false, evidence);
    expect(result.children).toEqual([]);
    const warning = result.warnings.find((w) => w.code === "ns-only-done-evidence");
    expect(warning).toBeDefined();
    expect(warning?.message).toContain("clippy-jobs, changed-path-gating");
    expect(warning?.message).toContain("north_star=ns-ci");
    expect(warning?.hint).toContain("--milestone ms-gate");
  });

  test("no warning when the milestone already has implementation children", () => {
    const linked = card({ slug: "linked", milestone: "ms-gate" });
    const result = milestoneReconcileFromSnapshot(ms(), [linked], [linked], null, false, [card({ slug: "clippy-jobs" })]);
    expect(result.warnings.some((w) => w.code === "ns-only-done-evidence")).toBe(false);
  });

  test("no warning without the evidence (the default read is unchanged)", () => {
    const result = milestoneReconcileFromSnapshot(ms(), [], [], null, false);
    expect(result.warnings.some((w) => w.code === "ns-only-done-evidence")).toBe(false);
  });

  test("no warning on a complete milestone", () => {
    const result = milestoneReconcileFromSnapshot(ms({ state: "complete" }), [], [], null, false, [card({ slug: "x" })]);
    expect(result.warnings.some((w) => w.code === "ns-only-done-evidence")).toBe(false);
  });
});

// --- End-to-end through the fake node: the reads the driver actually runs. ---

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

function seedMilestone(node: FakeNode, milestone: Milestone): void {
  node.seed({ schemaHash: MILESTONE, keyHash: milestone.slug, fields: { ...milestone } });
  node.seed({
    schemaHash: BOARD_MILESTONES,
    keyHash: milestone.board,
    rangeKey: boardMilestoneSk(milestone.state, milestone.position, milestone.slug),
    fields: { ...boardMilestoneFieldsFromMilestone(milestone), completed_at: milestone.completed_at },
  });
}

function seedBoardCard(node: FakeNode, partial: Partial<Card>): void {
  const fields = card(partial) as unknown as Record<string, unknown>;
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

describe("gap-report and detail read NS-only evidence from the board", () => {
  test("the ms-fold-gate shape: children=[] but five merged NS PRs → not decompose, warning on detail", async () => {
    const node = fakeNode({ dropIncompleteRows: false });
    seedBoard(node);
    seedMilestone(node, ms({ slug: "ms-gate", north_star: "ns-ci" }));
    // A sibling milestone with nothing under its North Star: the control.
    seedMilestone(node, ms({ slug: "ms-empty", north_star: "ns-empty", position: "20" }));
    for (const [i, slug] of ["clippy-jobs", "lint-offload", "changed-path-gating", "dep-dedupe", "lane-partition"].entries()) {
      seedBoardCard(node, { slug, north_star: "ns-ci", milestone: "", column: "done", position: String(100 + i) });
    }
    // A done card under the same NS but claimed by another milestone stays out.
    seedBoardCard(node, { slug: "earlier-ms-pr", north_star: "ns-ci", milestone: "ms-earlier", column: "done", position: "200" });

    const { report, text } = await milestoneGapReportResult({ cfg, node });
    const bySlug = Object.fromEntries(report.milestones.map((m) => [m.slug, m]));
    expect(bySlug["ms-gate"]?.status).toBe("idle_ns_evidence");
    expect(bySlug["ms-gate"]?.action).toBe("skip");
    expect(bySlug["ms-gate"]?.ns_only_done).toEqual(["clippy-jobs", "lint-offload", "changed-path-gating", "dep-dedupe", "lane-partition"]);
    expect(bySlug["ms-empty"]?.status).toBe("idle_empty");
    expect(bySlug["ms-empty"]?.action).toBe("decompose");
    expect(report.counts.idle_ns_evidence).toBe(1);
    expect(report.counts.idle_empty).toBe(1);
    expect(report.work_queue.map((w) => w.slug)).toEqual(["ms-empty"]);
    expect(text).toContain("idle_ns_evidence=1");

    const { detail } = await milestoneDetailResult({ cfg, node, slug: "ms-gate" });
    expect(detail.children).toEqual([]);
    const warning = detail.warnings.find((w) => w.code === "ns-only-done-evidence");
    expect(warning?.message).toContain("5 done Kind:pr under north_star=ns-ci");
    expect(warning?.message).not.toContain("earlier-ms-pr");

    const empty = await milestoneDetailResult({ cfg, node, slug: "ms-empty" });
    expect(empty.detail.warnings.some((w) => w.code === "ns-only-done-evidence")).toBe(false);
  });
});
