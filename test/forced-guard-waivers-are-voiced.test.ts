// `--force` is ONE waiver over INDEPENDENT guards. `forced-dep-waiver-is-voiced`
// closed that trap for the dependency block; this file closes it for the two
// other gates that could be voiced without changing what a forced write DOES.
//
// The entry point into the trap is not exotic — it is the CLI's own advice.
// `assertLivePrMilestone` refuses with "… or --force for an intentional
// Unassigned/Operational exception", so the flag an operator reaches for to
// clear a MILESTONE requirement is the same flag that clears the dependency
// block, the pickup-readiness gate and the lifecycle CI gate. Measured from the
// chief-engineer seat 2026-08-03: `kanban move <slug> todo` printed exactly that
// hint, and following it waived gates nobody asked about, in silence.
//
// Of the four, the lifecycle gate is the one whose silence costs the most: it
// puts a card in the board's TERMINAL column while required CI contexts are
// failing, and `done` is what the milestone proof state and every "is it
// shipped?" rollup read.
//
// What is deliberately NOT asserted anywhere below: that `--force` stops
// working. It still overrides — it just says so.
//
// `assertDefaultTodoPickupReady` is deliberately absent. It mutates the card
// (`sanitizeDefaultTodoLaneMetadata` clears branch/pr_url) and throws
// `card_body_not_loaded` on a body-free projection, so running it to DESCRIBE a
// waiver would change the write and invent verdicts. See the note on
// `assertDepUnblocked` in src/record.ts.

import { describe, expect, test } from "bun:test";

import { FkanbanError, type NodeClient } from "../src/client.ts";
import {
  assertLivePrMilestone,
  forcedGuardWaiverWarning,
  type Card,
} from "../src/record.ts";
import { assertLifecycleMoveAllowed } from "../src/pipeline_status.ts";

/** Capture stderr warnings for the duration of one action. */
async function captureWarnings<T>(fn: () => T | Promise<T>): Promise<{ result: T; warnings: string[] }> {
  const warnings: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const result = await fn();
    return { result, warnings };
  } finally {
    console.error = original;
  }
}

const prCard = (over: Partial<Card> = {}): Pick<Card, "slug" | "kind" | "column" | "milestone"> => ({
  slug: "work",
  kind: "pr",
  column: "todo",
  milestone: "",
  ...over,
});

