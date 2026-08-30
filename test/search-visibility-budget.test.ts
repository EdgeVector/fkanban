// `search-index-divergence`, third occurrence — and the test that would have
// caught the two fixes that did not hold.
//
// dogfood-kanban has now reported the same category three times:
// kstress-1787297879-3095 (2026-08-21), kstress-1787859558-46358 (2026-08-27),
// kstress-1788075496-36956 (2026-08-30). Each time a card was readable with
// `show` immediately after `add` and `search` missed it.
//
// WHY THE FIRST TWO FIXES DID NOT HOLD. Each closed one path and assumed the
// other was sound:
//
//   Fix 1 (2026-08-23) gave search a recovery pass over the Card KEY LIST for
//   slugs the BoardCards display index had not enumerated. It assumed the key
//   list is fresh at the write ACK.
//
//   Fix 2 (2026-08-27) dropped the lagging `milestone` atom from the search
//   projection and made the write path wait until the search-shaped PARTITION
//   query could see the slug. It assumed BoardCards is the only source search
//   needs, and that ~1.6 s of budget covers the lag.
//
// Both assumptions are false. Measured on the live primary 2026-08-30 through
// the real CLI (`scripts/probe-search-read-lag.ts`), at the exact moment the
// stress harness runs `search`:
//
//   | source                              | saw the new card |
//   |-------------------------------------|------------------|
//   | BoardCards partition (fix 2's read) | 0 of 4           |
//   | Card key list (fix 1's recovery)    | 1 of 4           |
//   | Card HashKey point get (`show`)     | 4 of 4           |
//
// The partition first saw the row ~1.6 s AFTER `add` had already returned —
// about 3.1 s after the write began, against a 1575 ms budget. So the wait ran,
// expired, and returned SILENTLY: `add` printed `created card …`, `show` read it
// back, and nothing anywhere said `search` could not see it. That silence is why
// two fixes read as holding while the defect was live.
//
// The tests below pin the CONTRACT rather than either mechanism:
//   1. the wait covers BOTH sources, because either one lets search answer;
//   2. the budget covers the measured lag;
//   3. an exhausted budget is REPORTED, never silent.
//
// Test 1 is the discriminating one. Its fixture lags both sources past the old
// 8-attempt budget, so it fails against fix 1 (no wait at all) and against fix 2
// (partition-only wait, too short), and passes only when the wait watches both
// sources for long enough.

import { beforeEach, describe, expect, test } from "bun:test";

import { fakeNode, type FakeNode } from "./fake-node.ts";
import type { Config } from "../src/config.ts";
import type { QueryFilter } from "../src/client.ts";
import {
  awaitBoardCardSearchVisible,
  boardCardFieldsFromCard,
  boardCardSk,
  SEARCH_INDEX_VISIBLE_BUDGET_MS,
  searchVisibilityTimeoutWarning,
} from "../src/board-cards.ts";
import { boardToFields, cardToFields, findCard, nowIso, type Card } from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";
import { addCmd } from "../src/commands/add.ts";
import { searchResult } from "../src/commands/search.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: {
    card: "cardhash",
    board: "boardhash",
    board_cards: "boardcardshash",
  },
};

const SCRATCH = "agent-dogfood-scratch";
// The token from the third occurrence, so the fixture names the run it comes from.
const DOGFOOD_TOKEN = "kdogtok1788075530";
const SLUG = "kstress-1788075496-36956-s1";
const validBody =
  "Repo: EdgeVector/fkanban\nBase: main\n\n## GOAL\nProve the divergence.\n\n## END STATE\nToken is findable.";

/**
 * The old budget, in attempts: 8 partition reads. The fixture below hides the
 * row for longer than this, which is exactly what the previous regression test
 * did not do — it lagged the partition by ONE attempt.
 */
const OLD_BUDGET_ATTEMPTS = 8;

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

