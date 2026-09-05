// A card `show` can read must be a card `search` can find.
//
// `indexedSearchCards` reads two things and lets only one of them decide
// membership. The key-list read (`listCardSearchSurfaces`, and before this fix
// `listCardBodies`) walks the Card records — the same source of truth
// `show <slug>` point-gets. `listCardsByFilter` reads the BoardCards DISPLAY
// INDEX. The match loop iterates the display read and looks each body up BY
// that card's slug, so a slug the key list covers and the display index does
// not is unreachable at ANY query. Its content is right there in the map and
// nothing ever asks for it.
//
// That is the 2026-08-21 dogfood finding: the harness read
// `kstress-1787297879-3095-s1` with `show`, and `search kdogtok1787297933`
// missed it. Category `search-index-divergence`.
//
// It is not a race that a retry would close, and the card brief says not to add
// one. Measured on the live primary 2026-08-23
// (`scripts/probe-search-enumeration-gap.ts`): display read 178 cards, key list
// 338 slugs, gap 176 — of which 8 point-read back as REAL PLACED board cards
// (`default/todo`, `default/doing`, bodies 2415-31994 chars) sitting there
// permanently invisible to search. `kanban search "Arm bounded gc-atoms from
// the daemon sync cycle"` returned 0 while `kanban show
// lastdb-arm-gc-atoms-with-a-daemon-trigger` returned that exact title on a
// `todo` card. After the fix the same query returns it.
//
// The native fallback could not rescue any of them: it fires only when the read
// is WHOLLY degraded (`surfaces === null`, or an empty display read). One
// missing row in an otherwise healthy read never trips it, which is why a board
// can sit 8 cards short for days and look fine.
//
// WHAT BOUNDS THE FIX. The recovery is bounded by the QUERY, not by the gap: a
// gap slug is point-read only when the surface the key list already supplies
// already matches. Non-matching gap slugs cost nothing (0 reads for a no-match
// query on the live board; 17 for `lastdb`, 40 for `kanban`, against 176 keyed
// reads measured at 38ms concurrent on a 309ms read phase). There is
// deliberately no cap: a cap would drop matches while still reading as "search
// found everything".
//
// The pre-filter judges the SAME fields as `cardMatchesQuery`, which is why the
// key-list read was widened from `slug`+`body` to the whole match surface. A
// narrower pre-filter would under-select — a card whose only match is its title
// would be judged a non-match, never point-read, and stay exactly as invisible
// as before for a narrower reason. Those extra fields cost no round trip: that
// read already point-gets every card hash.
//
// AND WHAT KEEPS IT NARROW. The point read decides membership as well as
// content — only a card that comes back PLACED (`board` and `column` both set)
// is one the display index owed us. An off-board Card record stays `--complete`
// mode's to return, and an empty query recovers nothing (`searchResult` refuses
// it outright), because "every card on the board" is precisely the question a
// card with no board row cannot answer.

import { beforeEach, describe, expect, test } from "bun:test";

import { fakeNode, type FakeNode } from "./fake-node.ts";
import type { Config } from "../src/config.ts";
import { boardToFields, cardToFields, findCard, nowIso, type Card } from "../src/record.ts";
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

// The token the dogfood harness looked for: unique, body-only, and present on
// no other card. Matching it can only come from reading this card's body.
const DOGFOOD_TOKEN = "kdogtok1787297933";
const GAP_BRIEF = `## GOAL\nProve the divergence.\n\n## END STATE\nToken ${DOGFOOD_TOKEN} is findable.`;

