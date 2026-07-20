import { describe, expect, test } from "bun:test";

import { renderPickupExplain, type PickupExplainReport } from "../src/commands/pickup_explain.ts";
import { classifyPickupCard } from "../src/pickup.ts";
import {
  emptyStructuredFields,
  nowIso,
  type Card,
} from "../src/record.ts";

function baseCard(over: Partial<Card> = {}): Card {
  return {
    ...emptyStructuredFields(),
    slug: "demo-ready",
    title: "Demo ready card",
    body: "Repo: EdgeVector/fold\nBase: main\n",
    board: "default",
    column: "todo",
    assignee: "",
    tags: [],
    deps: [],
    surfaces: ["src/foo.ts"],
    created_at: nowIso(),
    updated_at: nowIso(),
    done_at: "",
    db: "",
    repo: "EdgeVector/fold",
    base: "main",
    kind: "pr",
    block_status: "none",
    block_reason: "",
    north_star: "north-star-host-track",
    pr_url: "",
    branch: "",
    ...over,
  };
}

describe("pickup explain render", () => {
  test("renders eligible YES path", () => {
    const report: PickupExplainReport = {
      slug: "demo-ready",
      board: "default",
      column: "todo",
      kind: "pr",
      repo: "EdgeVector/fold",
      base: "main",
      block_status: "none",
      category: "pickup-ready",
      ready: true,
      reason: "ready for fkanban-agent WORK mode",
      suggestion: "Pick this card up next.",
      details: [],
      blockedBy: [],
      missingDeps: [],
      lane: "program:north-star-host-track",
      write_guard: { ok: true },
      surface_overlap: { conflicts: [], warnings: [], would_skip: false },
      situation: { allowed: true, reason: "no Situation preflight action inferred" },
      eligible_for_claim: true,
      gates: [
        { name: "write-guard (default/todo policy)", ok: true, note: "ok" },
        { name: "classify", ok: true, note: "pickup-ready" },
        { name: "surface-overlap", ok: true, note: "no conflicts with doing" },
        { name: "situation-fence", ok: true, note: "allowed" },
      ],
    };
    const text = renderPickupExplain(report);
    expect(text).toContain("eligible_for_claim: YES");
    expect(text).toContain("demo-ready");
    expect(text).toContain("lane=program:north-star-host-track");
  });

  test("classify non-pr is parked", () => {
    const card = baseCard({ kind: "validation", slug: "demo-validation" });
    const c = classifyPickupCard(card, [card], {
      blocked: false,
      blockedBy: [],
      missing: [],
    });
    expect(c.category).toBe("parked/non-work");
    expect(c.ready).toBe(false);
  });
});
