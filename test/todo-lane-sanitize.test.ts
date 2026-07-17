import { describe, expect, test } from "bun:test";
import {
  assertDefaultTodoPickupReady,
  emptyStructuredFields,
  isDepEnforcedColumn,
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
});

describe("default/todo dep enforcement", () => {
  test("todo is dep-enforced on the default board", () => {
    expect(isDepEnforcedColumn("todo", "default")).toBe(true);
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
