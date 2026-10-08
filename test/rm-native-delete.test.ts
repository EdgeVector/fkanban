import { describe, expect, test } from "bun:test";

import { rmCmd } from "../src/commands/rm.ts";
import { FkanbanError, type NodeClient, type QueryFilter, type QueryResponse } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { cardToFields, emptyStructuredFields, listDependentsOf, type Card } from "../src/record.ts";
import { setBoardCardPrimaryDeleteRetryDelaysForTests } from "../src/board-cards.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash", milestone: "milestonehash" },
};

/**
 * `rm` reads milestones to hold back proof cards. Only `proof_card` and `slug`
 * matter to that guard, but every MILESTONE_FIELDS field has to be present or
 * the projection rule drops the fixture's own row.
 */
const milestoneFields = (slug: string, proofCard: string): Record<string, unknown> => ({
  slug,
  title: slug,
  body: "",
  board: "default",
  state: "active",
  position: "10",
  north_star: "",
  driver: "last-stack-milestone-driver",
  deps: [],
  proof_card: proofCard,
  proof_status: "pending",
  block_reason: "",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  completed_at: "",
});

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
    ...emptyStructuredFields(),
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

type Delete = { schemaHash: string; keyHash: string };

function fakeNode(opts: {
  cards: Card[];
  deletes: Delete[];
  /** Records the `fields` of every Card-schema query. */
  scanFields?: string[][];
  milestones?: Array<{ slug: string; proofCard: string }>;
}): NodeClient {
  const cardRows = opts.cards.map((c) => ({ fields: cardToFields(c), key: { hash: c.slug, range: null } }));
  const milestoneRows = (opts.milestones ?? []).map((m) => ({
    fields: milestoneFields(m.slug, m.proofCard),
    key: { hash: m.slug, range: null },
  }));
  const stub = () => {
    throw new Error("not implemented in fake node");
  };
  return {
    baseUrl: "http://fake",
    userHash: "test-user",
    autoIdentity: stub as never,
    bootstrap: stub as never,
    loadSchemas: stub as never,
    listSchemas: stub as never,
    createRecord: stub as never,
    updateRecord: stub as never,
    rawCall: stub as never,
    nodeTransport: stub as never,
    async deleteRecord(d) {
      opts.deletes.push(d);
    },
    async queryAll(q: { schemaHash: string; fields: string[]; filter?: QueryFilter }): Promise<QueryResponse> {
      let rows =
        q.schemaHash === "cardhash" ? cardRows : q.schemaHash === "milestonehash" ? milestoneRows : [];
      if (q.filter?.HashKey) rows = rows.filter((r) => r.key.hash === q.filter!.HashKey);
      if (q.schemaHash === "cardhash") opts.scanFields?.push([...q.fields]);
      return { ok: true, results: rows };
    },
  };
}

