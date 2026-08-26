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
import { formatOverlap, overlapAgainstCards, overlapVerdict } from "../src/commands/overlap.ts";
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

/**
 * `pickup explain` got the honest rendering when the verdict was introduced;
 * `overlap` — the command the verdict is NAMED after, and the one the
 * `fkanban_overlap` MCP tool renders through — kept branching on
 * `conflicts.length === 0` and printing the clean-bill-of-health line for
 * `clear`, `unknown` and `partial` alike.
 *
 * Nothing pinned it: before these tests, no assertion in the suite touched
 * `formatOverlap`'s conclusion line at all.
 */
describe("formatOverlap — the conclusion line must come from the verdict", () => {
  const undeclared = () =>
    overlapAgainstCards(card({ slug: "cand", surfaces: [] }), [
      card({ slug: "cand", surfaces: [] }),
      card({ slug: "peer", column: "doing", surfaces: ["src/cli.ts"] }),
    ]);

  test("`unknown` must not print the clean-bill-of-health line", () => {
    const text = formatOverlap(undeclared());

    // The defect, stated directly: this exact sentence is reserved for `clear`.
    expect(text).not.toContain("No declared surface conflicts");
    expect(text).toContain("Overlap UNKNOWN for cand");
    expect(text).toContain("nothing was compared");
  });

  test("`unknown` names WHICH claim is missing — surfaces vs repo are different fixes", () => {
    expect(formatOverlap(undeclared())).toContain("declares no surfaces");

    const noRepo = overlapAgainstCards(card({ slug: "cand", repo: "", surfaces: ["src/cli.ts"] }), [
      card({ slug: "cand", repo: "", surfaces: ["src/cli.ts"] }),
    ]);
    expect(overlapVerdict(noRepo)).toBe("unknown");
    expect(formatOverlap(noRepo)).toContain("declares no repo");
  });

  test("`partial` says a conflict may hide behind a peer it could not judge", () => {
    const partial = overlapAgainstCards(card({ slug: "cand", surfaces: ["src/cli.ts"] }), [
      card({ slug: "cand", surfaces: ["src/cli.ts"] }),
      card({ slug: "peer-blind", column: "doing", surfaces: [] }),
    ]);

    const text = formatOverlap(partial);

    expect(text).not.toContain("No declared surface conflicts");
    expect(text).toContain("Overlap PARTIAL for cand");
    // The peer must be NAMED — "1 could not be judged" is not actionable.
    expect(text).toContain("peer-blind");
  });

  test("`clear` still earns the pass line, and `conflict` still lists its matches", () => {
    // The deliberate quiet half: the two verdicts that were already honest must
    // read exactly as before. `clear` is the only state that earns a pass.
    const clear = overlapAgainstCards(card({ slug: "cand", surfaces: ["src/cli.ts"] }), [
      card({ slug: "cand", surfaces: ["src/cli.ts"] }),
      card({ slug: "peer", column: "doing", surfaces: ["docs/x.md"] }),
    ]);
    expect(overlapVerdict(clear)).toBe("clear");
    expect(formatOverlap(clear)).toContain("No declared surface conflicts for cand.");

    const conflict = overlapAgainstCards(card({ slug: "cand", surfaces: ["src/cli.ts"] }), [
      card({ slug: "cand", surfaces: ["src/cli.ts"] }),
      card({ slug: "peer", column: "doing", surfaces: ["src/cli.ts"] }),
    ]);
    const text = formatOverlap(conflict);
    expect(text).toContain("Surface conflicts for cand:");
    expect(text).toContain("src/cli.ts ↔ src/cli.ts");
  });

  test("--json carries the verdict, so a scripted caller need not re-derive it", () => {
    const parsed = JSON.parse(formatOverlap(undeclared(), true)) as {
      verdict: string;
      conflicts: unknown[];
      candidateUndeclared: boolean;
    };

    expect(parsed.verdict).toBe("unknown");
    // ...and the facts it is derived from stay on the payload, unchanged.
    expect(parsed.conflicts).toEqual([]);
    expect(parsed.candidateUndeclared).toBe(true);
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
      pr_liveness: {
        pr_url: "",
        state: "none",
        venue: "unknown",
        action: "work",
        note: "no pr_url; fresh WORK",
      },
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
