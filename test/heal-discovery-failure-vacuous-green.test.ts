// `board-cards heal` must not report a clean board from a run whose discovery
// never happened.
//
// This file used to be about a bare `catch {}` around the candidate-discovery
// Card scan swallowing a load error and reporting a clean board instead. That
// scan (`scanCardSummariesForReconcile`, a Card key-list enumeration plus a
// per-row hydrate) is now GONE — see
// kanban-groom-heal-stop-card-list-scan-20260904 /
// papercut-fkanban-board-cards-heal-slug-still-scans-card-list-20260903.
// Measured against the primary 2026-09-04: client
// `kanban-groom-board-cards-heal`, schema `Card`, 108305 queries over 16h45m
// (~6465/h) — the scan ran on EVERY invocation, `--slug`-scoped or not,
// because a manual `--slug` heal still paid for the whole-board discovery it
// never needed. LastDB has no scan; this command's discovery is now
// BoardCards HashRange (the per-board partition reads) plus the legacy
// `all_cards` rollup, a single cheap point-read.
//
// The first describe block below used to prove the scan's failure was
// reported, not swallowed. With the scan removed there is nothing left for it
// to prove about a FAILURE — instead it proves the ACCEPTED GAP the removal
// reopens (a card missing from every BoardCards partition AND the rollup is
// no longer discoverable) is explicit and stays that way, and that neither a
// scoped nor an unscoped run ever key-lists Card again.
//
// ## And the unbound case, which claims work it did not do
//
// With `board_cards` unbound every partition read returns null, every write
// no-ops in `upsertBoardCard`'s `if (!schemaHash) return`, and heal still
// counted `healed += 1` per candidate. Measured pre-fix on a 5-entry
// `all_cards` rollup: `scanned=0 drifted=5 healed=5` with **0 BoardCards
// writes** — one claimed repair per rollup entry, none of them written.
//
// On a node that has run `card-list-index-retire` the rollup is empty, so the
// same state renders `scanned=0 drifted=0 healed=0` instead: quieter, same
// defect. That is what the live primary produces (measured 2026-08-05 against
// a config with `board_cards` removed), and it is why the fixture here asserts
// on the report shape rather than on a particular repair count.
//
// `board-list-heal` and `milestone-indexes-heal` both refuse this state by
// name; this command was the one that did not.

import { beforeEach, describe, expect, test } from "bun:test";

import { fakeNode, type FakeNode } from "./fake-node.ts";
import type { Config } from "../src/config.ts";
import { boardCardsHealResult } from "../src/commands/board_cards_heal.ts";
import { boardToFields, cardToFields, nowIso, type Card } from "../src/record.ts";
import { boardCardFieldsFromCard, boardCardSk } from "../src/board-cards.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: {
    card: "cardhash",
    board: "boardhash",
    board_cards: "boardcardshash",
    card_list_index: "cardlistindexhash",
  },
};

/** The same config with BoardCards unbound — every read null, every write a no-op. */
const cfgUnbound: Config = {
  ...cfg,
  schemaHashes: { card: "cardhash", board: "boardhash", card_list_index: "cardlistindexhash" },
};


