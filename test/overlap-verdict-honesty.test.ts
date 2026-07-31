/**
 * The surface-overlap gate must not report a pass it never evaluated.
 *
 * `conflicts.length === 0` conflates "checked, clear" with "nothing was
 * declared, so nothing could be checked". On the live default board that
 * second case is near-universal (100 of 104 todo cards declare no surfaces),
 * so the gate printed `OK surface-overlap — no conflicts with doing` for
 * essentially every card while having evaluated nothing. See brain
 * `papercut-kanban-surface-overlap-gate-is-a-no-op-in-practice`.
 *
 * These tests pin the distinction, and pin that it stays ADVISORY: the claim
 * path keys off `conflicts`, so an unknown/partial verdict must never turn
 * into a skip.
 */
import { describe, expect, test } from "bun:test";

import { emptyStructuredFields, type Card } from "../src/record.ts";
import { overlapAgainstCards, overlapVerdict } from "../src/commands/overlap.ts";
import { renderPickupExplain, type PickupExplainReport } from "../src/commands/pickup_explain.ts";

function card(partial: Partial<Card>): Card {
  return {
    slug: "c",
    title: "C",
    body: "",
    board: "default",
    column: "todo",
    position: "1",
    assignee: "",
    tags: [],
    deps: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...emptyStructuredFields(),
    repo: "EdgeVector/fkanban",
    base: "main",
    kind: "pr",
    ...partial,
  };
}

describe("overlap verdict — what the gate is entitled to say", () => {
  test("candidate with no surfaces is `unknown`, not a pass", () => {
    // The live-board case: repo declared, surfaces not. The peer loop never runs.
    const candidate = card({ slug: "cand", surfaces: [] });
    const peer = card({ slug: "peer", column: "doing", surfaces: ["src/cli.ts"] });

    const result = overlapAgainstCards(candidate, [candidate, peer]);

    expect(result.conflicts).toHaveLength(0);
    expect(result.candidateUndeclared).toBe(true);
    expect(overlapVerdict(result)).toBe("unknown");
  });

  test("candidate with no repo is `unknown`", () => {
    const candidate = card({ slug: "cand", repo: "", surfaces: ["src/cli.ts"] });
    const result = overlapAgainstCards(candidate, [candidate]);

    expect(result.candidateUndeclared).toBe(true);
    expect(overlapVerdict(result)).toBe("unknown");
  });

  test("declared candidate + every peer comparable is a genuine `clear`", () => {
    const candidate = card({ slug: "cand", surfaces: ["src/cli.ts"] });
    const peer = card({ slug: "peer", column: "doing", surfaces: ["docs/readme.md"] });

    const result = overlapAgainstCards(candidate, [candidate, peer]);

    expect(result.conflicts).toHaveLength(0);
    expect(result.unevaluatedPeers).toEqual([]);
    expect(result.candidateUndeclared).toBe(false);
    expect(overlapVerdict(result)).toBe("clear");
  });

  test("an undeclared peer downgrades `clear` to `partial` and names the peer", () => {
    // This is the dangerous case the old boolean hid: the candidate declared,
    // a real in-flight peer exists in the same repo, and it could not be judged.
    const candidate = card({ slug: "cand", surfaces: ["src/cli.ts"] });
    const comparable = card({ slug: "peer-ok", column: "doing", surfaces: ["docs/readme.md"] });
    const undeclared = card({ slug: "peer-blind", column: "doing", surfaces: [] });

    const result = overlapAgainstCards(candidate, [candidate, comparable, undeclared]);

    expect(result.conflicts).toHaveLength(0);
    expect(result.unevaluatedPeers).toEqual(["peer-blind"]);
    expect(overlapVerdict(result)).toBe("partial");
  });

  test("a real overlap still wins over any unknown peer", () => {
    const candidate = card({ slug: "cand", surfaces: ["src/cli.ts"] });
    const clash = card({ slug: "peer-clash", column: "doing", surfaces: ["src/cli.ts"] });
    const undeclared = card({ slug: "peer-blind", column: "doing", surfaces: [] });

    const result = overlapAgainstCards(candidate, [candidate, clash, undeclared]);

    expect(result.conflicts.map((c) => c.slug)).toEqual(["peer-clash"]);
    expect(result.unevaluatedPeers).toEqual(["peer-blind"]);
    expect(overlapVerdict(result)).toBe("conflict");
  });

  test("unknown/partial stay ADVISORY — conflicts, which claim keys off, stays empty", () => {
    // `pickup claim` skips on `conflicts.length > 0`. If an unknown verdict ever
    // leaked into `conflicts`, nearly every card on the live board would become
    // unclaimable. This is the regression that would hurt most.
    const undeclaredCandidate = overlapAgainstCards(card({ slug: "a", surfaces: [] }), [
      card({ slug: "a", surfaces: [] }),
      card({ slug: "peer", column: "doing", surfaces: ["src/cli.ts"] }),
    ]);
    const partial = overlapAgainstCards(card({ slug: "b", surfaces: ["src/cli.ts"] }), [
      card({ slug: "b", surfaces: ["src/cli.ts"] }),
      card({ slug: "peer", column: "doing", surfaces: [] }),
    ]);

    expect(overlapVerdict(undeclaredCandidate)).toBe("unknown");
    expect(undeclaredCandidate.conflicts).toEqual([]);
    expect(overlapVerdict(partial)).toBe("partial");
    expect(partial.conflicts).toEqual([]);
  });

  test("peers not in `doing` are irrelevant — a todo peer cannot make it partial", () => {
    const candidate = card({ slug: "cand", surfaces: ["src/cli.ts"] });
    const todoPeer = card({ slug: "peer-todo", column: "todo", surfaces: [] });

    const result = overlapAgainstCards(candidate, [candidate, todoPeer]);

    expect(result.unevaluatedPeers).toEqual([]);
    expect(overlapVerdict(result)).toBe("clear");
  });
});

describe("gate rendering — UNK is neither OK nor FAIL", () => {
  function report(gate: PickupExplainReport["gates"][number]): PickupExplainReport {
    return {
      slug: "cand",
      board: "default",
      column: "todo",
      kind: "pr",
      repo: "EdgeVector/fkanban",
      base: "main",
      block_status: "none",
      category: "pickup-ready",
      ready: true,
      reason: "ready",
      suggestion: "Pick this card up next.",
      details: [],
      blockedBy: [],
      missingDeps: [],
      lane: "program:north-star-host-track",
      write_guard: { ok: true },
      surface_overlap: {
        conflicts: [],
        warnings: [],
        would_skip: false,
        verdict: "unknown",
        unevaluated_peers: [],
      },
      situation: { allowed: true },
      eligible_for_claim: true,
      gates: [gate],
    };
  }

  test("an unevaluated gate renders UNK, not FAIL", () => {
    const text = renderPickupExplain(
      report({ name: "surface-overlap", ok: false, note: "not evaluated", status: "unknown" }),
    );
    expect(text).toContain("UNK  surface-overlap");
    expect(text).not.toContain("FAIL surface-overlap");
  });

  test("a genuinely failing gate still renders FAIL", () => {
    const text = renderPickupExplain(
      report({ name: "surface-overlap", ok: false, note: "conflicts: peer" }),
    );
    expect(text).toContain("FAIL surface-overlap");
  });

  test("a passing gate still renders OK", () => {
    const text = renderPickupExplain(
      report({ name: "surface-overlap", ok: true, note: "no conflicts with doing" }),
    );
    expect(text).toContain("OK   surface-overlap");
  });
});