describe("--force waives the live-PR milestone gate out loud", () => {
  test("the waiver names the card, the column and the rule it cleared", async () => {
    const { warnings } = await captureWarnings(() =>
      assertLivePrMilestone(prCard(), true, { enforce: true }),
    );

    const waiver = warnings.find((w) => w.includes("--force"));
    expect(waiver).toBeDefined();
    expect(waiver).toContain("work");
    expect(waiver).toContain("todo");
    expect(waiver).toContain("milestone");
    // The distinguishing half: an override is not a pass.
    expect(waiver).toContain("overridden, not satisfied");
  });

  test("an abandoned milestone is waived out loud too, naming the milestone", async () => {
    // Two independent verdicts share this gate. Voicing only the missing-link
    // one would leave live PR work silently anchored to a dead outcome — the
    // case the abandoned check was added for.
    const { warnings } = await captureWarnings(() =>
      assertLivePrMilestone(prCard({ milestone: "ms-dead" }), true, {
        enforce: true,
        milestoneState: "abandoned",
      }),
    );

    const waiver = warnings.find((w) => w.includes("--force"));
    expect(waiver).toBeDefined();
    expect(waiver).toContain("ms-dead");
    expect(waiver).toContain("abandoned");
  });

  test("the forced and unforced readings are the same verdict", async () => {
    // The reason the gate throws into a capture instead of returning a verdict
    // object: one code path, so the sentence an operator sees after overriding
    // cannot drift from the sentence they saw when refused.
    let refusal: FkanbanError | null = null;
    try {
      assertLivePrMilestone(prCard(), false, { enforce: true });
    } catch (err) {
      refusal = err as FkanbanError;
    }
    expect(refusal).not.toBeNull();

    const { warnings } = await captureWarnings(() =>
      assertLivePrMilestone(prCard(), true, { enforce: true }),
    );
    expect(warnings[0]).toContain(refusal!.message);
  });

  test("nothing is said when --force did not actually waive this gate", async () => {
    // Silence is correct whenever there was no verdict to override. A warning
    // on every forced write is noise, and noise stops being read.
    const cases: Array<[string, () => void]> = [
      ["card already has a milestone", () =>
        assertLivePrMilestone(prCard({ milestone: "ms-live" }), true, { enforce: true })],
      ["card is not Kind:pr", () =>
        assertLivePrMilestone(prCard({ kind: "tracker" }), true, { enforce: true })],
      ["column is outside the pickup lane", () =>
        assertLivePrMilestone(prCard({ column: "backlog" }), true, { enforce: true })],
      // A gate switched OFF waived nothing — naming a rule that was not in
      // effect would be the worst kind of false positive.
      ["enforcement is disabled", () =>
        assertLivePrMilestone(prCard(), true, { enforce: false })],
    ];

    for (const [why, run] of cases) {
      const { warnings } = await captureWarnings(run);
      expect(warnings.filter((w) => w.includes("--force")), why).toEqual([]);
    }
  });

  test("the unforced gate still refuses, and refuses silently", async () => {
    // The warning belongs to the WAIVER. A refusal already carries its verdict
    // in the thrown message; printing it too would double-voice it.
    const warnings: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => warnings.push(args.map((a) => String(a)).join(" "));
    try {
      expect(() => assertLivePrMilestone(prCard(), false, { enforce: true })).toThrow();
    } finally {
      console.error = original;
    }
    expect(warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

const GATED_BODY = "## GOAL\nship it\n\nRepo: EdgeVector/fkanban\nRequires-Status: ci-required\n";

const lifecycleCard = (over: Partial<Card> = {}): Card =>
  ({
    slug: "work",
    title: "Work",
    body: GATED_BODY,
    board: "default",
    column: "doing",
    position: "1",
    assignee: "",
    tags: [],
    deps: [],
    surfaces: [],
    created_at: "2026-08-03T00:00:00Z",
    created_by: "",
    updated_at: "2026-08-03T00:00:00Z",
    db: "",
    repo: "EdgeVector/fkanban",
    base: "main",
    kind: "pr",
    block_status: "none",
    block_reason: "",
    north_star: "",
    milestone: "",
    pr_url: "",
    branch: "feat/x",
    ...over,
  }) as Card;

/** A node whose status reads answer, but with nothing successful on the commit. */
const emptyStatusNode = (): NodeClient =>
  ({
    queryAll: () => Promise.resolve({ rows: [] }),
  }) as unknown as NodeClient;

describe("--force waives the lifecycle pipeline-status gate out loud", () => {
  test("a forced terminal move with unmet contexts names them", async () => {
    const { warnings } = await captureWarnings(() =>
      assertLifecycleMoveAllowed({
        node: emptyStatusNode(),
        card: lifecycleCard(),
        targetColumn: "done",
        terminalColumn: "done",
        force: true,
      }),
    );

    const waiver = warnings.find((w) => w.includes("--force"));
    expect(waiver).toBeDefined();
    expect(waiver).toContain("work");
    expect(waiver).toContain("ci-required");
    expect(waiver).toContain("overridden, not satisfied");
  });

  test("a forced move on an UNGATED card pays no read", async () => {
    // Constraint 1 from assertDepUnblocked: the reads that describe a waiver
    // are only worth paying when there is a verdict to describe. A card with no
    // Requires-Status/Requires-Deploy header is knowably ungated from a pure
    // body parse, so it must short-circuit BEFORE attachPipelineStatus.
    let reads = 0;
    const counting = {
      queryAll: () => {
        reads += 1;
        return Promise.resolve({ rows: [] });
      },
    } as unknown as NodeClient;

    await assertLifecycleMoveAllowed({
      node: counting,
      card: lifecycleCard({ body: "## GOAL\nno lifecycle header here\n" }),
      targetColumn: "done",
      terminalColumn: "done",
      force: true,
    });
    expect(reads).toBe(0);

    // …and a GATED card does read, so the 0 above means "short-circuited",
    // not "this gate never reads", which would make the assertion vacuous.
    await assertLifecycleMoveAllowed({
      node: counting,
      card: lifecycleCard(),
      targetColumn: "done",
      terminalColumn: "done",
      force: true,
    });
    expect(reads).toBeGreaterThan(0);
  });

  test("a node that cannot answer does not turn an override into a refusal", async () => {
    // Constraint 2, and the reason there is no `try` around the status read:
    // `attachPipelineStatus` is best-effort and NEVER THROWS. A degraded node
    // arrives as an unmet context, not an exception — so the forced move
    // proceeds and the waiver names what went unverified. A defensive catch
    // here would be unreachable code pretending to hold a line that the
    // callee already holds.
    const failing = {
      queryAll: () => Promise.reject(new Error("service_timeout: node did not respond")),
    } as unknown as NodeClient;

    const { warnings } = await captureWarnings(() =>
      assertLifecycleMoveAllowed({
        node: failing,
        card: lifecycleCard(),
        targetColumn: "done",
        terminalColumn: "done",
        force: true,
      }),
    );

    const waiver = warnings.find((w) => w.includes("--force"));
    expect(waiver).toBeDefined();
    expect(waiver).toContain("ci-required");
    expect(waiver).toContain("overridden, not satisfied");
  });

  test("the same degraded read still refuses when unforced", async () => {
    // Fail-closed is this opt-in gate's PRE-EXISTING stance, pinned here so the
    // waiver work above cannot be mistaken for having relaxed it: a node that
    // cannot resolve the commit reports `missing`, and `missing` is not success.
    const failing = {
      queryAll: () => Promise.reject(new Error("service_timeout: node did not respond")),
    } as unknown as NodeClient;

    await expect(
      assertLifecycleMoveAllowed({
        node: failing,
        card: lifecycleCard(),
        targetColumn: "done",
        terminalColumn: "done",
      }),
    ).rejects.toMatchObject({ code: "lifecycle_status_blocked" });
  });

  test("a non-terminal move is silent and unread even under force", async () => {
    let reads = 0;
    const counting = {
      queryAll: () => {
        reads += 1;
        return Promise.resolve({ rows: [] });
      },
    } as unknown as NodeClient;

    const { warnings } = await captureWarnings(() =>
      assertLifecycleMoveAllowed({
        node: counting,
        card: lifecycleCard(),
        targetColumn: "doing",
        terminalColumn: "done",
        force: true,
      }),
    );
    expect(reads).toBe(0);
    expect(warnings).toEqual([]);
  });
});

describe("forcedGuardWaiverWarning", () => {
  test("names the gate, since one flag clears several", () => {
    // A warning that said only "--force waived a gate" would reproduce the
    // ambiguity the sentence exists to remove.
    const w = forcedGuardWaiverWarning("card-x", "live-PR milestone", "Verdict sentence.");
    expect(w).toContain("live-PR milestone");
    expect(w).toContain("card-x");
    expect(w).toContain("Verdict sentence.");
    expect(w).toContain("overridden, not satisfied");
  });
});
