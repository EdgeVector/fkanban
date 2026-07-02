// `fkanban-pickup` only fans a card out to a build agent when its body has both
// a `Repo:` and a `Base:` header, and the fkanban-agent skill is told never to
// guess the repo — so a card filed without them silently strands in `todo`.
// `add`/`move` close that hole deterministically via `applyHeaderDerivation`:
// auto-stamp the header when tags map to exactly one repo; leave no-signal cards
// headerless; flag a real cross-repo CONFLICT loudly (needs_human) instead of
// guessing; and never stamp a recipe/registry card.
// These unit-test the pure decision core — the one durable chokepoint every filer
// (CLI, MCP, routine, human) passes through.

import { describe, expect, test } from "bun:test";
import {
  applyDerivedHeader,
  applyHeaderDerivation,
  DEFAULT_REPO,
  deriveRepoHeaders,
  emptyStructuredFields,
  hasRepoHeaders,
  inferRepoFromTags,
  isRegistryCard,
  REPO_CONFLICT_BLOCK_PREFIX,
  type Card,
} from "../src/record.ts";

describe("hasRepoHeaders", () => {
  test("requires both headers, line-anchored", () => {
    expect(hasRepoHeaders("Repo: EdgeVector/fold\nBase: main\n\nbody")).toBe(true);
    expect(hasRepoHeaders("Base: main\n\nbody")).toBe(false);
    expect(hasRepoHeaders("Repo: EdgeVector/fold")).toBe(false);
    // A passing mention mid-prose must not count as a header.
    expect(hasRepoHeaders("see the Repo: link and Base: branch inline")).toBe(false);
  });
});

describe("inferRepoFromTags", () => {
  test("maps a single subsystem tag to its repo", () => {
    expect(inferRepoFromTags(["fold", "security"])).toBe("EdgeVector/fold");
    expect(inferRepoFromTags(["#exemem", "web"])).toBe("EdgeVector/exemem-infra");
    expect(inferRepoFromTags(["fkanban"])).toBe("EdgeVector/fkanban");
    expect(inferRepoFromTags(["schema-infra"])).toBe("EdgeVector/schema-infra");
  });

  test("returns null when tags map to >1 repo or to none", () => {
    // #fold + #exemem -> two repos -> ambiguous, never guess.
    expect(inferRepoFromTags(["fold", "exemem"])).toBeNull();
    expect(inferRepoFromTags(["bug", "papercut"])).toBeNull();
    expect(inferRepoFromTags([])).toBeNull();
  });

  test("two tags for the SAME repo still resolve (not ambiguous)", () => {
    expect(inferRepoFromTags(["fold", "fold_db_node", "wasm"])).toBe("EdgeVector/fold");
  });
});

describe("isRegistryCard", () => {
  test("detects fbrain-registry / recipe cards by body or title", () => {
    expect(isRegistryCard("Target: fbrain record `dogfood-registry`", "x")).toBe(true);
    expect(isRegistryCard("edits the dogfood-registry record", "x")).toBe(true);
    expect(isRegistryCard("body", "fix dogfood recipe: persona-crud")).toBe(true);
    expect(isRegistryCard("a normal fold bug", "Run WASM execute under spawn_blocking")).toBe(false);
  });
});

