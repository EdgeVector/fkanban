import { describe, expect, test } from "bun:test";
import {
  assertPrWorkBrief,
  hasPrWorkBrief,
  isSubstantiveCardBody,
  resolveMilestoneDriver,
  DEFAULT_MILESTONE_DRIVER,
  emptyStructuredFields,
  assertDefaultTodoPickupReady,
  type Card,
} from "../src/record.ts";
import { groomCard } from "../src/pickup.ts";
import { FkanbanError } from "../src/client.ts";

function card(partial: Partial<Card> & { slug: string }): Card {
  const now = new Date().toISOString();
  return {
    title: partial.slug,
    body: partial.body ?? "Repo: EdgeVector/fold\nBase: main\nKind: pr\n\n## GOAL\nx\n\n## END STATE\ny\n",
    board: "default",
    column: "todo",
    position: "1",
    assignee: "",
    tags: [],
    deps: [],
    created_at: now,
    updated_at: now,
    ...emptyStructuredFields(),
    done_at: "",
    repo: "EdgeVector/fold",
    base: "main",
    kind: "pr",
    block_status: "none",
    ...partial,
  };
}

describe("hasPrWorkBrief", () => {
  test("requires both goal and end/done-when", () => {
    expect(hasPrWorkBrief("## GOAL\ndo it\n")).toBe(false);
    expect(hasPrWorkBrief("## END STATE\ndone\n")).toBe(false);
    expect(hasPrWorkBrief("## GOAL\ndo it\n\n## END STATE\ndone\n")).toBe(true);
    expect(hasPrWorkBrief("GOAL: ship\nDONE-WHEN: date >= 2026-01-01\n")).toBe(true);
  });
});

describe("assertPrWorkBrief", () => {
  test("rejects hollow pr bodies in default/todo", () => {
    expect(() =>
      assertPrWorkBrief("x", "pr", "Repo: EdgeVector/fold\nBase: main\n", false, {
        board: "default",
        column: "todo",
      }),
    ).toThrow(FkanbanError);
    try {
      assertPrWorkBrief("x", "pr", "Repo: EdgeVector/fold\nBase: main\n", false, {
        board: "default",
        column: "todo",
      });
    } catch (e) {
      expect((e as FkanbanError).code).toBe("pr_body_missing_work_brief");
    }
  });
  test("allows hollow shells in backlog (groom flags later)", () => {
    expect(() =>
      assertPrWorkBrief("x", "pr", "Repo: EdgeVector/fold\nBase: main\n", false, {
        board: "default",
        column: "backlog",
      }),
    ).not.toThrow();
  });
  test("allows substantive prose in backlog without GOAL headings", () => {
    expect(() =>
      assertPrWorkBrief("x", "pr", "Repo: EdgeVector/fold\nBase: main\n\nTest fixture work.", false, {
        board: "default",
        column: "backlog",
      }),
    ).not.toThrow();
  });
  test("allows substantive prose in default/todo (GOAL+END STATE is groom/docs contract)", () => {
    expect(() =>
      assertPrWorkBrief("x", "pr", "Repo: EdgeVector/fold\nBase: main\n\nTest fixture work.", false, {
        board: "default",
        column: "todo",
      }),
    ).not.toThrow();
  });
  test("allows validation kind without brief", () => {
    expect(() => assertPrWorkBrief("x", "validation", "DONE-WHEN: brain foo exists")).not.toThrow();
  });
  test("force bypass", () => {
    expect(() => assertPrWorkBrief("x", "pr", "", true)).not.toThrow();
  });
});

describe("resolveMilestoneDriver", () => {
  test("defaults on create", () => {
    expect(resolveMilestoneDriver(undefined, undefined, true)).toBe(DEFAULT_MILESTONE_DRIVER);
  });
  test("heals superseded program-driver on update", () => {
    expect(resolveMilestoneDriver(undefined, "program-driver", false)).toBe(DEFAULT_MILESTONE_DRIVER);
  });
  test("refuses explicit program-driver", () => {
    expect(() => resolveMilestoneDriver("program-driver", undefined, true)).toThrow(FkanbanError);
    try {
      resolveMilestoneDriver("program-driver", undefined, true);
    } catch (e) {
      expect((e as FkanbanError).code).toBe("superseded_milestone_driver");
    }
  });
  test("preserves custom drivers", () => {
    expect(resolveMilestoneDriver("alice", undefined, true)).toBe("alice");
  });
});

describe("assertDefaultTodoPickupReady pr brief", () => {
  test("rejects empty body", () => {
    const c = card({
      slug: "empty",
      body: "Repo: EdgeVector/fold\nBase: main\n\n",
    });
    expect(() => assertDefaultTodoPickupReady(c)).toThrow(FkanbanError);
  });
  test("accepts goal + end state", () => {
    const c = card({ slug: "full-brief" });
    expect(() => assertDefaultTodoPickupReady(c)).not.toThrow();
  });
});

describe("groomCard hollow pr", () => {
  test("clears false needs_human and demotes hollow pr from todo", () => {
    const hollow = card({
      slug: "hollow",
      body: "Repo: EdgeVector/fold\nBase: main\n\n",
      block_status: "needs_human",
      block_reason: "empty card body; needs END STATE/GOAL/STEPS/VERIFY before pickup",
      column: "todo",
    });
    const { card: next, issues, changed } = groomCard(hollow, [hollow]);
    expect(changed).toBe(true);
    expect(next.column).toBe("backlog");
    expect(next.block_status).toBe("none");
    expect(next.block_reason).toBe("");
    // human-parking-candidate demotes needs_human out of todo first; hollow
    // repair clears the false Tom gate rather than inventing a new one.
    expect(issues.some((i) => i.kind === "hollow-pr-false-human-gate")).toBe(true);
  });

  test("demotes hollow pr in todo without inventing needs_human", () => {
    const hollow = card({
      slug: "hollow-todo",
      body: "Repo: EdgeVector/fold\nBase: main\n\n",
      block_status: "none",
      column: "todo",
    });
    const { card: next, issues, changed } = groomCard(hollow, [hollow]);
    expect(changed).toBe(true);
    expect(next.column).toBe("backlog");
    expect(next.block_status).toBe("none");
    expect(issues.some((i) => i.kind === "hollow-pr-in-todo")).toBe(true);
  });

  test("reports missing sections without inventing a human gate", () => {
    const partial = card({
      slug: "partial",
      column: "backlog",
      body: "Repo: EdgeVector/fold\nBase: main\n\n## GOAL\nship it\n",
    });
    const { issues, changed } = groomCard(partial, [partial]);
    expect(changed).toBe(false);
    expect(issues.some((i) => i.kind === "hollow-pr-brief")).toBe(true);
    expect(issues.every((i) => i.applyable === false || i.kind !== "hollow-pr-brief")).toBe(true);
  });
});

describe("isSubstantive still works", () => {
  test("annotation-only fails", () => {
    expect(isSubstantiveCardBody("HANDOFF: worktree=/tmp/x")).toBe(false);
  });
});
