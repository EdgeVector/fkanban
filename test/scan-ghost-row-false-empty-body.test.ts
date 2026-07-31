// A full scan may SUPPLY a body. It may never DENY one.
//
// Sibling of `body-omitted-projection.test.ts`. That file pins the rule that a
// body-free PROJECTION must not reach a body verdict. This one pins the case
// that slipped past it: the body did come from a read that carries bodies —
// the admin full scan — and the value it carried was a lie.
//
// The live primary holds Card rows the keyed read cannot reach. Measured
// 2026-07-31 on Tom's node: a `slug`+`body` scan returned 642 rows for 595
// distinct slugs; 47 slugs had two rows, and in 44 of those one row held the
// real brief and the other held `""`. The two rows are keyed DIFFERENTLY —
// the real one under the node's derived key, the ghost under the bare slug —
// which is why `HashKey(slug)` returns exactly one row, always the real one
// (verified across 12 affected slugs, bodies 70–4389 chars). Only
// `allowFullScan` sees the ghosts.
//
// That made presence-in-the-scan a bad proxy for coverage.
// `listBoardCardsWithBodies` asked `bodies.has(slug)` and got `true` for the
// ghost, so it called `withLoadedBody(card, "")` — which CLEARS the
// `BODY_OMITTED` marker. `hydrateCardBodies` then correctly declined to
// point-read a body someone had already claimed to read, and the false empty
// was laundered into a genuine one. On the live board that handed 33 of 352
// cards an empty body whose real brief (513–4389 chars) was one keyed read
// away — to the exact sweeps (`groom stale-blockers`, `rank`, `migrate
// area-tags`) that judge and rewrite bodies.
//
// The fixture reproduces the node's shape rather than the fix's shape: a
// canonical row under the slug key, a ghost row under a different key carrying
// the same `slug` and an empty body. A scan sees both; a keyed read sees one.

import { beforeEach, describe, expect, test } from "bun:test";

import { fakeNode, type FakeNode } from "./fake-node.ts";
import type { Config } from "../src/config.ts";
import {
  boardToFields,
  cardToFields,
  findCard,
  isBodyOmitted,
  listBoardCardsWithBodies,
  listCardsWithBodies,
  nowIso,
  type Card,
} from "../src/record.ts";
import { boardCardFieldsFromCard, boardCardSk } from "../src/board-cards.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash", board_cards: "boardcardshash" },
};

const BRIEF = [
  "Repo: EdgeVector/fkanban",
  "Base: main",
  "",
  "## GOAL",
  "A real brief that a sweep must never mistake for a hollow card.",
  "",
  "## END STATE",
  "The body survives the sweep.",
].join("\n");