describe("deriveRepoHeaders", () => {
  test("stamps an unambiguous card and preserves the original body", () => {
    const r = deriveRepoHeaders("## GOAL\nfix it", ["fold", "security"], "Fix the thing");
    expect(r.kind).toBe("stamped");
    if (r.kind !== "stamped") throw new Error("unreachable");
    expect(r.repo).toBe("EdgeVector/fold");
    expect(r.base).toBe("main");
    expect(r.body).toBe("Repo: EdgeVector/fold\nBase: main\n\n## GOAL\nfix it");
    expect(hasRepoHeaders(r.body)).toBe(true);
  });

  test("is idempotent — an already-headed card is left alone", () => {
    expect(deriveRepoHeaders("Repo: EdgeVector/fold\nBase: main\n\nx", ["fold"], "t").kind).toBe("present");
  });

  test("never stamps a registry/recipe card even with a mappable tag", () => {
    expect(
      deriveRepoHeaders("Target: fbrain record `dogfood-registry`", ["dogfood", "fold"], "fix dogfood recipe: x").kind,
    ).toBe("skip-registry");
  });

  test("tags mapping to >1 repo are a conflict — never guessed", () => {
    const r = deriveRepoHeaders("body", ["fold", "exemem"], "t");
    expect(r.kind).toBe("conflict");
    if (r.kind !== "conflict") throw new Error("unreachable");
    expect(r.repos).toEqual(["EdgeVector/exemem-infra", "EdgeVector/fold"]); // sorted
  });

  test("an explicit forcedRepo overrides a tag conflict (the triage one-liner)", () => {
    const r = deriveRepoHeaders("## GOAL\nfix it", ["fold", "exemem"], "t", { forcedRepo: "EdgeVector/exemem-infra" });
    expect(r.kind).toBe("stamped");
    if (r.kind !== "stamped") throw new Error("unreachable");
    expect(r.repo).toBe("EdgeVector/exemem-infra");
    expect(r.body).toBe("Repo: EdgeVector/exemem-infra\nBase: main\n\n## GOAL\nfix it");
  });

  test("forcedRepo also wins over an unambiguous tag and over the default", () => {
    expect(deriveRepoHeaders("b", ["fold"], "t", { forcedRepo: "EdgeVector/schema-infra" })).toMatchObject({
      kind: "stamped",
      repo: "EdgeVector/schema-infra",
    });
    expect(deriveRepoHeaders("b", [], "t", { forcedRepo: "EdgeVector/fkanban" })).toMatchObject({
      kind: "stamped",
      repo: "EdgeVector/fkanban",
    });
  });

  test("forcedRepo still respects present (existing header) and registry guards", () => {
    expect(deriveRepoHeaders("Repo: EdgeVector/fold\nBase: main\n\nx", [], "t", { forcedRepo: "EdgeVector/x" }).kind).toBe("present");
    expect(
      deriveRepoHeaders("Target: fbrain record `dogfood-registry`", [], "fix dogfood recipe: x", { forcedRepo: "EdgeVector/x" }).kind,
    ).toBe("skip-registry");
  });

  test("a blank forcedRepo is ignored (falls through to tag/default logic)", () => {
    expect(deriveRepoHeaders("b", ["fold", "exemem"], "t", { forcedRepo: "   " }).kind).toBe("conflict");
  });

  test("no subsystem signal → ambiguous by default, not guessed", () => {
    const r = deriveRepoHeaders("## GOAL\nfix it", ["bug"], "t");
    expect(r.kind).toBe("ambiguous");
  });

  test("an explicit defaultRepo opt-in stamps without an inline Repo comment", () => {
    const r = deriveRepoHeaders("## GOAL\nfix it", ["bug"], "t", { defaultRepo: DEFAULT_REPO });
    if (r.kind !== "defaulted") throw new Error("unreachable");
    expect(r.repo).toBe(DEFAULT_REPO);
    expect(r.base).toBe("main");
    expect(r.body).toBe(`Repo: ${DEFAULT_REPO}\nBase: main\n# defaulted — no subsystem tag mapped; correct the Repo: line if wrong\n\n## GOAL\nfix it`);
    expect(hasRepoHeaders(r.body)).toBe(true);
  });

  test("empty tag set is also ambiguous by default", () => {
    expect(deriveRepoHeaders("body", [], "t").kind).toBe("ambiguous");
  });

  test("defaultRepo: '' keeps the no-signal result ambiguous", () => {
    expect(deriveRepoHeaders("body", ["bug"], "t", { defaultRepo: "" }).kind).toBe("ambiguous");
    // A conflict stays a conflict even with defaulting off — never guessed.
    expect(deriveRepoHeaders("body", ["fold", "exemem"], "t", { defaultRepo: "" }).kind).toBe("conflict");
  });
});