function card(over: Partial<Card> & { slug: string }): Card {
  const now = nowIso();
  return {
    slug: over.slug,
    title: over.title ?? over.slug,
    body: over.body ?? "## GOAL\nAn ordinary brief.",
    board: over.board ?? "default",
    column: over.column ?? "todo",
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

function seedBoard(node: FakeNode, slug = "default"): void {
  const now = nowIso();
  node.seed({
    schemaHash: "boardhash",
    keyHash: slug,
    fields: boardToFields({
      slug,
      title: slug,
      body: "",
      columns: [...DEFAULT_COLUMNS],
      created_at: now,
      updated_at: now,
    }),
  });
}

// A healthy card: Card record AND its BoardCards display row.
function seedCard(node: FakeNode, c: Card): void {
  seedCardRecordOnly(node, c);
  node.seed({
    schemaHash: "boardcardshash",
    keyHash: c.board,
    rangeKey: boardCardSk(c.column, c.position, c.slug),
    fields: boardCardFieldsFromCard(c),
  });
}

// THE DIVERGENCE. The Card record exists — `show` point-gets it in full — and
// the BoardCards row does not. This is what the live board had 8 of.
function seedCardRecordOnly(node: FakeNode, c: Card): void {
  node.seed({ schemaHash: "cardhash", keyHash: c.slug, fields: cardToFields(c) });
}

describe("search reaches every card show can read", () => {
  let node: FakeNode;
  const healthy = card({ slug: "healthy-card", title: "An indexed card", position: "m" });
  const diverged = card({
    slug: "kstress-1787297879-3095-s1",
    title: "Arm bounded gc-atoms from the daemon sync cycle",
    body: GAP_BRIEF,
    position: "n",
  });

  beforeEach(() => {
    node = fakeNode();
    seedBoard(node);
    seedCard(node, healthy);
    seedCardRecordOnly(node, diverged);
  });

  // NON-VACUITY, BOTH HALVES. If the fixture does not actually reproduce the
  // divergence, every assertion below is about nothing. Pin the premise: `show`
  // sees the card, the display index does not.
  test("the fixture reproduces the input: show point-gets the diverged card", async () => {
    const got = await findCard(node, cfg, diverged.slug);
    expect(got).not.toBeNull();
    expect(got!.title).toBe(diverged.title);
    expect(got!.body).toContain(DOGFOOD_TOKEN);
  });

  test("the fixture reproduces the input: no BoardCards row enumerates it", async () => {
    const rows = await node.queryAll({
      schemaHash: "boardcardshash",
      fields: ["slug"],
      filter: { HashKey: "default" },
    });
    const slugs = rows.results.map((r) => (r.fields as Record<string, unknown>).slug);
    expect(slugs).toContain(healthy.slug);
    expect(slugs).not.toContain(diverged.slug);
  });

  // Default search is BoardCards only. A Card record with no display row is
  // `--complete` work, not the hot path (card fkanban-search-must-not-hashkey-every-card).
  test("default search does not HashKey-recover a card missing from BoardCards", async () => {
    const res = await searchResult({ cfg, node, query: DOGFOOD_TOKEN });
    expect(res.cards.map((c) => c.slug)).not.toContain(diverged.slug);
  });

  test("--complete still finds the diverged card by body token", async () => {
    const res = await searchResult({ cfg, node, query: DOGFOOD_TOKEN, complete: true });
    expect(res.cards.map((c) => c.slug)).toEqual([diverged.slug]);
  });

  test("--complete still finds the diverged card by title", async () => {
    const res = await searchResult({ cfg, node, query: diverged.title, complete: true });
    expect(res.cards.map((c) => c.slug)).toContain(diverged.slug);
  });

  // The recovered card is a whole card, not a slug+body stub: the point read is
  // what supplies it, so its placement and title come back too. A caller that
  // renders the result must not get a hollow row.
  test("--complete recovered card carries its real placement, title and body", async () => {
    const res = await searchResult({ cfg, node, query: DOGFOOD_TOKEN, complete: true });
    const match = res.cards.find((c) => c.slug === diverged.slug);
    expect(match).toBeDefined();
    expect(match!.title).toBe(diverged.title);
    expect(match!.column).toBe("todo");
    expect(match!.board).toBe("default");
    expect(match!.body).toContain(DOGFOOD_TOKEN);
  });

  // NOT A BLANKET WIDENING. The indexed card must still come back the cheap
  // way, and must not be duplicated by the recovery pass.
  test("indexed cards are unaffected and never doubled", async () => {
    const res = await searchResult({ cfg, node, query: "card" });
    const slugs = res.cards.map((c) => c.slug);
    expect(slugs).toContain(healthy.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  // COST BOUND. The recovery point read is a WIDE card read (`findCard`), and a
  // query no gap slug matches must not issue one. The key-list read that feeds
  // the pre-filter already point-gets every card hash on its own narrow
  // projection, so counting `cardhash` reads flat would score that pre-existing
  // cost as the fix's — the assertion has to name the read the fix ADDS.
  const wideCardReads = (from: number, slug: string) =>
    node.reads
      .slice(from)
      .filter(
        (r) =>
          r.schemaHash === "cardhash" &&
          r.filter?.HashKey === slug &&
          r.fields.includes("column"),
      );

  test("a query no gap slug matches costs zero recovery point reads", async () => {
    const before = node.reads.length;
    const res = await searchResult({ cfg, node, query: "zzz-no-such-token" });
    expect(res.cards).toHaveLength(0);
    expect(wideCardReads(before, diverged.slug)).toHaveLength(0);
  });

  // NON-VACUITY for the bound above: the same probe DOES see the read when the
  // query matches. Without this, a typo in the filter would pass the cost test
  // by observing nothing at all.
  test("default matching query issues zero Card HashKeys for the gap slug", async () => {
    const before = node.reads.length;
    await searchResult({ cfg, node, query: DOGFOOD_TOKEN });
    expect(wideCardReads(before, diverged.slug)).toHaveLength(0);
  });

  // An empty query means "every card on the board", and board membership is
  // exactly what the diverged card lacks. `searchResult` already refuses it as
  // a usage error before any read, which is what keeps the default surface
  // board-scoped — pin that, rather than the recovery pass's local guard.
  test("an empty query is refused outright, so nothing is recovered", async () => {
    await expect(searchResult({ cfg, node, query: "   " })).rejects.toThrow(/Missing search query/);
  });
});

describe("recovery returns board cards only", () => {
  let node: FakeNode;
  // A Card record that is on no board at all. `--complete` mode owns these; the
  // default board-scoped search must not start returning them.
  const offBoard = card({
    slug: "off-board-record",
    title: "Not on any board",
    body: `Contains ${DOGFOOD_TOKEN} too.`,
    board: "",
    column: "",
  });
  const onOtherBoard = card({
    slug: "other-board-card",
    title: "On the roadmap board",
    body: `Contains ${DOGFOOD_TOKEN} as well.`,
    board: "roadmap",
    column: "todo",
    position: "p",
  });
  const diverged = card({
    slug: "diverged-default-card",
    title: "Diverged on default",
    body: GAP_BRIEF,
    position: "n",
  });

  beforeEach(() => {
    node = fakeNode();
    seedBoard(node);
    seedBoard(node, "roadmap");
    seedCardRecordOnly(node, offBoard);
    seedCardRecordOnly(node, onOtherBoard);
    seedCardRecordOnly(node, diverged);
  });

  test("an off-board Card record is not a default hit", async () => {
    const res = await searchResult({ cfg, node, query: DOGFOOD_TOKEN });
    const slugs = res.cards.map((c) => c.slug);
    expect(slugs).not.toContain(offBoard.slug);
    expect(slugs).not.toContain(diverged.slug);
  });

  test("--complete --board scoping finds the other-board card", async () => {
    const res = await searchResult({
      cfg,
      node,
      query: DOGFOOD_TOKEN,
      board: "roadmap",
      complete: true,
    });
    expect(res.cards.map((c) => c.slug)).toEqual([onOtherBoard.slug]);
  });

  test("--column scoping applies to recovered cards", async () => {
    const res = await searchResult({ cfg, node, query: DOGFOOD_TOKEN, column: "done" });
    expect(res.cards).toHaveLength(0);
  });
});
