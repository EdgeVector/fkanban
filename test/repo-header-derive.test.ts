// `fkanban-pickup` only fans a card out to a build agent when its body has both
// a `Repo:` and a `Base:` header, and the fkanban-agent skill is told never to
// guess the repo — so a card filed without them silently strands in `todo`.
// `add`/`move` close that hole deterministically via `applyHeaderDerivation`:
// auto-stamp the header when tags map to exactly one repo, never stamp a
// recipe/registry card, and WARN (not silently skip) when it's ambiguous. These
// unit-test the pure decision core — the one durable chokepoint every filer
// (CLI, MCP, routine, human) passes through.

import { describe, expect, test } from "bun:test";
import {
  applyHeaderDerivation,
  deriveRepoHeaders,
  hasRepoHeaders,
  inferRepoFromTags,
  isRegistryCard,
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

  test("ambiguous/unknown tags are not guessed", () => {
    expect(deriveRepoHeaders("body", ["fold", "exemem"], "t").kind).toBe("ambiguous");
    expect(deriveRepoHeaders("body", ["bug"], "t").kind).toBe("ambiguous");
  });
});

describe("applyHeaderDerivation", () => {
  function collectWarn() {
    const warnings: string[] = [];
    return { warn: (m: string) => warnings.push(m), warnings };
  }

  test("stamps a todo card and does not warn", () => {
    const { warn, warnings } = collectWarn();
    const body = applyHeaderDerivation(
      { slug: "c", body: "do it", tags: ["fold"], title: "t", column: "todo" },
      warn,
    );
    expect(body.startsWith("Repo: EdgeVector/fold\nBase: main\n\n")).toBe(true);
    expect(warnings).toHaveLength(0);
  });

  test("warns (and leaves body) for an ambiguous card placed in todo", () => {
    const { warn, warnings } = collectWarn();
    const body = applyHeaderDerivation(
      { slug: "c", body: "do it", tags: ["fold", "exemem"], title: "t", column: "todo" },
      warn,
    );
    expect(body).toBe("do it");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("fkanban-pickup will skip it");
  });

  test("does NOT warn for an ambiguous card in backlog (not yet eligible)", () => {
    const { warn, warnings } = collectWarn();
    applyHeaderDerivation({ slug: "c", body: "x", tags: ["bug"], title: "t", column: "backlog" }, warn);
    expect(warnings).toHaveLength(0);
  });

  test("does NOT warn for a registry card in todo (intentionally header-less)", () => {
    const { warn, warnings } = collectWarn();
    const body = applyHeaderDerivation(
      { slug: "c", body: "Target: fbrain record dogfood-registry", tags: ["dogfood"], title: "fix dogfood recipe: x", column: "todo" },
      warn,
    );
    expect(body).toBe("Target: fbrain record dogfood-registry");
    expect(warnings).toHaveLength(0);
  });

  test("leaves working-column cards (doing/review/done) untouched", () => {
    const { warn, warnings } = collectWarn();
    const body = applyHeaderDerivation({ slug: "c", body: "x", tags: ["fold"], title: "t", column: "doing" }, warn);
    expect(body).toBe("x");
    expect(warnings).toHaveLength(0);
  });
});
