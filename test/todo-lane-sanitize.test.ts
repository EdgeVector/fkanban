import { describe, expect, test } from "bun:test";
import {
  assertBodyReplaceSafe,
  assertDefaultTodoPickupReady,
  emptyStructuredFields,
  isDepEnforcedColumn,
  isSubstantiveCardBody,
  sanitizeDefaultTodoLaneMetadata,
  type Card,
} from "../src/record.ts";
import { classifyPickupCard } from "../src/pickup.ts";

function card(partial: Partial<Card> & { slug: string }): Card {
  const now = new Date().toISOString();
  return {
    title: partial.slug,
    body: "Repo: EdgeVector/fold\nBase: main\nKind: pr\n\n## GOAL\nx",
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

describe("sanitizeDefaultTodoLaneMetadata", () => {
  test("clears planned branch and pr_url on default/todo", () => {
    const c = card({
      slug: "fold-split-example",
      branch: "kanban/fold-split-example",
      pr_url: "http://localhost:3300/EdgeVector/fold/pulls/1",
    });
    expect(sanitizeDefaultTodoLaneMetadata(c)).toBe(true);
    expect(c.branch).toBe("");
    expect(c.pr_url).toBe("");
  });

  test("no-op outside default/todo", () => {
    const c = card({
      slug: "in-doing",
      column: "doing",
      branch: "kanban/in-doing",
      pr_url: "http://example/pr/1",
    });
    expect(sanitizeDefaultTodoLaneMetadata(c)).toBe(false);
    expect(c.branch).toBe("kanban/in-doing");
    expect(c.pr_url).toBe("http://example/pr/1");
  });

  test("assertDefaultTodoPickupReady still accepts after sanitizing branch", () => {
    const c = card({ slug: "ready-card", branch: "kanban/ready-card" });
    expect(() => assertDefaultTodoPickupReady(c)).not.toThrow();
    expect(c.branch).toBe("");
  });

  test("assertDefaultTodoPickupReady rejects empty and HANDOFF-only bodies", () => {
    expect(() =>
      assertDefaultTodoPickupReady(card({ slug: "empty-body", body: "" })),
    ).toThrow(/empty or annotation-only body/);
    expect(() =>
      assertDefaultTodoPickupReady(
        card({
          slug: "handoff-only",
          body: "HANDOFF: worktree=/tmp/x branch=kanban/handoff-only",
        }),
      ),
    ).toThrow(/empty or annotation-only body/);
    expect(() =>
      assertDefaultTodoPickupReady(
        card({
          slug: "headers-only",
          body: "Repo: EdgeVector/fold\nBase: main\nKind: pr\n",
        }),
      ),
    ).toThrow(/empty or annotation-only body/);
  });
});

describe("card body substance + destructive replace", () => {
  test("isSubstantiveCardBody accepts fixtures and GOAL sections", () => {
    expect(isSubstantiveCardBody("Repo: EdgeVector/fkanban\nBase: main\n\nTest fixture work.")).toBe(true);
    expect(isSubstantiveCardBody("Repo: EdgeVector/fold\nBase: main\n\n## GOAL\nShip it.")).toBe(true);
    expect(isSubstantiveCardBody("")).toBe(false);
    expect(isSubstantiveCardBody("Created By: unknown\n")).toBe(false);
    expect(
      isSubstantiveCardBody(
        "HANDOFF: worktree=/Users/tom/.fkanban/worktrees/x branch=kanban/x",
      ),
    ).toBe(false);
  });

  test("assertBodyReplaceSafe blocks HANDOFF wipe of a real brief", () => {
    const full =
      "Repo: EdgeVector/fold\nBase: main\n\n## GOAL\nMake declare identities queryable.\n\n## STEPS\n1. Fix mint key.";
    expect(() =>
      assertBodyReplaceSafe(
        "wipe-me",
        full,
        "HANDOFF: worktree=/tmp/x branch=kanban/wipe-me",
      ),
    ).toThrow(/destructive_body_replace|annotation-only/);
    expect(() => assertBodyReplaceSafe("wipe-me", full, full + "\nHANDOFF: ok")).not.toThrow();
    expect(() =>
      assertBodyReplaceSafe(
        "wipe-me",
        full,
        "HANDOFF: only",
        true,
      ),
    ).not.toThrow();
    // Recovering an empty body is allowed.
    expect(() => assertBodyReplaceSafe("recover", "", full)).not.toThrow();
  });
});

describe("default/todo dep enforcement", () => {
  test("todo is not dep-enforced on the default board", () => {
    expect(isDepEnforcedColumn("todo", "default")).toBe(false);
    expect(isDepEnforcedColumn("backlog", "default")).toBe(false);
    expect(isDepEnforcedColumn("doing", "default")).toBe(true);
  });
});

describe("classifyPickupCard after lane policy", () => {
  test("todo with only branch is pickup-ready (not collision)", () => {
    const c = card({ slug: "with-branch", branch: "kanban/with-branch" });
    // Simulate pre-sanitize legacy card: classification should not collide on branch alone
    // (main already only checks pr_url). After sanitize, branch is empty either way.
    sanitizeDefaultTodoLaneMetadata(c);
    const result = classifyPickupCard(c, [c], {
      blocked: false,
      blockedBy: [],
      missing: [],
    });
    expect(result.category).toBe("pickup-ready");
    expect(result.ready).toBe(true);
  });
});
