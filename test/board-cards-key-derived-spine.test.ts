// The spine is addressed, not fetched — and `position` is the exception.
//
// `sk`/`slug`/`column` are payload COPIES of the range key, so a BoardCards
// read can stop projecting them and slice them off `QueryRow.key.range`
// instead. Measured on the live primary 2026-08-03 (186 rows, HashKey=default,
// 7 interleaved reps, `scripts/probe-boardcards-spine-drop-cost.ts`):
// BOARD_CARDS_LIST_FIELDS 496ms -> 386ms, the dep seed 366ms -> 219ms, with
// identical row sets and zero disagreement on the reconstructed values.
//
// `position` looks like it belongs in that set and does not. `boardCardSk`
// pads it to 8 chars, and `parseBoardCardSk` used to un-pad it through
// `Number` — so "m" -> "0000000m" -> "NaN" and "1e3" -> "000001e3" -> "1000".
// Caught here because `heal-scan-board-attribution.test.ts` uses position "m"
// and started reporting a correctly-membered card as stale.
//
// That un-pad is fixed (2026-08-03): it strips the padding at the string
// level, which is the actual inverse of `padStart`. `position` still stays
// projected, for the smaller reason that survives the fix — `padStart` is not
// injective over positions whose string form starts with "0" ("007" and "7"
// share a key segment), and unlike slug/column there is no second copy left to
// check a key-derived value against once the field is dropped.

import { describe, expect, test } from "bun:test";

import { fakeNode, type FakeNode } from "./fake-node.ts";
import type { Config } from "../src/config.ts";
import {
  BOARD_CARDS_LIST_FIELDS,
  BOARD_CARDS_DEP_SEED_FIELDS,
  boardCardsWireProjection,
  boardCardFieldsFromCard,
  boardCardSk,
  parseBoardCardSk,
  listBoardCardsPartition,
} from "../src/board-cards.ts";
import { nowIso, type Card } from "../src/record.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash", board_cards: "boardcardshash" },
};

