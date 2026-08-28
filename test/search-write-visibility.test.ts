// A card `show` can read after a socket write must be a card `search` can find.
//
// dogfood-kanban run kstress-1787859558-46358: `kstress-…-s1` was readable with
// `show`, and `search kdogtok1787859591` missed it. Category
// `search-index-divergence`.
//
// Two independent holes, both required for that miss:
//
// 1. Search enumerated BoardCards with `CARD_DISPLAY_FIELDS`, which includes
//    `milestone`. On the live catalog that field is the hash gate, and it is
//    the one atom that lags ~1–2 s after a write while the rest of the row is
//    already visible. HASH-ELSE-LEAD therefore DROPS the new row from the
//    partition listing. `show` point-gets Card and does not care.
// 2. Search with `--board` listed EVERY board partition, then filtered. One
//    shed sibling made `listAllBoardCards` return null, so the display read
//    came back empty even though the named board's row was there.
//
// The write path also waits until the search-shaped partition query (no
// `milestone`) can see the new slug, so `add`'s ACK is the read contract
// `search` relies on — not just the mutation 200.

import { beforeEach, describe, expect, test } from "bun:test";

import { fakeNode, type FakeNode } from "./fake-node.ts";
import type { Config } from "../src/config.ts";
import type { QueryFilter } from "../src/client.ts";
import {
  boardToFields,
  CARD_DISPLAY_FIELDS,
  CARD_SEARCH_DISPLAY_FIELDS,
  cardToFields,
  findCard,
  listCardsByFilter,
  nowIso,
  type Card,
} from "../src/record.ts";
import { boardCardFieldsFromCard, boardCardSk } from "../src/board-cards.ts";
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

const DOGFOOD_TOKEN = "kdogtok1787859591";
const SCRATCH = "agent-dogfood-scratch";
const validBody =
  "Repo: EdgeVector/fkanban\nBase: main\n\n## GOAL\nProve the divergence.\n\n## END STATE\nToken is findable.";

