// Structured card fields (fbrain design `fkanban-card-structured-fields`):
// promote the signals a fresh agent needs to decide "what do I pick up?" out of
// body prose into real schema fields. These unit-test the pure model layer —
// enum normalizers, the round-trip through cardToFields/rowToCard (incl. legacy
// cards with the fields absent), pickup-eligibility, and the body→field backfill.

import { afterAll, describe, expect, test } from "bun:test";
import {
  cardToFields,
  deriveStructuredFields,
  emptyStructuredFields,
  isPickupEligible,
  normalizeBlockStatus,
  normalizeKind,
  parseBodyHeader,
  resolvePickupRepo,
  rowToCard,
  type Card,
} from "../src/record.ts";
import { newNodeClient } from "../src/client.ts";
import { fieldsFor } from "../src/schemas.ts";

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

  test("strips a trailing inline comment before returning the value", () => {
    expect(parseBodyHeader("Repo: EdgeVector/fold  # defaulted — fix if wrong\nBase: main", "Repo")).toBe("EdgeVector/fold");
  });
});

describe("resolvePickupRepo", () => {
  test("prefers structured repo over an inline-commented body Repo header", () => {
    const resolved = resolvePickupRepo(
      card({
        repo: "EdgeVector/fold",
        body: "Repo: EdgeVector/fold  # defaulted — no subsystem tag mapped; correct the Repo: line if wrong\nBase: main\n\nx",
      }),
    );
    expect(resolved).toEqual({ ok: true, repo: "EdgeVector/fold", source: "structured" });
  });

  test("falls back to an inline-commented body Repo header when structured repo is empty", () => {
    const resolved = resolvePickupRepo(
      card({
        repo: "",
        body: "Repo: EdgeVector/fkanban  # stale note\nBase: main\n\nx",
      }),
    );
    expect(resolved).toEqual({ ok: true, repo: "EdgeVector/fkanban", source: "body" });
  });

  test("rejects an invalid repo after comment stripping", () => {
    const resolved = resolvePickupRepo(card({ repo: "", body: "Repo: EdgeVector/fold/extra  # bad\nBase: main" }));
    expect(resolved.ok).toBe(false);
  });
});

// fkanban #94: the new structured fields must round-trip through a real
// create→query against a node that has the full Card schema loaded — proving
// they're WRITABLE end-to-end, not just modeled. (A stub node stands in for the
// live node so this runs in CI; the resolver/write-probe guards in
// init-write-probe-guard + doctor-write-probe cover the not-writable case.)
describe("structured fields write+read-back against a node (real wire path)", () => {
  const store = new Map<string, Record<string, unknown>>();
  const FULL = "fullcardschemahash";
  const node = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const text = req.method === "POST" ? await req.text() : "";
      const body = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
      if (url.pathname === "/api/mutation") {
        const schema = body.schema as string;
        const keyHash = (body.key_value as { hash: string }).hash;
        if ((body.mutation_type as string) === "delete") store.delete(`${schema}::${keyHash}`);
        else store.set(`${schema}::${keyHash}`, body.fields_and_values as Record<string, unknown>);
        return Response.json({ ok: true, success: true });
      }
      if (url.pathname === "/api/query") {
        const schema = body.schema_name as string;
        const want = (body.filter as { HashKey?: string } | undefined)?.HashKey;
        const rows = [...store.entries()]
          .filter(([k]) => k.startsWith(`${schema}::`))
          .map(([k, f]) => ({ fields: f, key: { hash: k.split("::")[1]!, range: null } }))
          .filter((r) => want === undefined || r.key.hash === want);
        return Response.json({ ok: true, results: rows, has_more: false });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  });
  afterAll(() => node.stop(true));

  test("every new field persists a non-empty value and reads it back", async () => {
    const client = newNodeClient({ baseUrl: `http://127.0.0.1:${node.port}`, userHash: "u" });
    const c = card({
      slug: "wire-card",
      repo: "EdgeVector/fold",
      base: "dev",
      kind: "pr",
      block_status: "needs_human",
      block_reason: "waiting on Tom",
      north_star: "ns-x",
      pr_url: "https://github.com/EdgeVector/fold/pull/42",
      branch: "fkanban/wire-card",
    });
    await client.createRecord({ schemaHash: FULL, fields: cardToFields(c), keyHash: c.slug });
    const res = await client.queryAll({
      schemaHash: FULL,
      fields: fieldsFor("card"),
      filter: { HashKey: "wire-card" },
    });
    const back = rowToCard(res.results[0]!);
    expect(back.repo).toBe("EdgeVector/fold");
    expect(back.base).toBe("dev");
    expect(back.kind).toBe("pr");
    expect(back.block_status).toBe("needs_human");
    expect(back.block_reason).toBe("waiting on Tom");
    expect(back.north_star).toBe("ns-x");
    expect(back.pr_url).toBe("https://github.com/EdgeVector/fold/pull/42");
    expect(back.branch).toBe("fkanban/wire-card");
  });
});

describe("deriveStructuredFields (backfill)", () => {
  test("fills repo/base from body headers and kind=pr", () => {
    const c = card({ kind: "", repo: "", base: "", body: "Repo: EdgeVector/fold  # defaulted\nBase: dev\n\nx" });
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