function card(over: Partial<Card> & { slug: string }): Card {
  const now = nowIso();
  return {
    slug: over.slug,
    title: over.title ?? over.slug,
    body: "",
    board: over.board ?? "default",
    column: over.column ?? "todo",
    position: over.position ?? "1",
    assignee: "",
    tags: [],
    deps: [],
    surfaces: [],
    created_at: now,
    updated_at: now,
    done_at: "",
    db: "",
    kind: "pr",
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

describe("boardCardsWireProjection", () => {
  test("drops the three key-derived spine fields and nothing else", () => {
    const wire = boardCardsWireProjection([...BOARD_CARDS_LIST_FIELDS]);
    for (const gone of ["sk", "slug", "column"]) expect(wire).not.toContain(gone);
    for (const kept of BOARD_CARDS_LIST_FIELDS) {
      if (["sk", "slug", "column"].includes(kept)) continue;
      expect(wire).toContain(kept);
    }
  });

  test("keeps `position` — the key cannot supply it losslessly", () => {
    expect(boardCardsWireProjection([...BOARD_CARDS_LIST_FIELDS])).toContain("position");
    expect(boardCardsWireProjection([...BOARD_CARDS_DEP_SEED_FIELDS])).toContain("position");
    // The reason, pinned directly — and it is NOT "lexical positions break"
    // any more (parseBoardCardSk un-pads at the string level since 2026-08-03).
    // It is that `padStart` is not injective over positions whose own string
    // form starts with "0", and dropping the field would remove the only copy
    // left to check a key-derived value against.
    expect(parseBoardCardSk(boardCardSk("todo", "007", "x"))!.position).toBe("7");
    expect(parseBoardCardSk(boardCardSk("todo", "7", "x"))!.position).toBe("7");
  });

  test("parseBoardCardSk inverts the pad instead of parsing it as a number", () => {
    // The papercut this closes: `String(Number(segment))` agrees with the real
    // inverse on plain integers and diverges destructively elsewhere. Each row
    // is a position `boardCardSk` CAN represent, so the round trip must be
    // exact.
    for (const position of ["7777", "0", "1", "1.5", "m", "a0", "-5", "1e3", "z9z"]) {
      const sk = boardCardSk("todo", position, "x");
      const parsed = parseBoardCardSk(sk)!;
      expect(parsed.position).toBe(position);
      // The property heal actually gates on: the rebuilt address equals the
      // real key, so a correct membership row can never read as stale.
      expect(boardCardSk(parsed.column, parsed.position, parsed.slug)).toBe(sk);
    }
  });

  test("`1e3` is the row that made this destructive rather than merely broken", () => {
    // Number() did not fail loudly here — it returned a plausible DIFFERENT
    // position (1000), which heal would have compared, rejected, and written
    // back over a correct rank.
    expect(String(Number("000001e3"))).toBe("1000");
    expect(parseBoardCardSk(boardCardSk("todo", "1e3", "x"))!.position).toBe("1e3");
  });

  test("a position longer than the pad width is untouched in both directions", () => {
    const sk = boardCardSk("todo", "123456789", "x");
    expect(parseBoardCardSk(sk)!.position).toBe("123456789");
  });

  test("preserves the LEADING field verbatim, even when it is key-derived", () => {
    // The leading projected field gates the row set (see
    // listBoardCardsPartitionComplete), so narrowing must never touch it —
    // that is what makes this a cost change rather than a behaviour change.
    expect(boardCardsWireProjection(["board", "sk", "slug", "title"])[0]).toBe("board");
    expect(boardCardsWireProjection(["slug", "sk", "column", "title"])).toEqual(["slug", "title"]);
    expect(boardCardsWireProjection(["sk", "slug", "title"])).toEqual(["sk", "title"]);
    expect(boardCardsWireProjection([])).toEqual([]);
  });
});

/** A BoardCards membership row, keyed exactly as the writer keys it. */
function seedMembership(node: FakeNode, c: Card): void {
  node.seed({
    schemaHash: "boardcardshash",
    keyHash: c.board,
    rangeKey: boardCardSk(c.column, c.position, c.slug),
    fields: boardCardFieldsFromCard(c),
  });
}

function nodeWith(cards: Card[]): FakeNode {
  const node = fakeNode();
  for (const c of cards) seedMembership(node, c);
  return node;
}

describe("a partition read rebuilds the spine from the row's key", () => {
  test("slug/column/position survive a read that projects none of slug/sk/column", async () => {
    const node = nodeWith([
      card({ slug: "alpha", column: "todo", position: "7777" }),
      card({ slug: "beta", column: "done", position: "12" }),
    ]);
    const rows = await listBoardCardsPartition(node, cfg, "default");
    const bySlug = new Map(rows!.map((c) => [c.slug, c]));

    // The read asked for none of them...
    const wire = node.reads.at(-1)!.fields;
    for (const gone of ["sk", "slug", "column"]) expect(wire).not.toContain(gone);

    // ...and all three came back right anyway.
    expect([...bySlug.keys()].sort()).toEqual(["alpha", "beta"]);
    expect(bySlug.get("alpha")!.column).toBe("todo");
    expect(bySlug.get("alpha")!.position).toBe("7777");
    expect(bySlug.get("beta")!.column).toBe("done");
    expect(bySlug.get("beta")!.board).toBe("default");
  });

  test("a LEXICAL position is returned unchanged, not run through Number()", async () => {
    // The regression this file exists for: derive `position` from the key and
    // this card comes back ordered by "NaN".
    const node = nodeWith([card({ slug: "ranked", column: "todo", position: "m" })]);
    const rows = await listBoardCardsPartition(node, cfg, "default");
    expect(rows![0]!.position).toBe("m");
  });

  test("`board` comes from the filter argument, not a payload copy", async () => {
    // Same choice as spineRowsFromQueryRows: the caller passed the partition in,
    // so it is the one value guaranteed to be in hand.
    const node = nodeWith([card({ slug: "solo", board: "team", column: "todo" })]);
    const rows = await listBoardCardsPartition(node, cfg, "team");
    expect(rows![0]!.board).toBe("team");
    expect(node.reads.at(-1)!.fields).not.toContain("slug");
  });
});