describe("rm native delete", () => {
  test("deletes the card using the native delete mutation when it has no dependents", async () => {
    const deletes: Delete[] = [];
    const node = fakeNode({
      cards: [card({ slug: "api" }), card({ slug: "docs" })],
      deletes,
    });

    const res = await rmCmd({ cfg, node, slug: "api" });

    expect(res).toEqual({ slug: "api", orphanedDependents: [] });
    expect(deletes).toEqual([{ schemaHash: "cardhash", keyHash: "api" }]);
  });

  test("refuses to delete a card that live cards still depend on", async () => {
    const deletes: Delete[] = [];
    const node = fakeNode({
      cards: [card({ slug: "api" }), card({ slug: "ui", deps: ["api"] }), card({ slug: "docs" })],
      deletes,
    });

    const err = await rmCmd({ cfg, node, slug: "api" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FkanbanError);
    expect((err as FkanbanError).code).toBe("card_has_dependents");
    expect((err as FkanbanError).message).toContain("1 live card");
    expect((err as FkanbanError).hint).toContain("ui");
    expect(deletes).toHaveLength(0);
  });

  /**
   * The proof-card hold. `rm` refused a live DEPENDENCY and nothing else, so the
   * evidence behind a milestone's `proof_status` could be deleted outright — and
   * the dependency hold did not cover it incidentally: measured on the primary
   * 2026-08-03, 0 of the 2 surviving proof cards were also a dep.
   */
  test("refuses to delete a card a milestone names as its proof", async () => {
    const deletes: Delete[] = [];
    const node = fakeNode({
      cards: [card({ slug: "the-proof" }), card({ slug: "docs" })],
      milestones: [{ slug: "m1", proofCard: "the-proof" }],
      deletes,
    });

    const err = await rmCmd({ cfg, node, slug: "the-proof" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FkanbanError);
    expect((err as FkanbanError).code).toBe("card_is_milestone_proof");
    expect((err as FkanbanError).message).toContain("m1");
    expect((err as FkanbanError).hint).toContain("--proof-card");
    expect(deletes).toHaveLength(0);
  });

  test("a card no milestone claims is still deleted, milestones present", async () => {
    const deletes: Delete[] = [];
    const node = fakeNode({
      cards: [card({ slug: "the-proof" }), card({ slug: "docs" })],
      milestones: [{ slug: "m1", proofCard: "the-proof" }],
      deletes,
    });

    const res = await rmCmd({ cfg, node, slug: "docs" });

    expect(res.slug).toBe("docs");
    expect(deletes).toEqual([{ schemaHash: "cardhash", keyHash: "docs" }]);
  });

  test("missing cards still raise card_not_found before any delete", async () => {
    const deletes: Delete[] = [];
    const node = fakeNode({ cards: [], deletes });

    const err = await rmCmd({ cfg, node, slug: "ghost" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FkanbanError);
    expect((err as FkanbanError).code).toBe("card_not_found");
    expect(deletes).toHaveLength(0);
  });

  /**
   * The dependents check reads every card on every board, and `rm` pays it on
   * every delete. It only needs `slug`, `deps` and `tags` (tombstones), so it
   * must not ask for `kind`, `created_at`, `column`, `position` or `board` too.
   */
  test("the dependents scan requests only slug, tags and deps", async () => {
    const scanFields: string[][] = [];
    const node = fakeNode({
      cards: [card({ slug: "api" }), card({ slug: "ui", deps: ["api"] }), card({ slug: "docs" })],
      deletes: [],
      scanFields,
    });

    const dependents = await listDependentsOf(node, cfg, "api");

    expect(dependents).toEqual(["ui"]);
    expect(scanFields.length).toBeGreaterThan(0);
    const allowed = new Set(["slug", "tags", "deps"]);
    for (const fields of scanFields) {
      for (const f of fields) expect(allowed.has(f)).toBe(true);
    }
  });

  test("a tombstoned card that names the target as a dep does not block the delete", async () => {
    const deletes: Delete[] = [];
    const node = fakeNode({
      cards: [
        card({ slug: "api" }),
        card({ slug: "gone", deps: ["api"], tags: ["__fkanban_deleted__"] }),
      ],
      deletes,
    });

    const res = await rmCmd({ cfg, node, slug: "api" }).catch((e: unknown) => e);

    expect(res).not.toBeInstanceOf(FkanbanError);
    expect(deletes).toEqual([{ schemaHash: "cardhash", keyHash: "api" }]);
  });

  /**
   * Root cause of papercut-kanban-card-delete-leaves-boardcards-tip-without-atom-root-cause-20260924:
   * the old `deleteBoardCardSk` swallowed a genuine delete failure as
   * "best-effort: stale sk may already be gone", and `deleteCardRecord`
   * deleted the Card atom BEFORE removing the BoardCards tip. Together that
   * left a tip pointing at a missing atom, forever, with no error raised.
   * A thrown tip delete, with retries exhausted, must now (a) propagate
   * instead of being swallowed, and (b) find the Card atom still intact
   * because the atom is deleted LAST.
   */
  test("a BoardCards tip delete that fails after retries does not delete the Card atom", async () => {
    setBoardCardPrimaryDeleteRetryDelaysForTests([]);
    try {
      const deletes: Delete[] = [];
      const cfgWithBoardCards: Config = {
        ...cfg,
        schemaHashes: { ...cfg.schemaHashes, board_cards: "boardcardshash" },
      };
      const base = fakeNode({ cards: [card({ slug: "api" })], deletes });
      const node: NodeClient = {
        ...base,
        async deleteRecord(d) {
          if (d.schemaHash === "boardcardshash") throw new Error("service_timeout");
          return base.deleteRecord(d);
        },
      };

      const err = await rmCmd({ cfg: cfgWithBoardCards, node, slug: "api" }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(Error);
      expect(deletes).toHaveLength(0);
    } finally {
      setBoardCardPrimaryDeleteRetryDelaysForTests([500, 2000]);
    }
  });

  /** The healing half: a transient tip-delete failure that recovers on retry still completes the whole delete. */
  test("a BoardCards tip delete that fails once then succeeds completes the delete", async () => {
    setBoardCardPrimaryDeleteRetryDelaysForTests([0]);
    try {
      const deletes: Delete[] = [];
      const cfgWithBoardCards: Config = {
        ...cfg,
        schemaHashes: { ...cfg.schemaHashes, board_cards: "boardcardshash" },
      };
      const base = fakeNode({ cards: [card({ slug: "api" })], deletes });
      let boardCardAttempts = 0;
      const node: NodeClient = {
        ...base,
        async deleteRecord(d) {
          if (d.schemaHash === "boardcardshash") {
            boardCardAttempts += 1;
            if (boardCardAttempts === 1) throw new Error("service_timeout");
            return;
          }
          return base.deleteRecord(d);
        },
      };

      const res = await rmCmd({ cfg: cfgWithBoardCards, node, slug: "api" });

      expect(res.slug).toBe("api");
      expect(boardCardAttempts).toBe(2);
      expect(deletes).toEqual([{ schemaHash: "cardhash", keyHash: "api" }]);
    } finally {
      setBoardCardPrimaryDeleteRetryDelaysForTests([500, 2000]);
    }
  });
});