function card(over: Partial<Card> & { slug: string }): Card {
  const now = nowIso();
  return {
    slug: over.slug,
    title: over.title ?? over.slug,
    body: over.body ?? validBody,
    board: over.board ?? SCRATCH,
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

function seedCardRecord(node: FakeNode, c: Card): void {
  node.seed({ schemaHash: "cardhash", keyHash: c.slug, fields: cardToFields(c) });
}

function seedBoardCard(node: FakeNode, c: Card, opts?: { omitMilestone?: boolean }): void {
  const fields = boardCardFieldsFromCard(c);
  if (opts?.omitMilestone) delete fields.milestone;
  node.seed({
    schemaHash: "boardcardshash",
    keyHash: c.board,
    rangeKey: boardCardSk(c.column, c.position, c.slug),
    fields,
  });
}

function isBoardCardsPartitionQuery(q: {
  schemaHash: string;
  filter?: QueryFilter;
}): boolean {
  const filter = q.filter as Record<string, unknown> | undefined;
  return (
    q.schemaHash === "boardcardshash" &&
    typeof filter?.HashKey === "string" &&
    filter.HashRangePrefix === undefined
  );
}

function withLaggingBoardCardsIndex(
  node: FakeNode,
  opts: { hideSlugUntilAttempt: Map<string, number>; omitFromKeyList?: Set<string> },
): void {
  const origQuery = node.queryAll.bind(node);
  const attempts = new Map<string, number>();
  node.queryAll = async (q) => {
    const res = await origQuery(q);
    if (!isBoardCardsPartitionQuery(q)) return res;
    const results = res.results.filter((row) => {
      const slug = String((row.fields as Record<string, unknown>).slug ?? "");
      const need = opts.hideSlugUntilAttempt.get(slug);
      if (need === undefined) return true;
      const n = (attempts.get(slug) ?? 0) + 1;
      attempts.set(slug, n);
      return n >= need;
    });
    return { ...res, results, returned_count: results.length, total_count: results.length };
  };
  if (opts.omitFromKeyList && node.listRecordKeys) {
    const origList = node.listRecordKeys.bind(node);
    const omit = opts.omitFromKeyList;
    node.listRecordKeys = async (schemaHash, listOpts) => {
      const page = await origList(schemaHash, listOpts);
      if (schemaHash !== "cardhash") return page;
      return { ...page, keys: page.keys.filter((key) => !omit.has(key.hash)) };
    };
  }
}

describe("search finds a card show can read after a socket write", () => {
  let node: FakeNode;

  beforeEach(() => {
    node = fakeNode({ hashFields: { boardcardshash: "milestone" } });
    seedBoard(node, SCRATCH);
    seedBoard(node, "other");
  });

  test("CARD_SEARCH_DISPLAY_FIELDS omits the lagging BoardCards hash gate", () => {
    expect(CARD_DISPLAY_FIELDS).toContain("milestone");
    expect(CARD_SEARCH_DISPLAY_FIELDS).not.toContain("milestone");
    expect(CARD_SEARCH_DISPLAY_FIELDS).toContain("title");
  });

  test("the fixture drops the new row from a milestone-gated display read", async () => {
    const created = card({
      slug: "kstress-1787859558-46358-s1",
      title: `find me ${DOGFOOD_TOKEN}`,
      position: "s",
    });
    seedCardRecord(node, created);
    seedBoardCard(node, created, { omitMilestone: true });

    const gated = await listCardsByFilter(node, cfg, { board: SCRATCH }, CARD_DISPLAY_FIELDS, {
      allowKeyListFallback: false,
    });
    expect(gated.cards.map((c) => c.slug)).not.toContain(created.slug);

    const shown = await findCard(node, cfg, created.slug);
    expect(shown).not.toBeNull();
    expect(shown!.title).toContain(DOGFOOD_TOKEN);
  });

  test("a unique TITLE token finds the card whose milestone atom has not landed", async () => {
    const created = card({
      slug: "kstress-1787859558-46358-s1",
      title: `find me ${DOGFOOD_TOKEN}`,
      position: "s",
    });
    seedCardRecord(node, created);
    seedBoardCard(node, created, { omitMilestone: true });

    const res = await searchResult({
      cfg,
      node,
      query: DOGFOOD_TOKEN,
      board: SCRATCH,
    });
    expect(res.cards.map((c) => c.slug)).toEqual([created.slug]);
  });

  test("search --board queries only that BoardCards partition", async () => {
    const created = card({
      slug: "scratch-only",
      title: `find me ${DOGFOOD_TOKEN}`,
      position: "s",
    });
    const other = card({
      slug: "other-card",
      title: "unrelated",
      board: "other",
      position: "t",
    });
    seedCardRecord(node, created);
    seedCardRecord(node, other);
    seedBoardCard(node, created);
    seedBoardCard(node, other);

    const before = node.reads.length;
    await searchResult({ cfg, node, query: DOGFOOD_TOKEN, board: SCRATCH });
    const boardCardsHashKeys = node.reads.slice(before).filter(isBoardCardsPartitionQuery).map((q) =>
      (q.filter as Record<string, unknown>).HashKey,
    );
    expect(boardCardsHashKeys).toContain(SCRATCH);
    expect(boardCardsHashKeys).not.toContain("other");
  });

  test("a shed sibling board does not hide a card on the named board", async () => {
    const created = card({
      slug: "kstress-1787859558-46358-s1",
      title: `find me ${DOGFOOD_TOKEN}`,
      position: "s",
    });
    seedCardRecord(node, created);
    seedBoardCard(node, created);

    const origQuery = node.queryAll.bind(node);
    node.queryAll = async (q) => {
      const filter = q.filter as Record<string, unknown> | undefined;
      if (q.schemaHash === "boardcardshash" && filter?.HashKey === "other") {
        throw new Error("shed: too many concurrent reads");
      }
      return origQuery(q);
    };

    const res = await searchResult({
      cfg,
      node,
      query: DOGFOOD_TOKEN,
      board: SCRATCH,
    });
    expect(res.cards.map((c) => c.slug)).toEqual([created.slug]);
  });

  test("add ACK means search can find the unique token even when the key list lags", async () => {
    const slug = "kstress-1787859558-46358-s1";
    withLaggingBoardCardsIndex(node, {
      hideSlugUntilAttempt: new Map([[slug, 2]]),
      omitFromKeyList: new Set([slug]),
    });

    const created = await addCmd({
      cfg,
      node,
      slug,
      title: `find me ${DOGFOOD_TOKEN}`,
      board: SCRATCH,
      column: "todo",
      kind: "tracker",
      tags: ["kstress"],
      repo: "EdgeVector/fkanban",
      body: validBody,
    });
    expect(created.action).toBe("created");

    const shown = await findCard(node, cfg, slug);
    expect(shown).not.toBeNull();
    expect(shown!.title).toContain(DOGFOOD_TOKEN);

    const res = await searchResult({
      cfg,
      node,
      query: DOGFOOD_TOKEN,
      board: SCRATCH,
    });
    expect(res.cards.map((c) => c.slug)).toEqual([slug]);
  });
});
