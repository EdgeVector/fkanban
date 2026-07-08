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
  applyPickupAreaDerivation,
  depsPathConnects,
  findPickupAreaOverlap,
  isMetaCardKind,
  isPickupEligible,
  pickupAreaTagsForCard,
  normalizeBlockStatus,
  normalizeKind,
  parseBodyHeader,
  PICKUP_AREA_BLOCK_PREFIX,
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
    expect(normalizeKind("umbrella")).toBe("umbrella");
    expect(normalizeKind("meta")).toBe("meta");
    expect(normalizeKind("")).toBe("pr");
    expect(normalizeKind("bogus")).toBe("pr");
  });

  test("meta/grouping kinds are explicit non-work card kinds", () => {
    expect(isMetaCardKind("registry")).toBe(true);
    expect(isMetaCardKind("tracker")).toBe(true);
    expect(isMetaCardKind("umbrella")).toBe(true);
    expect(isMetaCardKind("meta")).toBe(true);
    expect(isMetaCardKind("program")).toBe(true);
    expect(isMetaCardKind("capstone")).toBe(true);
    expect(isMetaCardKind("validation")).toBe(true);
    expect(isMetaCardKind("pr")).toBe(false);
    expect(isMetaCardKind("bogus")).toBe(false);
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

  test("tracker/umbrella/meta cards are never pickup-eligible", () => {
    for (const kind of ["tracker", "umbrella", "meta", "program", "capstone", "validation"]) {
      expect(isPickupEligible(card({ kind, repo: "EdgeVector/fold", base: "main" }))).toBe(false);
    }
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

describe("pickup area overlap", () => {
  test("normalizes CLI and MCP spellings into the same area tag", () => {
    const areas = pickupAreaTagsForCard(
      card({
        title: "Add list paging",
        body: "Touches `fbrain list --offset` and the `fbrain_list` MCP tool.\nPickup Area: fbrain-list",
      }),
    );
    expect(areas).toEqual(["area:fbrain-list"]);
  });

  test("does not derive an area from prose that merely follows the word fbrain/fkanban", () => {
    expect(
      pickupAreaTagsForCard(
        card({ title: "Fix index lag", body: "fbrain got indexed tag queries wrong last night." }),
      ),
    ).toEqual([]);
    expect(
      pickupAreaTagsForCard(
        card({ title: "Green the suite", body: "Confirmed `bun test` in fkanban passes now." }),
      ),
    ).toEqual([]);
  });

  test("does not derive area:fkanban-agent from the mandatory fkanban-agent skill boilerplate", () => {
    const areas = pickupAreaTagsForCard(
      card({
        title: "Some card",
        body:
          "**Follow the fkanban-agent skill — drive this through to a MERGED PR.\n" +
          "A card is only `done` when its code is actually in the repo.**\n\nRepo: EdgeVector/fold\nBase: main\n\nGOAL: ship the thing.",
      }),
    );
    expect(areas).toEqual([]);
  });

  test("still derives areas from real command mentions", () => {
    expect(
      pickupAreaTagsForCard(card({ title: "x", body: "Run `fkanban list --column todo` to check." })),
    ).toEqual(["area:fkanban-list"]);
    expect(
      pickupAreaTagsForCard(card({ title: "x", body: "Call `fbrain ask` with the right query." })),
    ).toEqual(["area:fbrain-ask"]);
  });

  test("explicit Area: line is authoritative — skips prose scraping entirely", () => {
    const areas = pickupAreaTagsForCard(
      card({
        title: "x",
        body:
          "Follow the fkanban-agent skill. Run `fkanban list` and `fbrain ask`.\nArea: fkanban-cards",
      }),
    );
    expect(areas).toEqual(["area:fkanban-cards"]);
  });

  test("prose sentence beginning with 'Area:' is NOT an explicit declaration", () => {
    // Regression (fkanban-explicit-area-line-scrapes-prose): a wrapped CONTEXT
    // bullet fragment that merely begins with "Area:" must not be scraped into
    // bogus `area:*` tags — nor should the fenced command example that follows.
    const areas = pickupAreaTagsForCard(
      card({
        title: "x",
        body:
          "## CONTEXT\n\n" +
          "The migration ITSELF ends up mis-tagged because its body contains the\n" +
          "  Area: lines short-circuit prose scraping).\n" +
          "(a wrapped sentence fragment) plus a fenced example:\n\n" +
          "```\n" +
          "fkanban tag rm <slug> area:<bogus-tag>\n" +
          "```\n",
      }),
    );
    expect(areas).not.toContain("area:lines");
    expect(areas).not.toContain("area:short-circuit");
    expect(areas).not.toContain("area:prose");
    expect(areas).not.toContain("area:scraping");
    expect(areas).not.toContain("area:the");
    expect(areas).not.toContain("area:bogus-tag");
    // The fenced `fkanban tag` example must not mint a command area either.
    expect(areas).not.toContain("area:fkanban-tag");
    expect(areas).toEqual([]);
  });

  test("exact Area: prose sentence from the stale-card repro is ignored", () => {
    const areas = pickupAreaTagsForCard(
      card({
        title: "x",
        body:
          "Area: lines short-circuit prose scraping\n" +
          "area:<bogus-tag>` clears the stale tags correctly under the fixed logic.",
      }),
    );
    expect(areas).toEqual([]);
  });

  test("still honors a genuine short-slug Area: declaration despite nearby prose", () => {
    const areas = pickupAreaTagsForCard(
      card({
        title: "x",
        body:
          "Area: lines short-circuit prose scraping (this is prose, ignored).\n" +
          "Pickup Area: fkanban-cards, fbrain-list\n",
      }),
    );
    expect(areas).toEqual(["area:fbrain-list", "area:fkanban-cards"]);
  });

  test("derives forge CI area from obvious feature wording and workflow paths", () => {
    expect(
      pickupAreaTagsForCard(
        card({
          title: "Require forge required checks",
          body: "Port the local forge CI gate in `.forgejo/workflows/ci.yml`.",
        }),
      ),
    ).toEqual(["area:forge-ci"]);
  });

  test("holds a todo PR card that overlaps an active card in the same repo", () => {
    const first = card({
      slug: "fbrain-list-updated-since-offset-count",
      title: "Add list paging",
      body: "Repo: EdgeVector/fbrain\nBase: main\n\nAdd `fbrain list --offset` and `fbrain_list` support.",
      repo: "EdgeVector/fbrain",
      base: "main",
      kind: "pr",
      column: "doing",
    });
    const second = card({
      slug: "fbrain-tag-secondary-index",
      title: "Add tag index",
      body: "Repo: EdgeVector/fbrain\nBase: main\n\nSpeed up tag filtering in `fbrain list --tag` and `fbrain_list`.",
      repo: "EdgeVector/fbrain",
      base: "main",
      kind: "pr",
      column: "todo",
    });

    applyPickupAreaDerivation(second, [first]);

    expect(second.tags).toContain("area:fbrain-list");
    expect(second.block_status).toBe("needs_human");
    expect(second.block_reason).toContain(PICKUP_AREA_BLOCK_PREFIX);
    expect(second.block_reason).toContain("fbrain-list-updated-since-offset-count");
  });

  test("holds same-repo forge CI cards even without explicit area tags", () => {
    const compileFix = card({
      slug: "fold-cloud-proxy-subscription-status-test-compile-break",
      title: "Fix subscription status compile break",
      body:
        "Repo: EdgeVector/fold\nBase: main\n\nFix `cargo test --workspace --all-targets` so the forge check can go green.",
      repo: "EdgeVector/fold",
      base: "main",
      kind: "pr",
      column: "doing",
    });
    const requiredCheck = card({
      slug: "fold-ci-on-forge-required-checks",
      title: "Require forge required checks",
      body: "Repo: EdgeVector/fold\nBase: main\n\nRequire `.forgejo/workflows/ci.yml` before merge.",
      repo: "EdgeVector/fold",
      base: "main",
      kind: "pr",
      column: "todo",
    });

    applyPickupAreaDerivation(requiredCheck, [compileFix]);

    expect(requiredCheck.tags).toContain("area:forge-ci");
    expect(requiredCheck.block_status).toBe("needs_human");
    expect(requiredCheck.block_reason).toContain("fold-cloud-proxy-subscription-status-test-compile-break");
  });

  test("does not treat the same area in a different repo as an overlap", () => {
    const first = card({
      slug: "fold-list",
      title: "List fold data",
      body: "Repo: EdgeVector/fold\nBase: main\n\nTouch `fbrain list` docs.",
      repo: "EdgeVector/fold",
      base: "main",
      kind: "pr",
      column: "doing",
    });
    const second = card({
      slug: "fbrain-list",
      title: "List fbrain data",
      body: "Repo: EdgeVector/fbrain\nBase: main\n\nTouch `fbrain list`.",
      repo: "EdgeVector/fbrain",
      base: "main",
      kind: "pr",
      column: "todo",
    });

    expect(findPickupAreaOverlap(second, [first])).toBeNull();
  });

  test("self-heals its own overlap hold but preserves unrelated human holds", () => {
    const first = card({
      slug: "active",
      title: "Active",
      body: "Repo: EdgeVector/fbrain\nBase: main\n\n`fbrain list`",
      repo: "EdgeVector/fbrain",
      base: "main",
      kind: "pr",
      column: "doing",
    });
    const held = card({
      slug: "held",
      title: "Held",
      body: "Repo: EdgeVector/fbrain\nBase: main\n\n`fbrain list`",
      repo: "EdgeVector/fbrain",
      base: "main",
      kind: "pr",
      block_status: "needs_human",
      block_reason: `${PICKUP_AREA_BLOCK_PREFIX} shares area:fbrain-list with active in doing; serialize or retag one card.`,
    });
    applyPickupAreaDerivation(held, [first]);
    expect(held.block_status).toBe("needs_human");

    held.body = "Repo: EdgeVector/fbrain\nBase: main\n\n`fbrain search`";
    applyPickupAreaDerivation(held, [first]);
    expect(held.block_status).toBe("none");
    expect(held.block_reason).toBe("");

    held.block_status = "needs_human";
    held.block_reason = "waiting on Tom";
    held.body = "Repo: EdgeVector/fbrain\nBase: main\n\n`fbrain list`";
    applyPickupAreaDerivation(held, [first]);
    expect(held.block_status).toBe("needs_human");
    expect(held.block_reason).toBe("waiting on Tom");
  });

  // Regression (fkanban-overlap-block-false-positive-dep-serialized): two cards
  // that cite the same fbrain slug but are connected by a dep edge must NOT get
  // the overlap block — the dep already serializes their pickup.
  test("dep-connected cards sharing an area do not trip the overlap block", () => {
    const a = card({
      slug: "delete-dev-node-a",
      title: "Step A",
      body: "Repo: EdgeVector/fbrain\nBase: main\n\nSee fbrain note. `fbrain list`",
      repo: "EdgeVector/fbrain",
      base: "main",
      kind: "pr",
      column: "todo",
    });
    const b = card({
      slug: "delete-dev-node-b",
      title: "Step B",
      body: "Repo: EdgeVector/fbrain\nBase: main\n\nSee fbrain note. `fbrain list`",
      repo: "EdgeVector/fbrain",
      base: "main",
      kind: "pr",
      column: "todo",
      deps: ["delete-dev-node-a"], // B directly deps on A
    });

    // sanity: they DO share a derived area, so absent the dep edge this would block.
    expect(pickupAreaTagsForCard(a)).toContain("area:fbrain-list");
    expect(pickupAreaTagsForCard(b)).toContain("area:fbrain-list");

    // Neither card gets the block, in either evaluation order.
    expect(findPickupAreaOverlap(b, [a, b])).toBeNull();
    expect(findPickupAreaOverlap(a, [a, b])).toBeNull();

    applyPickupAreaDerivation(b, [a, b]);
    expect(normalizeBlockStatus(b.block_status)).toBe("none");
    applyPickupAreaDerivation(a, [a, b]);
    expect(normalizeBlockStatus(a.block_status)).toBe("none");
  });

  test("transitive and reverse dep paths both suppress the overlap block", () => {
    const a = card({
      slug: "chain-a",
      title: "A",
      body: "Repo: EdgeVector/fbrain\nBase: main\n\n`fbrain list`",
      repo: "EdgeVector/fbrain",
      base: "main",
      kind: "pr",
      column: "doing",
    });
    const mid = card({
      slug: "chain-mid",
      title: "Mid",
      body: "Repo: EdgeVector/fbrain\nBase: main\n\nunrelated",
      repo: "EdgeVector/fbrain",
      base: "main",
      kind: "pr",
      column: "todo",
      deps: ["chain-a"],
    });
    const c = card({
      slug: "chain-c",
      title: "C",
      body: "Repo: EdgeVector/fbrain\nBase: main\n\n`fbrain list`",
      repo: "EdgeVector/fbrain",
      base: "main",
      kind: "pr",
      column: "todo",
      deps: ["chain-mid"], // C -> mid -> A : transitive path C..A
    });
    const all = [a, mid, c];

    // depsPathConnects is symmetric and transitive.
    expect(depsPathConnects(all, "chain-c", "chain-a")).toBe(true);
    expect(depsPathConnects(all, "chain-a", "chain-c")).toBe(true);

    // C shares area:fbrain-list with A but is transitively dep-connected -> no block.
    expect(findPickupAreaOverlap(c, all)).toBeNull();
  });

  test("dep-connected forge CI cards sharing an inferred area do not trip the overlap block", () => {
    const a = card({
      slug: "forge-ci-compile-fix",
      title: "Fix forge check compile break",
      body: "Repo: EdgeVector/fold\nBase: main\n\nFix tests before the local forge CI gate is required.",
      repo: "EdgeVector/fold",
      base: "main",
      kind: "pr",
      column: "doing",
    });
    const b = card({
      slug: "forge-ci-required-check",
      title: "Require forge required checks",
      body: "Repo: EdgeVector/fold\nBase: main\n\nRequire `.forgejo/workflows/ci.yml`.",
      repo: "EdgeVector/fold",
      base: "main",
      kind: "pr",
      column: "todo",
      deps: ["forge-ci-compile-fix"],
    });

    expect(pickupAreaTagsForCard(a)).toContain("area:forge-ci");
    expect(pickupAreaTagsForCard(b)).toContain("area:forge-ci");
    expect(findPickupAreaOverlap(b, [a, b])).toBeNull();
  });

  test("an explicit --block-status none is authoritative on the same write", () => {
    const active = card({
      slug: "active",
      title: "Active",
      body: "Repo: EdgeVector/fbrain\nBase: main\n\n`fbrain list`",
      repo: "EdgeVector/fbrain",
      base: "main",
      kind: "pr",
      column: "doing",
    });
    // A card the hook had blocked for overlap, that still cites the shared area.
    const held = card({
      slug: "held",
      title: "Held",
      body: "Repo: EdgeVector/fbrain\nBase: main\n\n`fbrain list`",
      repo: "EdgeVector/fbrain",
      base: "main",
      kind: "pr",
      column: "todo",
      block_status: "needs_human",
      block_reason: `${PICKUP_AREA_BLOCK_PREFIX} shares area:fbrain-list with active in doing; serialize or retag one card.`,
    });

    // Without the explicit flag the hook re-derives the block (proves the setup).
    const reblocked = { ...held, block_status: "none", block_reason: "" };
    applyPickupAreaDerivation(reblocked, [active]);
    expect(reblocked.block_status).toBe("needs_human");

    // Simulate `add held --block-status none`: caller clears the block, then the
    // hook runs with explicitBlockStatus=true and must leave it cleared.
    held.block_status = "none";
    held.block_reason = "";
    applyPickupAreaDerivation(held, [active], /* explicitBlockStatus */ true);
    expect(held.block_status).toBe("none");
    expect(held.block_reason).toBe("");
    // Tags are still derived even under an explicit block-status.
    expect(held.tags).toContain("area:fbrain-list");
  });

  test("depsPathConnects: unrelated cards are not connected", () => {
    const x = card({ slug: "x", deps: [] });
    const y = card({ slug: "y", deps: [] });
    expect(depsPathConnects([x, y], "x", "y")).toBe(false);
    // Self is never connected to itself.
    expect(depsPathConnects([x, y], "x", "x")).toBe(false);
    // A dangling dep (no live card) doesn't create a spurious connection.
    const z = card({ slug: "z", deps: ["ghost"] });
    expect(depsPathConnects([z], "z", "ghost")).toBe(true);
    expect(depsPathConnects([z], "z", "y")).toBe(false);
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
