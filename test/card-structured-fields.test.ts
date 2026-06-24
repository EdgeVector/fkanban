// Structured card fields (fbrain design `fkanban-card-structured-fields`):
// promote the signals a fresh agent needs to decide "what do I pick up?" out of
// body prose into real schema fields. These unit-test the pure model layer —
// enum normalizers, the round-trip through cardToFields/rowToCard (incl. legacy
// cards with the fields absent), pickup-eligibility, and the body→field backfill.

import { describe, expect, test } from "bun:test";
import {
  cardToFields,
  deriveStructuredFields,
  emptyStructuredFields,
  isPickupEligible,
  normalizeBlockStatus,
  normalizeKind,
  parseBodyHeader,
  rowToCard,
  type Card,
} from "../src/record.ts";

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
    ...partial,
  };
}

describe("normalizers", () => {
  test("kind: known passes, empty/unknown → pr", () => {
    expect(normalizeKind("registry")).toBe("registry");
    expect(normalizeKind("tracker")).toBe("tracker");
    expect(normalizeKind("")).toBe("pr");
    expect(normalizeKind("bogus")).toBe("pr");
  });
  test("block_status: known passes, empty/unknown → none", () => {
    expect(normalizeBlockStatus("needs_human")).toBe("needs_human");
    expect(normalizeBlockStatus("")).toBe("none");
    expect(normalizeBlockStatus("weird")).toBe("none");
  });
});

describe("cardToFields ⇄ rowToCard round-trip", () => {
  test("structured fields survive a write/read cycle", () => {
    const c = card({
      repo: "EdgeVector/fold",
      base: "main",
      kind: "pr",
      block_status: "needs_human",
      block_reason: "waiting on Tom",
      north_star: "north-star-x",
      pr_url: "https://github.com/EdgeVector/fold/pull/1",
      branch: "fkanban/c",
    });
    const back = rowToCard({ fields: cardToFields(c), key: { hash: c.slug, range: null } });
    expect(back.repo).toBe("EdgeVector/fold");
    expect(back.base).toBe("main");
    expect(back.block_status).toBe("needs_human");
    expect(back.block_reason).toBe("waiting on Tom");
    expect(back.north_star).toBe("north-star-x");
    expect(back.pr_url).toBe("https://github.com/EdgeVector/fold/pull/1");
    expect(back.branch).toBe("fkanban/c");
  });

  test("a legacy card (fields absent on the wire) reads them as empty, not undefined", () => {
    const legacy = rowToCard({
      fields: { slug: "old", title: "old", body: "x", board: "default", column: "todo", position: "1", tags: [] },
      key: { hash: "old", range: null },
    });
    expect(legacy.repo).toBe("");
    expect(legacy.kind).toBe("");
    expect(legacy.block_status).toBe("");
    // normalizers make the empties safe to act on
    expect(normalizeKind(legacy.kind)).toBe("pr");
    expect(normalizeBlockStatus(legacy.block_status)).toBe("none");
  });
});

describe("isPickupEligible", () => {
  test("a pr card with repo+base+no block is eligible", () => {
    expect(isPickupEligible(card({ kind: "pr", repo: "EdgeVector/fold", base: "main" }))).toBe(true);
  });
  test("missing repo or base → not eligible", () => {
    expect(isPickupEligible(card({ kind: "pr", repo: "", base: "main" }))).toBe(false);
    expect(isPickupEligible(card({ kind: "pr", repo: "EdgeVector/fold", base: "" }))).toBe(false);
  });
  test("an intentional block → not eligible", () => {
    expect(
      isPickupEligible(card({ kind: "pr", repo: "EdgeVector/fold", base: "main", block_status: "needs_human" })),
    ).toBe(false);
  });
  test("a registry card is never eligible (explicit kind OR un-backfilled body)", () => {
    expect(isPickupEligible(card({ kind: "registry", repo: "EdgeVector/fold", base: "main" }))).toBe(false);
    // legacy registry card not yet backfilled (kind empty) — caught by the body fallback
    expect(
      isPickupEligible(card({ kind: "", repo: "EdgeVector/fold", base: "main", body: "Target: fbrain record `dogfood-registry`" })),
    ).toBe(false);
  });
});

describe("parseBodyHeader", () => {
  test("reads a line-anchored Name: value", () => {
    expect(parseBodyHeader("Repo: EdgeVector/fold\nBase: main\n\nbody", "Repo")).toBe("EdgeVector/fold");
    expect(parseBodyHeader("North Star: foo-bar\n", "North Star")).toBe("foo-bar");
    expect(parseBodyHeader("no header here", "Repo")).toBe("");
  });

  test("captures only the single-token value when headers run together on one line", () => {
    // Some bodies store the header block space-joined or with escaped newlines;
    // the value must NOT swallow the following headers (regression: a backfill
    // of existing cards over-captured "EdgeVector/fold   Base: main   Branch: …").
    expect(parseBodyHeader("Repo: EdgeVector/fold   Base: main   Branch: fkanban/x", "Repo")).toBe("EdgeVector/fold");
    expect(parseBodyHeader("Repo: EdgeVector/exemem-infra\\nBase: main", "Repo")).toBe("EdgeVector/exemem-infra");
    // A line-anchored Base: on its own line still parses normally.
    expect(parseBodyHeader("Repo: EdgeVector/fold\nBase: dev", "Base")).toBe("dev");
  });
});

describe("deriveStructuredFields (backfill)", () => {
  test("fills repo/base from body headers and kind=pr", () => {
    const c = card({ kind: "", repo: "", base: "", body: "Repo: EdgeVector/fold\nBase: dev\n\nx" });
    const d = deriveStructuredFields(c);
    expect(d.repo).toBe("EdgeVector/fold");
    expect(d.base).toBe("dev");
    expect(d.kind).toBe("pr");
  });

  test("falls back to the tag→repo map and defaults base to main", () => {
    const c = card({ kind: "", repo: "", base: "", tags: ["exemem"], body: "no headers" });
    const d = deriveStructuredFields(c);
    expect(d.repo).toBe("EdgeVector/exemem-infra");
    expect(d.base).toBe("main");
  });

  test("classifies a recipe/registry card as kind=registry (and gives it no repo)", () => {
    const c = card({ kind: "", repo: "", base: "", tags: ["dogfood", "fold"], title: "fix dogfood recipe: x", body: "Target: fbrain record" });
    const d = deriveStructuredFields(c);
    expect(d.kind).toBe("registry");
    // registry cards aren't code cards: repo/base are left untouched (the
    // partial omits them) even though a #fold tag is present.
    expect(d.repo).toBeUndefined();
    expect(d.base).toBeUndefined();
  });

  test("pulls north_star from the body line", () => {
    const c = card({ north_star: "", body: "North Star: at-rest-encryption-g1\n\nbody" });
    expect(deriveStructuredFields(c).north_star).toBe("at-rest-encryption-g1");
  });

  test("never overwrites an already-set field", () => {
    const c = card({ repo: "EdgeVector/already", base: "set", kind: "tracker", body: "Repo: EdgeVector/fold\nBase: main" });
    const d = deriveStructuredFields(c);
    expect(d.repo).toBeUndefined();
    expect(d.base).toBeUndefined();
    expect(d.kind).toBeUndefined();
  });
});
