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
// `assertDefaultTodoPickupReady`, `assertPrWorkBrief` and `assertBodyReplaceSafe`
// joined them on 2026-08-04, which is what lets the CLI hints promise that every
// waiver announces itself (`FORCE_IS_UNSCOPED`). The pickup gate needed a split
// first — its mutation and its hydration precondition had to come off the
// verdict — and the last section here is what holds that promise for guards
// nobody has written yet.
//
// That promise was still false when it shipped. A SEVENTH gate,
// `assertBodyIsNotSourceCode`, waived in silence in `src/commands/add.ts` — a
// file the source scan did not read, behind `if (opts.force || opts.body ===
// undefined) return;`, a shape its pattern did not match. Missing on both axes
// at once is the point: a scan reports "all clear" identically whether it looked
// and found nothing or never looked. So the last two sections here check the
// scan's own reach — the file list, and the gate enumeration — instead of only
// what it finds.


import { readFileSync, readdirSync } from "node:fs";

import { beforeEach, describe, expect, test } from "bun:test";

import { FkanbanError, type NodeClient } from "../src/client.ts";
import { fakeNode } from "./fake-node.ts";
import type { Config } from "../src/config.ts";
import {
  BODY_OMITTED,
  assertBodyReplaceSafe,
  assertDefaultTodoPickupReady,
  assertLivePrMilestone,
  assertPrWorkBrief,
  boardToFields,
  findCard,
  forcedGuardWaiverWarning,
  nowIso,
  type Card,
} from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";
import { addCmd } from "../src/commands/add.ts";
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

// ---------------------------------------------------------------------------

const READY_BODY =
  "## GOAL\nship the thing\n\n## END STATE\nit ships\n\nRepo: EdgeVector/fkanban\nBase: main\n";

const todoCard = (over: Partial<Card> = {}): Card =>
  lifecycleCard({ column: "todo", body: READY_BODY, branch: "", ...over });

describe("--force waives the default/todo pickup-readiness gate out loud", () => {
  test("each of the gate's verdicts is named, not just the first", async () => {
    // Six independent rules share one gate and one code. Voicing only the arm
    // that happens to run first would leave the others exactly as silent as
    // they were, which is the shape of the bug this closes rather than a fix.
    const cases: Array<[string, Card, string]> = [
      ["block_status", todoCard({ block_status: "needs_human", block_reason: "waiting" }), "needs_human"],
      ["kind", todoCard({ kind: "tracker" }), "kind=tracker"],
      ["empty body", todoCard({ body: "" }), "empty or annotation-only body"],
      ["repo", todoCard({ repo: "", body: READY_BODY.replace("Repo: EdgeVector/fkanban\n", "") }), "Repo"],
      ["base", todoCard({ base: "", body: READY_BODY.replace("Base: main\n", "") }), "Base"],
    ];

    for (const [why, card, expected] of cases) {
      // Prove the fixture is a REAL violation before believing the warning
      // means anything. Without this half a gate that never fired would pass
      // silently — the "check that can never read failure" this codebase keeps
      // finding in its own guards.
      expect(() => assertDefaultTodoPickupReady({ ...card }, false), why).toThrow();

      const { warnings } = await captureWarnings(() =>
        assertDefaultTodoPickupReady({ ...card }, true),
      );
      const waiver = warnings.find((w) => w.includes("--force"));
      expect(waiver, why).toBeDefined();
      expect(waiver, why).toContain(expected);
      expect(waiver, why).toContain("overridden, not satisfied");
    }
  });

  test("the forced path does not touch branch/pr_url", async () => {
    // The reason this gate stayed silent for two runs. `sanitizeDefaultTodoLaneMetadata`
    // CLEARS these fields, so running it to describe a waiver would change what
    // the forced write persists — and the forced write is the one nobody is
    // checking. Reporting that edits the record is not reporting.
    const card = todoCard({ kind: "tracker", branch: "feat/keep-me", pr_url: "https://x/1" });
    await captureWarnings(() => assertDefaultTodoPickupReady(card, true));
    expect(card.branch).toBe("feat/keep-me");
    expect(card.pr_url).toBe("https://x/1");
  });

  test("a body-free projection says the check did not run, not that the card is empty", async () => {
    // The other reason. `assertBodyLoaded` throwing is an INSTRUMENT failure,
    // and "empty or annotation-only body" about a body nobody fetched is the
    // lying-instrument mode this project keeps getting bitten by.
    const card = todoCard({ body: "" });
    card[BODY_OMITTED] = true;

    const { warnings } = await captureWarnings(() => assertDefaultTodoPickupReady(card, true));
    const waiver = warnings.find((w) => w.includes("--force"));
    expect(waiver).toBeDefined();
    expect(waiver).toContain("body-free projection");
    expect(waiver).not.toContain("annotation-only");

    // Unforced, the same card still gets the loud hydrate-first refusal — the
    // waiver work must not have downgraded a precondition into a shrug.
    expect(() => assertDefaultTodoPickupReady(card, false)).toThrow();
  });

  test("nothing is said when --force did not actually waive this gate", async () => {
    const cases: Array<[string, Card]> = [
      ["card is pickup-ready", todoCard()],
      ["card is not on the default board", todoCard({ board: "other", kind: "tracker" })],
      ["card is not in todo", todoCard({ column: "backlog", kind: "tracker" })],
    ];
    for (const [why, card] of cases) {
      const { warnings } = await captureWarnings(() => assertDefaultTodoPickupReady(card, true));
      expect(warnings.filter((w) => w.includes("--force")), why).toEqual([]);
    }
  });

  test("the unforced gate still sanitizes, and still refuses", async () => {
    // Defense-in-depth for a caller that forgot to sanitize lives on the
    // ENFORCING path now. Pinned so the split above cannot quietly drop it.
    const card = todoCard({ branch: "feat/x", pr_url: "https://x/1" });
    assertDefaultTodoPickupReady(card, false);
    expect(card.branch).toBe("");
    expect(card.pr_url).toBe("");
    expect(() => assertDefaultTodoPickupReady(todoCard({ kind: "tracker" }), false)).toThrow();
  });
});