describe("applyHeaderDerivation", () => {
  function collectWarn() {
    const warnings: string[] = [];
    return { warn: (m: string) => warnings.push(m), warnings };
  }

  test("stamps a todo card and does not warn", () => {
    const { warn, warnings } = collectWarn();
    const r = applyHeaderDerivation(
      { slug: "c", body: "do it", tags: ["fold"], title: "t", column: "todo" },
      warn,
    );
    expect(r.body.startsWith("Repo: EdgeVector/fold\nBase: main\n\n")).toBe(true);
    expect(r.blockStatus).toBeUndefined();
    expect(warnings).toHaveLength(0);
  });

  test("leaves a no-signal todo card headerless and warns", () => {
    const { warn, warnings } = collectWarn();
    const r = applyHeaderDerivation(
      { slug: "c", body: "do it", tags: ["bug"], title: "t", column: "todo" },
      warn,
    );
    expect(r.body).toBe("do it");
    expect(r.blockStatus).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("fkanban-pickup will skip it");
  });

  test("flags a cross-repo conflict in todo as needs_human (loud, not skipped)", () => {
    const { warn, warnings } = collectWarn();
    const r = applyHeaderDerivation(
      { slug: "c", body: "do it", tags: ["fold", "exemem"], title: "t", column: "todo" },
      warn,
    );
    expect(r.body).toBe("do it"); // not guessed
    expect(r.blockStatus).toBe("needs_human");
    expect(r.blockReason).toContain(REPO_CONFLICT_BLOCK_PREFIX);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("refusing to guess");
  });

  test("does NOT warn/block a conflict in backlog (not yet eligible)", () => {
    const { warn, warnings } = collectWarn();
    const r = applyHeaderDerivation({ slug: "c", body: "x", tags: ["fold", "exemem"], title: "t", column: "backlog" }, warn);
    expect(r.blockStatus).toBeUndefined();
    expect(warnings).toHaveLength(0);
  });

  test("does NOT warn/stamp a registry card in todo (intentionally header-less)", () => {
    const { warn, warnings } = collectWarn();
    const r = applyHeaderDerivation(
      { slug: "c", body: "Target: fbrain record dogfood-registry", tags: ["dogfood"], title: "fix dogfood recipe: x", column: "todo" },
      warn,
    );
    expect(r.body).toBe("Target: fbrain record dogfood-registry");
    expect(r.blockStatus).toBeUndefined();
    expect(warnings).toHaveLength(0);
  });

  test("leaves working-column cards (doing/review/done) untouched", () => {
    const { warn, warnings } = collectWarn();
    const r = applyHeaderDerivation({ slug: "c", body: "x", tags: ["fold"], title: "t", column: "doing" }, warn);
    expect(r.body).toBe("x");
    expect(warnings).toHaveLength(0);
  });
});

describe("applyDerivedHeader", () => {
  const card = (over: Partial<Card>): Card => ({
    slug: "c", title: "t", body: "", board: "b", column: "todo", position: "1",
    assignee: "", tags: [], deps: [], created_at: "", updated_at: "",
    ...emptyStructuredFields(), ...over,
  });
  const warn = () => {};

  test("sets the auto needs_human hold for a conflict", () => {
    const c = card({ tags: ["fold", "exemem"] });
    applyDerivedHeader(c, applyHeaderDerivation({ ...c }, warn));
    expect(c.block_status).toBe("needs_human");
    expect(c.block_reason.startsWith(REPO_CONFLICT_BLOCK_PREFIX)).toBe(true);
  });

  test("does NOT clobber a human's intentional hold", () => {
    const c = card({ tags: ["fold", "exemem"], block_status: "design_first", block_reason: "spec first" });
    applyDerivedHeader(c, applyHeaderDerivation({ ...c }, warn));
    expect(c.block_status).toBe("design_first");
    expect(c.block_reason).toBe("spec first");
  });

  test("self-heals — clears its own hold once the repo resolves", () => {
    // Previously conflicted; now retagged to a single repo.
    const c = card({ tags: ["fold"], block_status: "needs_human", block_reason: `${REPO_CONFLICT_BLOCK_PREFIX} tags map to a + b.` });
    applyDerivedHeader(c, applyHeaderDerivation({ ...c }, warn));
    expect(c.block_status).toBe("none");
    expect(c.block_reason).toBe("");
    expect(hasRepoHeaders(c.body)).toBe(true);
  });

  test("leaves an unrelated needs_human hold alone when the repo resolves", () => {
    const c = card({ tags: ["fold"], block_status: "needs_human", block_reason: "waiting on legal" });
    applyDerivedHeader(c, applyHeaderDerivation({ ...c }, warn));
    expect(c.block_status).toBe("needs_human");
    expect(c.block_reason).toBe("waiting on legal");
  });

  test("triage resolution: forcedRepo on a held conflict card stamps the header AND clears the hold", () => {
    // The exact state the watcher acts on: a conflict card auto-held needs_human,
    // resolved by `add <slug> --repo EdgeVector/exemem-infra` (forcedRepo).
    const c = card({
      tags: ["fold", "exemem"],
      block_status: "needs_human",
      block_reason: `${REPO_CONFLICT_BLOCK_PREFIX} tags map to EdgeVector/exemem-infra + EdgeVector/fold.`,
    });
    applyDerivedHeader(c, applyHeaderDerivation({ ...c }, warn, { forcedRepo: "EdgeVector/exemem-infra" }));
    expect(c.body.startsWith("Repo: EdgeVector/exemem-infra\nBase: main\n\n")).toBe(true);
    expect(c.block_status).toBe("none");
    expect(c.block_reason).toBe("");
  });
});