/** A whole, already-written card — the state the wait is asked about. */
function writtenCard(): Card {
  const now = nowIso();
  return {
    slug: SLUG,
    title: `find me ${DOGFOOD_TOKEN}`,
    body: validBody,
    board: SCRATCH,
    column: "todo",
    position: "s",
    assignee: "",
    tags: ["kstress"],
    deps: [],
    surfaces: [],
    created_at: now,
    updated_at: now,
    done_at: "",
    db: "",
    kind: "tracker",
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

/** Seed both rows a completed write leaves behind, so only the LAG is fixtured. */
function seedWrittenCard(node: FakeNode, c: Card): void {
  node.seed({ schemaHash: "cardhash", keyHash: c.slug, fields: cardToFields(c) });
  node.seed({
    schemaHash: "boardcardshash",
    keyHash: c.board,
    rangeKey: boardCardSk(c.column, c.position, c.slug),
    fields: boardCardFieldsFromCard(c),
  });
}

function isBoardCardsPartitionQuery(q: { schemaHash: string; filter?: QueryFilter }): boolean {
  const filter = q.filter as Record<string, unknown> | undefined;
  return (
    q.schemaHash === "boardcardshash" &&
    typeof filter?.HashKey === "string" &&
    filter.HashRangePrefix === undefined
  );
}

/**
 * A node whose two ENUMERATIONS lag behind its point get — the shape measured on
 * the primary. `show` (Card HashKey) is untouched and answers immediately; the
 * BoardCards partition and the Card key list each withhold the slug for a set
 * number of reads.
 *
 * Counted in reads rather than milliseconds on purpose: a wall-clock fixture
 * would have to burn the real multi-second budget to say anything, and would
 * then be tuned down until it stopped saying it.
 */
function withLaggingEnumerations(
  node: FakeNode,
  opts: { slug: string; partitionVisibleAfter: number; keyListVisibleAfter: number },
): { partitionReads: () => number; keyListReads: () => number } {
  let partitionReads = 0;
  let keyListReads = 0;

  const origQuery = node.queryAll.bind(node);
  node.queryAll = async (q) => {
    const res = await origQuery(q);
    if (!isBoardCardsPartitionQuery(q)) return res;
    partitionReads++;
    if (partitionReads >= opts.partitionVisibleAfter) return res;
    // BoardCards carries the slug in the RANGE KEY (`column#position#slug`), and
    // that is what the partition reader parses — a fixture that only filtered a
    // projected `slug` field would hide nothing and quietly pass.
    const results = res.results.filter((row) => {
      const range = typeof row.key?.range === "string" ? row.key.range : "";
      const fromSk = range.slice(range.lastIndexOf("#") + 1);
      const fromFields = String((row.fields as Record<string, unknown>).slug ?? "");
      return fromSk !== opts.slug && fromFields !== opts.slug;
    });
    return { ...res, results, returned_count: results.length, total_count: results.length };
  };

  const origList = node.listRecordKeys!.bind(node);
  node.listRecordKeys = async (schemaHash, listOpts) => {
    const page = await origList(schemaHash, listOpts);
    if (schemaHash !== "cardhash") return page;
    keyListReads++;
    if (keyListReads >= opts.keyListVisibleAfter) return page;
    return { ...page, keys: page.keys.filter((key) => key.hash !== opts.slug) };
  };

  return { partitionReads: () => partitionReads, keyListReads: () => keyListReads };
}

describe("the write path waits on every index search reads", () => {
  let node: FakeNode;

  beforeEach(() => {
    node = fakeNode({ hashFields: { boardcardshash: "milestone" } });
    seedBoard(node, SCRATCH);
  });

  test("add ACK means search can find the card when BOTH enumerations lag past the old budget", async () => {
    // The partition never catches up inside any budget; the key list does, a few
    // reads in. Search can answer from either, so the wait must watch both — a
    // partition-only wait returns blind here no matter how long it runs.
    withLaggingEnumerations(node, {
      slug: SLUG,
      partitionVisibleAfter: Number.MAX_SAFE_INTEGER,
      keyListVisibleAfter: 2,
    });

    const created = await addCmd({
      cfg,
      node,
      slug: SLUG,
      title: `find me ${DOGFOOD_TOKEN}`,
      board: SCRATCH,
      column: "todo",
      kind: "tracker",
      tags: ["kstress"],
      repo: "EdgeVector/fkanban",
      body: validBody,
    });
    expect(created.action).toBe("created");

    // The premise of the finding: `show` can read it.
    const shown = await findCard(node, cfg, SLUG);
    expect(shown).not.toBeNull();
    expect(shown!.title).toContain(DOGFOOD_TOKEN);

    // The finding itself: so must `search`, at the ACK, with no retry.
    const res = await searchResult({ cfg, node, query: DOGFOOD_TOKEN, board: SCRATCH });
    expect(res.cards.map((c) => c.slug)).toEqual([SLUG]);
  });

  test("the wait outlives a partition lag longer than the old 8-attempt budget", async () => {
    const card = writtenCard();
    seedWrittenCard(node, card);
    const counters = withLaggingEnumerations(node, {
      slug: SLUG,
      partitionVisibleAfter: OLD_BUDGET_ATTEMPTS + 2,
      keyListVisibleAfter: Number.MAX_SAFE_INTEGER,
    });

    const visible = await awaitBoardCardSearchVisible(node, cfg, card, { sleep: async () => {} });

    expect(visible).toBe(true);
    expect(counters.partitionReads()).toBeGreaterThan(OLD_BUDGET_ATTEMPTS);
  });

  test("a settled index still costs one partition read and no key-list read", async () => {
    // The second source must not become a tax on the common case: the key list is
    // the expensive read (measured 760 ms for 1967 hashes against ~47 ms for the
    // partition) and it is only consulted once the cheap one has missed.
    const card = writtenCard();
    seedWrittenCard(node, card);
    const counters = withLaggingEnumerations(node, {
      slug: SLUG,
      partitionVisibleAfter: 1,
      keyListVisibleAfter: 1,
    });

    const visible = await awaitBoardCardSearchVisible(node, cfg, card, { sleep: async () => {} });

    expect(visible).toBe(true);
    expect(counters.partitionReads()).toBe(1);
    expect(counters.keyListReads()).toBe(0);
  });

  test("an exhausted budget is reported, not swallowed", async () => {
    const card = writtenCard();
    seedWrittenCard(node, card);
    withLaggingEnumerations(node, {
      slug: SLUG,
      partitionVisibleAfter: Number.MAX_SAFE_INTEGER,
      keyListVisibleAfter: Number.MAX_SAFE_INTEGER,
    });

    const visible = await awaitBoardCardSearchVisible(node, cfg, card, { sleep: async () => {} });

    // The write itself still stands — failing `add` would turn a search finding
    // into a lost create — but the caller is told, so the divergence is visible
    // at the moment it happens instead of in a dogfood report days later.
    expect(visible).toBe(false);
    expect(searchVisibilityTimeoutWarning(SLUG)).toContain(SLUG);
    expect(searchVisibilityTimeoutWarning(SLUG)).toContain(String(SEARCH_INDEX_VISIBLE_BUDGET_MS));
  });

  test("the budget covers the lag measured on the primary", () => {
    // 3.1 s from the write, measured 2026-08-30. A budget under that is the
    // 2026-08-27 fix again, and this assertion is what fails if someone tunes it
    // back down for speed.
    expect(SEARCH_INDEX_VISIBLE_BUDGET_MS).toBeGreaterThanOrEqual(3100);
  });
});