function card(over: Partial<Card> & { slug: string }): Card {
  const now = nowIso();
  return {
    slug: over.slug,
    title: over.title ?? over.slug,
    body: "",
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
    first_doing_at: "",
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

function seedBoard(node: FakeNode, slug: string): void {
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

function seedCardTruth(node: FakeNode, c: Card): void {
  node.seed({ schemaHash: "cardhash", keyHash: c.slug, fields: cardToFields(c) });
}

function seedMembership(node: FakeNode, c: Card, at?: { column: string; position: string }): void {
  const column = at?.column ?? c.column;
  const position = at?.position ?? c.position;
  node.seed({
    schemaHash: "boardcardshash",
    keyHash: c.board,
    rangeKey: boardCardSk(column, position, c.slug),
    fields: boardCardFieldsFromCard({ ...c, column, position }),
  });
}

/**
 * A node that throws if anything key-lists Card — the exact regression this
 * heal must never reintroduce, scoped or not. Every other schema (BoardCards,
 * Board, the legacy rollup) still answers normally.
 */
function explodingIfCardKeyListed(node: FakeNode): FakeNode {
  return {
    ...node,
    listRecordKeys: (async (schemaHash: string, opts) => {
      if (schemaHash === "cardhash") {
        throw new Error("REGRESSION: board-cards-heal key-listed the Card schema");
      }
      return node.listRecordKeys!(schemaHash, opts);
    }) as FakeNode["listRecordKeys"],
  };
}

describe("board-cards heal discovers membership without ever key-listing Card", () => {
  let node: FakeNode;
  // Card truth is live; BoardCards row is missing on every board, and the
  // legacy rollup (frozen — `board_cards` is bound in `cfg`) has no entry for
  // it either. Only a Card scan could ever have found this one, and the scan
  // is gone — see the file header. This is an ACCEPTED gap, not a bug: the
  // test below pins that heal reports it honestly (no action, no false
  // "discovery_failed" either — nothing failed, the source no longer exists).
  const unmembered = card({ slug: "card-with-no-membership-row" });
  // Membership row exists but sits in the wrong column. Visible on the
  // BoardCards partition, so heal finds and repairs it without any scan.
  const misplaced = card({ slug: "card-in-wrong-column", column: "doing", position: "n" });

  beforeEach(() => {
    node = fakeNode();
    seedBoard(node, "default");
    seedCardTruth(node, unmembered);
    seedCardTruth(node, misplaced);
    // Empty title makes the stale row BoardCards-visible drift so unscoped
    // heal still point-gets Card. A complete-looking wrong-column row is
    // an accepted unscoped gap (Card point-get only for drifted candidates).
    seedMembership(node, { ...misplaced, title: "" }, { column: "todo", position: "n" });
  });

  test("a card missing from every BoardCards partition and the rollup is not discovered", async () => {
    const { report, text } = await boardCardsHealResult({ cfg, node, json: true });

    expect(report.actions.find((a) => a.slug === unmembered.slug)).toBeUndefined();
    // Not a failure — there is no discovery step left that CAN fail. A caller
    // must not read `discovery_failed: null` as "heal looked and found
    // nothing"; `missing_card`/`upsert-truth` for this class are simply not
    // produced by this command any more.
    expect(report.discovery_failed).toBeNull();
    expect(text).not.toContain("DISCOVERY");
  });

  test("a card with a stale BoardCards row is still found and repaired, no scan needed", async () => {
    const { report } = await boardCardsHealResult({
      cfg,
      node: explodingIfCardKeyListed(node),
      apply: true,
      json: true,
    });

    const action = report.actions.find((a) => a.slug === misplaced.slug);
    expect(action?.action).toBe("delete-stale-and-upsert");
    expect(report.healed).toBeGreaterThan(0);
    expect(report.blocked).toBe(false);
  });

  test("neither an unscoped run nor a --slug run ever key-lists Card", async () => {
    const guarded = explodingIfCardKeyListed(node);

    await expect(
      boardCardsHealResult({ cfg, node: guarded, json: true }),
    ).resolves.toBeTruthy();
    await expect(
      boardCardsHealResult({ cfg, node: guarded, slugs: [misplaced.slug], json: true }),
    ).resolves.toBeTruthy();
  });

  test("--slug seeds the named card directly and upserts its missing membership", async () => {
    const { report } = await boardCardsHealResult({
      cfg,
      node: explodingIfCardKeyListed(node),
      slugs: [unmembered.slug],
      apply: true,
      json: true,
    });

    // Named explicitly via `--slug`, so it IS the candidate set this run —
    // no rollup, no scan, just the point-read this file's other tests
    // already prove every action goes through.
    const action = report.actions.find((a) => a.slug === unmembered.slug);
    expect(action?.action).toBe("upsert-truth");
    expect(report.healed).toBe(1);
    expect(report.discovery_failed).toBeNull();
  });
});

describe("a heal with BoardCards unbound must not claim repairs it cannot write", () => {
  let node: FakeNode;
  const c = card({ slug: "card-on-an-unbound-node" });

  beforeEach(() => {
    node = fakeNode();
    seedBoard(node, "default");
    seedCardTruth(node, c);
    // A stale-column membership row, not a missing one: with the discovery
    // scan gone, only BoardCards HashRange (or the rollup) can offer a
    // candidate, so this fixture must give heal something to find via the
    // partition rather than relying on scan-only discovery.
    seedMembership(node, c, { column: "wrong-column", position: "z" });
  });

  test("it reports NOT CHECKED rather than a per-card repair count", async () => {
    const { report, text } = await boardCardsHealResult({ cfg: cfgUnbound, node, json: true });

    expect(report.board_cards_bound).toBe(false);
    expect(report.drifted).toBe(0);
    expect(report.healed).toBe(0);
    expect(report.actions).toHaveLength(0);
    expect(text).toContain("NOT CHECKED");
  });

  test("--apply writes nothing and says so", async () => {
    const before = node.writes.length;
    const { report } = await boardCardsHealResult({ cfg: cfgUnbound, node, apply: true, json: true });

    expect(node.writes.length).toBe(before);
    // The old code reported one `healed` per card here, for zero writes.
    expect(report.healed).toBe(0);
  });

  test("a bound node still reports its repairs — the guard is not a blanket mute", async () => {
    const { report } = await boardCardsHealResult({ cfg, node, json: true });

    expect(report.board_cards_bound).toBe(true);
    expect(report.actions.find((a) => a.slug === c.slug)?.action).toBe("delete-stale-and-upsert");
  });
});