function card(over: Partial<Card> & { slug: string }): Card {
  const now = nowIso();
  return {
    slug: over.slug,
    title: over.title ?? over.slug,
    body: over.body ?? BRIEF,
    board: over.board ?? "default",
    column: over.column ?? "todo",
    position: over.position ?? "m",
    assignee: "",
    tags: over.tags ?? [],
    deps: [],
    surfaces: [],
    created_at: now,
    updated_at: now,
    done_at: "",
    db: "",
    kind: over.kind ?? "pr",
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

/** The row every fkanban write produces: keyed by slug, carrying the body. */
function seedCanonicalCard(node: FakeNode, c: Card): void {
  node.seed({ schemaHash: "cardhash", keyHash: c.slug, fields: cardToFields(c) });
  node.seed({
    schemaHash: "boardcardshash",
    keyHash: c.board,
    rangeKey: boardCardSk(c.column, c.position, c.slug),
    fields: boardCardFieldsFromCard(c),
  });
}

/**
 * The row only a scan can see: same `slug` field, empty `body`, a DIFFERENT
 * key — so `HashKey(slug)` misses it exactly as the live primary does. Seeded
 * after the canonical row so it also lands last in scan order, which is what
 * made a last-write-wins map pick it.
 */
function seedGhostRow(node: FakeNode, c: Card): void {
  node.seed({
    schemaHash: "cardhash",
    keyHash: `ghost-key-for-${c.slug}`,
    fields: cardToFields({ ...c, body: "" }),
  });
}

describe("a scan's ghost row must never deny a card its body", () => {
  let node: FakeNode;
  const briefed = card({ slug: "briefed-card" });

  beforeEach(() => {
    node = fakeNode();
    seedBoard(node);
    seedCanonicalCard(node, briefed);
    seedGhostRow(node, briefed);
  });

  // NON-VACUITY. Everything below is only meaningful if the fixture actually
  // reproduces the hazard: the scan must really return two rows, the empty one
  // must really come last, and the keyed read must really be clean. Without
  // this, a fixture that quietly stopped producing a ghost would make every
  // other test in the file pass for the wrong reason.
  test("the fixture reproduces the node: scan sees two rows, keyed read sees one", async () => {
    const scan = await node.queryAll({
      schemaHash: "cardhash",
      fields: ["slug", "body"],
      allowFullScan: true,
    });
    const rows = scan.results.filter((r) => (r.fields as Record<string, unknown>).slug === briefed.slug);
    expect(rows).toHaveLength(2);
    // Last-write-wins over this scan lands on the EMPTY body — the old bug.
    expect((rows[rows.length - 1]!.fields as Record<string, unknown>).body).toBe("");

    const keyed = await node.queryAll({
      schemaHash: "cardhash",
      fields: ["slug", "body"],
      filter: { HashKey: briefed.slug },
    });
    expect(keyed.results).toHaveLength(1);
    expect((keyed.results[0]!.fields as Record<string, unknown>).body).toBe(BRIEF);
  });

  test("listCardsWithBodies returns the card ONCE, with the real body", async () => {
    const cards = await listCardsWithBodies(node, cfg);
    const mine = cards.filter((c) => c.slug === briefed.slug);
    // Two rows in, one card out — `search --complete` listed it twice before.
    expect(mine).toHaveLength(1);
    expect(mine[0]!.body).toBe(BRIEF);
  });

  test("the sweep path hands the body-judging commands the real brief", async () => {
    const cards = await listBoardCardsWithBodies(node, cfg);
    const mine = cards.find((c) => c.slug === briefed.slug);
    expect(mine).toBeDefined();
    expect(isBodyOmitted(mine!)).toBe(false);
    expect(mine!.body).toBe(BRIEF);
  });

  test("an empty scan body is not coverage — the card is point-read instead", async () => {
    // A card with NO canonical row body to find: the scan can only offer "",
    // and the rule is that only a keyed read may settle that. The keyed read
    // must actually happen.
    const hollow = card({ slug: "genuinely-empty", body: "" });
    seedCanonicalCard(node, hollow);

    const before = node.reads.length;
    const cards = await listBoardCardsWithBodies(node, cfg);
    const keyedReads = node.reads
      .slice(before)
      .filter((r) => r.schemaHash === "cardhash" && (r.filter as { HashKey?: string } | undefined)?.HashKey === hollow.slug);
    expect(keyedReads.length).toBeGreaterThan(0);

    // And the fix must not INVENT a body: genuinely empty stays empty.
    const got = cards.find((c) => c.slug === hollow.slug);
    expect(got?.body).toBe("");
    // While the briefed card in the same sweep still came back whole.
    expect(cards.find((c) => c.slug === briefed.slug)?.body).toBe(BRIEF);
  });

  test("the body read is projected narrow — a wide scan drops rows it needs", async () => {
    // LastDB returns a row only when EVERY projected field has an atom, so the
    // wide card projection is a FILTER, not a superset: on the primary it
    // returned 421 slugs where slug+body returned 595. This read wants bodies.
    const before = node.reads.length;
    await listBoardCardsWithBodies(node, cfg);
    const scans = node.reads
      .slice(before)
      .filter((r) => r.schemaHash === "cardhash" && r.filter === undefined);
    expect(scans.length).toBeGreaterThan(0);
    for (const scan of scans) expect([...scan.fields].sort()).toEqual(["body", "slug"]);
  });

  test("the real body survives even when the ghost row is the one the scan yields first", async () => {
    // Order-independence is the point of keep-longest: a node free to return
    // rows in any order must not be able to change the answer.
    const flipped = fakeNode();
    seedBoard(flipped);
    const other = card({ slug: "order-flipped" });
    seedGhostRow(flipped, other);
    seedCanonicalCard(flipped, other);

    const cards = await listBoardCardsWithBodies(flipped, cfg);
    expect(cards.find((c) => c.slug === other.slug)?.body).toBe(BRIEF);
    expect((await findCard(flipped, cfg, other.slug))?.body).toBe(BRIEF);
  });
});