// ---------------------------------------------------------------------------

describe("--force waives the work-brief and body-replace guards out loud", () => {
  test("an empty Kind:pr shell forced into the pickup lane says so", async () => {
    expect(() =>
      assertPrWorkBrief("shell", "pr", "", false, { board: "default", column: "todo" }),
    ).toThrow();

    const { warnings } = await captureWarnings(() =>
      assertPrWorkBrief("shell", "pr", "", true, { board: "default", column: "todo" }),
    );
    const waiver = warnings.find((w) => w.includes("--force"));
    expect(waiver).toBeDefined();
    expect(waiver).toContain("shell");
    expect(waiver).toContain("work-brief");
    expect(waiver).toContain("overridden, not satisfied");
  });

  test("a forced brief-destroying body replace names the brief it let go", async () => {
    // "Intentional audited shrink" and "clobber I did not notice" reach this
    // line as the same keystroke. The warning is the only thing that tells
    // them apart afterwards.
    const full = READY_BODY + "\n".repeat(3) + "lots of real brief text here to exceed the floor.";
    expect(() => assertBodyReplaceSafe("wipe-me", full, "HANDOFF: reaped", false)).toThrow();

    const { warnings } = await captureWarnings(() =>
      assertBodyReplaceSafe("wipe-me", full, "HANDOFF: reaped", true),
    );
    const waiver = warnings.find((w) => w.includes("--force"));
    expect(waiver).toBeDefined();
    expect(waiver).toContain("wipe-me");
    expect(waiver).toContain("body-replace");
  });

  test("an ordinary append under --force is silent", async () => {
    const full = READY_BODY + "lots of real brief text here to exceed the floor.";
    const { warnings } = await captureWarnings(() =>
      assertBodyReplaceSafe("keep-me", full, full + "\nHANDOFF: ok", true),
    );
    expect(warnings.filter((w) => w.includes("--force"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("--force waives the source-code body tripwire out loud", () => {
  const cfg: Config = {
    configVersion: 1,
    nodeUrl: "http://unused.invalid",
    schemaServiceUrl: "http://unused.invalid",
    userHash: "test-user",
    schemaHashes: { card: "cardhash", board: "boardhash" },
  };

  const SCRIPT_BODY = [
    "import json, subprocess, sys",
    "from collections import defaultdict",
    "",
    "def run(*args):",
    "    return subprocess.check_output(args, text=True)",
    "",
  ].join("\n");

  let node: NodeClient;

  beforeEach(async () => {
    node = fakeNode();
    const now = nowIso();
    await node.createRecord({
      schemaHash: cfg.schemaHashes.board!,
      keyHash: "default",
      fields: boardToFields({
        slug: "default",
        title: "default",
        body: "",
        columns: [...DEFAULT_COLUMNS],
        created_at: now,
        updated_at: now,
      }),
    });
  });

  test("a forced source-code body says so instead of landing in silence", async () => {
    // Prove the fixture is a REAL violation before believing the warning means
    // anything — the half whose absence lets a gate that never fires pass green.
    await expect(
      addCmd({ cfg, node, slug: "script-card", title: "Script", column: "backlog", body: SCRIPT_BODY }),
    ).rejects.toMatchObject({ code: "body_source_tripwire" });

    const { warnings } = await captureWarnings(() =>
      addCmd({
        cfg,
        node,
        slug: "script-card",
        title: "Script",
        column: "backlog",
        body: SCRIPT_BODY,
        force: true,
      }),
    );

    const waiver = warnings.find((w) => w.includes("--force"));
    expect(waiver).toBeDefined();
    expect(waiver).toContain("script-card");
    expect(waiver).toContain("source-code body");
    expect(waiver).toContain("overridden, not satisfied");
  });

  test("the forced and unforced readings are the same verdict", async () => {
    let refusal: FkanbanError | null = null;
    try {
      await addCmd({ cfg, node, slug: "s2", title: "S", column: "backlog", body: SCRIPT_BODY });
    } catch (err) {
      refusal = err as FkanbanError;
    }
    expect(refusal).not.toBeNull();

    const { warnings } = await captureWarnings(() =>
      addCmd({ cfg, node, slug: "s2", title: "S", column: "backlog", body: SCRIPT_BODY, force: true }),
    );
    expect(warnings.find((w) => w.includes("--force"))).toContain(refusal!.message);
  });

  test("an ordinary brief under --force is silent", async () => {
    // Noise on every forced write is how a warning stops being read.
    const brief = "Repo: EdgeVector/fkanban\nBase: main\n\n## GOAL\nReal work.\n\n## END STATE\nDone.";
    const { warnings } = await captureWarnings(() =>
      addCmd({ cfg, node, slug: "ok-card", title: "OK", column: "backlog", body: brief, force: true }),
    );
    expect(warnings.filter((w) => w.includes("source-code body"))).toEqual([]);
  });

  test("the forced write still lands the body it was asked to land", async () => {
    // The waiver reports; it must not have quietly become a refusal.
    await captureWarnings(() =>
      addCmd({ cfg, node, slug: "s3", title: "S", column: "backlog", body: SCRIPT_BODY, force: true }),
    );
    expect((await findCard(node, cfg, "s3"))?.body).toBe(SCRIPT_BODY);
  });
});

// ---------------------------------------------------------------------------

describe("every --force-waived guard announces itself", () => {
  // This is what makes `FORCE_IS_UNSCOPED` a promise rather than a hope. The
  // hint now tells operators that each guard the flag clears prints its own
  // warning; a guard added later that returns silently would make that sentence
  // a lie in exactly the direction the sentence exists to prevent.
  //
  // A behavioural sweep cannot see a guard that does not exist yet, so this
  // reads the source for the SHAPE: an unconditional bail on the flag, with no
  // console.error between the test and the return. A voiced waiver runs its
  // verdict through `captureFkanbanError` and prints instead.
  // A bail on the flag, with or without other disjuncts in the same condition.
  // The `(?:\s*\|\|[^)]*)?` arm is not hypothetical tidiness: the SEVENTH gate,
  // `assertBodyIsNotSourceCode`, hid behind `if (opts.force || opts.body ===
  // undefined) return;` and the original pattern — which required the flag to be
  // the WHOLE condition — read straight past it for a full day while this file
  // reported that every waiver spoke.
  const SILENT_BAIL = /if\s*\(\s*(?:opts\.)?force\s*(?:\|\|[^)]*)?\)\s*return\s*;/g;
  // Every file that holds a gate `--force` clears. `src/commands/add.ts` was the
  // other half of the same miss: the scan can only be as complete as this list,
  // so a gate written into an unlisted file is invisible no matter how good the
  // pattern is. Adding a force-clearable gate elsewhere means adding it here.
  const GATE_FILES = ["src/record.ts", "src/pipeline_status.ts", "src/commands/add.ts"];

  test("the pattern this test hunts for can actually match", () => {
    // Guard against the guard: a regex that matches nothing would let this
    // whole file pass while the invariant rotted. Four of the seven gates below
    // shipped in exactly this shape before 2026-08-04.
    expect("  if (force) return;\n".match(SILENT_BAIL)).toHaveLength(1);
    expect("  if (opts.force) return;\n".match(SILENT_BAIL)).toHaveLength(1);
    // The disjunct shape, verbatim as it shipped in add.ts.
    expect("  if (opts.force || opts.body === undefined) return;\n".match(SILENT_BAIL))
      .toHaveLength(1);
    // …and the pattern must still be specific enough to leave an unrelated
    // early return alone, or "no matches" would stop meaning anything.
    expect("  if (opts.body === undefined) return;\n".match(SILENT_BAIL)).toBeNull();
  });

  test("every file that reads the flag is either scanned or a declared non-gate", () => {
    // The pattern being right is worthless if the file list is short — the
    // seventh gate was missed on BOTH counts at once, and a correct pattern over
    // two files would still have reported all-clear. So the file list itself has
    // to be checked: any source file that reads `force` as a VALUE must be
    // scanned above or be named here with a reason.
    const NON_GATE_FILES = new Map([
      ["src/cli.ts", "argv parsing and help text; forwards the flag, decides nothing"],
      ["src/client.ts", "session-token refresh — an unrelated `force` parameter"],
      ["src/mcp/server.ts", "option plumbing: copies `force` into command opts"],
      ["src/commands/move.ts", "passes the flag to gates in record.ts/pipeline_status.ts; holds none"],
      ["src/commands/board.ts", "`board rm --force`, a different flag with its own delete semantics"],
      // Metadata-only path: forwards force into addCmd; owns no silent bail of its own.
      ["src/commands/set.ts", "forwards force to addCmd; holds no gate"],
      // English "force an unclaimed" in an error string — not a --force gate.
      ["src/doing-claim.ts", "claim-into-doing planner; mentions force only in prose"],
    ]);

    // Comments are stripped first: `doctor.ts`, `milestone.ts` and `search.ts`
    // contain "in force" / "does not force" in ENGLISH, and an allowlist padded
    // with files that merely use the word is one nobody can audit.
    const stripComments = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

    const files = readdirSync(new URL("../src", import.meta.url), { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => `src/${f}`)
      .sort();
    const readsForce = files.filter((f) =>
      /(^|[^\w.])force\b|\.force\b/.test(
        stripComments(readFileSync(new URL(`../${f}`, import.meta.url), "utf8")),
      ),
    );

    // Both halves must be non-empty, or the difference below is vacuously clean.
    expect(files.length).toBeGreaterThan(5);
    expect(readsForce).toContain("src/commands/add.ts");

    const unaccounted = readsForce.filter(
      (f) => !GATE_FILES.includes(f) && !NON_GATE_FILES.has(f),
    );
    expect(unaccounted).toEqual([]);
  });

  test("no gate bails on --force in silence", () => {
    for (const file of GATE_FILES) {
      const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      expect(src.match(SILENT_BAIL) ?? [], file).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------

describe("which guards --force actually clears is a fact, not a claim in prose", () => {
  // Five separate passages across `src/` and `test/` enumerate the gates
  // `--force` waives. On 2026-08-04 three of them named the Situations
  // preflight, which has never taken a `force` parameter at all — the
  // enumeration had been copied between files often enough that no copy was
  // checkable against the code.
  //
  // A gate is force-clearable iff its BODY reads the flag — deliberately not
  // "iff its signature declares it". Writing the signature version first got
  // this wrong in the same direction as the prose: `assertBodyIsNotSourceCode`
  // takes `opts: AddOptions` and reaches the flag through `opts.force`, so a
  // signature scan called the seventh gate un-forceable. What makes a gate
  // waivable is that it BRANCHES on the flag, and that is what to read.
  const FORCE_CLEARABLE = [
    "assertPrWorkBrief",
    "assertLivePrMilestone",
    "assertBodyReplaceSafe",
    "assertDefaultTodoPickupReady",
    "assertDepUnblocked",
    "assertLifecycleMoveAllowed",
    "assertBodyIsNotSourceCode",
  ];
  // Named because they are the ones prose has actually gotten wrong. Both sit
  // directly beside force-clearing gates on the same write paths.
  const NOT_FORCE_CLEARABLE = ["assertSituationPreflightAllowed", "assertNoExplicitTodoLaneMetadata"];

  const GATE_SOURCES = [
    "src/record.ts",
    "src/pipeline_status.ts",
    "src/situations.ts",
    "src/commands/add.ts",
  ];

  /**
   * `force` read as an IDENTIFIER — bare, or as `.force`.
   *
   * The leading `-` exclusion is load-bearing rather than cosmetic. Gate hints
   * discuss the CLI flag in prose, and `assertNoExplicitTodoLaneMetadata`'s hint
   * says "--force cannot preserve branch/pr_url either" — a sentence that is
   * TRUE precisely because that gate does not read the flag. Counting it as a
   * read would have made this check assert the opposite of the fact it exists
   * to pin.
   */
  const READS_FORCE = /(^|[^\w.\-])force\b|\.force\b/;

  /**
   * True when `name`'s declaration-through-body reads the flag.
   *
   * The body runs from the declaration to the next line-start `}`, which is
   * exactly the shape of a top-level function in these four files. Signature and
   * body are read together on purpose: `force?: boolean` in the parameter list
   * and `opts.force` in the body are the same fact.
   */
  function readsForce(name: string): boolean {
    for (const file of GATE_SOURCES) {
      const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      const start = new RegExp(`^(?:export )?(?:async )?function ${name}\\b`, "m").exec(src);
      if (!start) continue;
      const rest = src.slice(start.index);
      const end = rest.indexOf("\n}");
      expect(end, `${name}: could not find the end of the function body`).toBeGreaterThan(0);
      return READS_FORCE.test(rest.slice(0, end));
    }
    throw new Error(`${name} was not found in any scanned file — the check cannot read failure`);
  }

  test("the extractor can tell the two apart", () => {
    // Without this, an extractor that returned `false` for everything would
    // pass the NOT_FORCE_CLEARABLE block and fail nothing that mattered — and
    // one that returned `true` for everything would pass FORCE_CLEARABLE.
    expect(readsForce("assertDepUnblocked")).toBe(true);
    expect(readsForce("assertSituationPreflightAllowed")).toBe(false);
    // The opts-object style specifically, since the first version of this
    // extractor read only parameter lists and missed exactly this one.
    expect(readsForce("assertBodyIsNotSourceCode")).toBe(true);
    // A gate that only MENTIONS the flag in a hint string is not a reader. The
    // second version of this extractor got this one wrong in the other
    // direction, which is why both poles are pinned here.
    expect(readsForce("assertNoExplicitTodoLaneMetadata")).toBe(false);
  });

  test("every gate the prose calls force-clearable really reads the flag", () => {
    for (const name of FORCE_CLEARABLE) {
      expect(readsForce(name), name).toBe(true);
    }
  });

  test("--force does NOT clear the Situations preflight", () => {
    // The exact false claim, pinned. It stood in three files because it was
    // plausible: the preflight is called from `move` and both `add` paths,
    // in between gates that DO take the flag.
    for (const name of NOT_FORCE_CLEARABLE) {
      expect(readsForce(name), name).toBe(false);
    }
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
