// The pickup contract used to be enforced only at the EXIT of backlog
// (`assertDefaultTodoPickupReady` returns unless the card is landing in
// default/todo). That made default/backlog a silent black hole: on 2026-08-08
// the live board read `pickup-ready: 2 of 78`, with 21 ungated Kind:pr cards
// parked there — every one of them refused by the same
// "cannot enter todo without a milestone" verdict, none of them ever reported.
//
// `warnUnreachableDefaultBacklogCard` closes that asymmetry at file time.
import { describe, expect, test } from "bun:test";
import {
  emptyStructuredFields,
  warnUnreachableDefaultBacklogCard,
  type Card,
} from "../src/record.ts";

function card(partial: Partial<Card> & { slug: string }): Card {
  const now = new Date().toISOString();
  return {
    title: partial.slug,
    body: "Repo: EdgeVector/fold\nBase: main\nKind: pr\n\n## GOAL\nx\n\n## END STATE\ny",
    board: "default",
    column: "backlog",
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
    milestone: "",
    ...partial,
  };
}

/**
 * Collect emitted warnings instead of writing to stderr. `enforce: true` is
 * what production `loadConfig` sets — the milestone rule only exists there, and
 * a test that left it off would pass while the real gate stayed silent.
 */
function warnings(c: Card, rawBody?: string, milestoneState = ""): string[] {
  const out: string[] = [];
  warnUnreachableDefaultBacklogCard(c, rawBody, {
    enforce: true,
    milestoneState,
    warn: (m) => out.push(m),
  });
  return out;
}

describe("warnUnreachableDefaultBacklogCard", () => {
  test("warns on the black-hole shape: ungated Kind:pr card with no milestone", () => {
    const out = warnings(card({ slug: "papercut-ops-terminal-single-board-list-poll" }));
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("papercut-ops-terminal-single-board-list-poll");
    expect(out[0]).toContain("cannot reach default/todo");
    // It must quote the REAL gate verdict, not a re-derived guess.
    expect(out[0]).toContain("without a milestone");
  });

  test("silent once the card has a milestone — the fix is recognized", () => {
    expect(warnings(card({ slug: "ready", milestone: "ms-real-outcome" }))).toEqual([]);
  });

  test("warns when the milestone it does have is abandoned", () => {
    // The real 2026-08-08 case: `north-star-search-native-semantic-parity`'s
    // only milestone was abandoned, so stamping it would not have helped.
    const out = warnings(
      card({ slug: "brain-tagindex-no-index", milestone: "ms-search-native-semantic-parity" }),
      undefined,
      "abandoned",
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("abandoned milestone");
  });

  test("silent on an intentional hold — backlog is the documented park", () => {
    expect(
      warnings(
        card({
          slug: "needs-tom",
          block_status: "needs_human",
          block_reason: "Tom must approve the live primary drain.",
        }),
      ),
    ).toEqual([]);
    expect(warnings(card({ slug: "parked", block_status: "deferred" }))).toEqual([]);
  });

  test("silent on non-pickup kinds — trackers and proofs belong in backlog", () => {
    for (const kind of ["tracker", "capstone", "validation", "program"] as const) {
      expect(warnings(card({ slug: `k-${kind}`, kind }))).toEqual([]);
    }
  });

  test("silent while a dependency is outstanding — the dep guard already voices that", () => {
    expect(warnings(card({ slug: "waiter", deps: ["some-other-card"] }))).toEqual([]);
  });

  test("silent outside default/backlog", () => {
    expect(warnings(card({ slug: "in-todo", column: "todo" }))).toEqual([]);
    expect(warnings(card({ slug: "in-doing", column: "doing" }))).toEqual([]);
    expect(warnings(card({ slug: "other-board", board: "agent-dogfood-scratch" }))).toEqual([]);
  });

  test("also catches an unreachable empty brief, not only a missing milestone", () => {
    const out = warnings(card({ slug: "no-brief", milestone: "ms-real-outcome", body: "" }), "");
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("no-brief");
  });

  test("does not mutate the card it inspects", () => {
    const c = card({ slug: "untouched", branch: "kanban/untouched" });
    warnings(c);
    expect(c.column).toBe("backlog");
    expect(c.branch).toBe("kanban/untouched");
  });
});
