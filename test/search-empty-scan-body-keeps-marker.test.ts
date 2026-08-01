// An empty scan body is not a read, and saying it was disarms the hydration
// that would have fixed it.
//
// Sibling of `scan-ghost-row-false-empty-body.test.ts`, which pinned the SWEEP
// consumer of the Card body scan to *a scan may SUPPLY a body, it may never DENY
// one*. `indexedSearchCards` is the other consumer of that same
// `listCardBodies` scan and did the opposite:
//
//     const whole = body === undefined ? card : withLoadedBody(card, body);
//
// `withLoadedBody(card, "")` CLEARS `BODY_OMITTED`, which is the marker meaning
// "this body was never read". Downstream, `fkanban_search` hydrates its capped
// page (`hydrateCardBodies` over ≤20 cards) so every returned match carries a
// real body — and `hydrateCardBodies` deliberately refuses to re-read a body
// someone already claimed to have read:
//
//     if (!isBodyOmitted(c) || c.body.length > 0) return c;
//
// So a card the scan denied skipped the exact read that exists to fill it. The
// defence was in place and switched off by a claim made upstream.
//
// WHY THE FIX IS A MARKER AND NOT A HYDRATION. Measured on the live primary
// 2026-08-01 (`scripts/probe-search-empty-body-denial.ts`): of 335 board cards
// the scan supplies `body === ""` for 12, and a keyed read confirms all 12 are
// genuinely empty — 0 denied. The Card scan DOES still return 615 rows for 568
// distinct slugs (47 duplicated slugs, 33 with the empty row landing last), but
// `listCardBodies`'s keep-longest rule already resolves those. Hydrating the
// whole board here would cost 12 point reads / 257ms on a 1139ms read phase for
// zero recall. Keeping the marker costs this path nothing and moves the read to
// the page-bounded place that was already paying for it.

import { beforeEach, describe, expect, test } from "bun:test";

import { fakeNode, type FakeNode } from "./fake-node.ts";
import type { Config } from "../src/config.ts";
import {
  boardToFields,
  cardToFields,
  hydrateCardBodies,
  isBodyOmitted,
  nowIso,
  type Card,
} from "../src/record.ts";
import { boardCardFieldsFromCard, boardCardSk } from "../src/board-cards.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";
import { searchResult } from "../src/commands/search.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash", board_cards: "boardcardshash" },
};

const BRIEF = "## GOAL\nA real brief the scan supplies in full.\n\n## END STATE\nMarker cleared.";

function card(over: Partial<Card> & { slug: string }): Card {
  const now = nowIso();
  return {
    slug: over.slug,
    title: over.title ?? over.slug,
    body: over.body ?? BRIEF,
    board: "default",
    column: "todo",
    position: over.position ?? "m",
    assignee: "",
    tags: [],
    deps: [],
    surfaces: [],
    created_at: now,
    updated_at: now,
    done_at: "",
    db: "",
    kind: "pr",
    priority: "",
    block_status: "none",
    block_reason: "",
    north_star: "",
    milestone: "",
    repo: "EdgeVector/fkanban",
    base: "main",
    pr_url: "",
    branch: "",
    created_by: "test",
  } as Card;
}

function seedBoard(node: FakeNode): void {
  const now = nowIso();
  node.seed({
    schemaHash: "boardhash",
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
}

function seedCard(node: FakeNode, c: Card): void {
  node.seed({ schemaHash: "cardhash", keyHash: c.slug, fields: cardToFields(c) });
  node.seed({
    schemaHash: "boardcardshash",
    keyHash: c.board,
    rangeKey: boardCardSk(c.column, c.position, c.slug),
    fields: boardCardFieldsFromCard(c),
  });
}

describe("an empty scan body must not claim the body was read", () => {
  let node: FakeNode;
  const empty = card({ slug: "empty-brief-card", body: "", position: "m" });
  const briefed = card({ slug: "briefed-card", position: "n" });

  beforeEach(() => {
    node = fakeNode();
    seedBoard(node);
    seedCard(node, empty);
    seedCard(node, briefed);
  });

  // NON-VACUITY. If the scan never supplies `""` for this card the assertions
  // below are about nothing. Pin the fixture's premise explicitly.
  test("the fixture reproduces the input: the scan supplies an empty body", async () => {
    const scan = await node.queryAll({
      schemaHash: "cardhash",
      fields: ["slug", "body"],
      allowFullScan: true,
    });
    const row = scan.results.find((r) => (r.fields as Record<string, unknown>).slug === empty.slug);
    expect(row).toBeDefined();
    expect((row!.fields as Record<string, unknown>).body).toBe("");
  });

  test("a card the scan gave no body keeps BODY_OMITTED", async () => {
    const res = await searchResult({ cfg, node, query: empty.slug });
    const match = res.cards.find((c) => c.slug === empty.slug);
    expect(match).toBeDefined();
    // The claim: search did not read this body, and no longer says it did.
    expect(isBodyOmitted(match!)).toBe(true);
  });

  test("a card the scan DID supply is marked read — the marker is not blanket", async () => {
    const res = await searchResult({ cfg, node, query: briefed.slug });
    const match = res.cards.find((c) => c.slug === briefed.slug);
    expect(match).toBeDefined();
    expect(isBodyOmitted(match!)).toBe(false);
    expect(match!.body).toBe(BRIEF);
  });

  // THE POINT OF THE FIX. `fkanban_search` runs exactly this over its capped
  // page. Before, the cleared marker made it a no-op for the denied card.
  test("the page hydration downstream is re-armed: it now issues the keyed read", async () => {
    const res = await searchResult({ cfg, node, query: empty.slug });
    const before = node.reads.length;
    await hydrateCardBodies(node, cfg, res.cards);
    const keyed = node.reads
      .slice(before)
      .filter((r) => r.schemaHash === "cardhash" && typeof r.filter?.HashKey === "string")
      .map((r) => r.filter!.HashKey as string);
    expect(keyed).toContain(empty.slug);
  });

  test("hydration still skips cards whose body the scan supplied", async () => {
    const res = await searchResult({ cfg, node, query: briefed.slug });
    const before = node.reads.length;
    await hydrateCardBodies(node, cfg, res.cards);
    const keyed = node.reads
      .slice(before)
      .filter((r) => r.schemaHash === "cardhash" && typeof r.filter?.HashKey === "string");
    // Paying a point read to re-learn a body the scan already handed over is
    // the cost this whole path exists to avoid.
    expect(keyed).toHaveLength(0);
  });

  // COST BOUND. The fix must not turn the default search into whole-board
  // hydration — the reason it is a marker and not a read (see the header).
  test("search itself issues no per-card body read", async () => {
    const before = node.reads.length;
    await searchResult({ cfg, node, query: "card" });
    const keyed = node.reads
      .slice(before)
      .filter((r) => r.schemaHash === "cardhash" && typeof r.filter?.HashKey === "string");
    expect(keyed).toHaveLength(0);
  });
});
