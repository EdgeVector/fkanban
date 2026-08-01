/**
 * `deleteCardRecord` must not infer a card's milestone from the object it was
 * handed.
 *
 * The three indexes a delete fans out to derive their partition differently:
 *
 *   removeBoardCard      -> partition = card.board       (BoardCards SPINE)
 *   removeMilestoneCard  -> partition = card.milestone   (NOT in the spine)
 *
 * and `removeMilestoneCard` opens with `if (!ms) return`. LastDB returns "" for
 * a field the caller did not project, so that guard cannot distinguish "this
 * card has no milestone" from "you did not ask for one". Two of the three
 * `deleteCardRecord` callers hand it a thin BoardCards row:
 *
 *   archive_done.ts  -> listCardsByColumn(..., ARCHIVE_AGE_FIELDS, ...)
 *   board.ts (rm -f) -> listCards() thin rows
 *
 * neither projection carries `milestone`. So the MilestoneCards row survives a
 * delete that removed the Card behind it — a permanent orphan, because the
 * Card that would have named its partition is gone.
 *
 * This is the failure `readWholeCardRow` already refuses to accept on the WRITE
 * path (src/record.ts): "Inferring wholeness from an object that cannot state
 * its own provenance is how a thin read becomes silent data loss."
 */
import { describe, expect, test } from "bun:test";
import type { NodeClient, QueryFilter, QueryResponse, QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { boardCardSk } from "../src/board-cards.ts";
import { milestoneCardSk } from "../src/milestone-cards.ts";
import { deleteCardRecord, emptyStructuredFields, type Card } from "../src/record.ts";
import { BOARD_CARDS_LAYOUT, MILESTONE_CARDS_LAYOUT } from "../src/schemas.ts";

const CARD_HASH = "card-hash";
const BOARD_CARDS_HASH = "board-cards-hash";
const MILESTONE_CARDS_HASH = "milestone-cards-hash";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://127.0.0.1:9",
  userHash: "user",
  schemaServiceUrl: "http://127.0.0.1:9",
  schemaHashes: {
    board: "board-hash",
    card: CARD_HASH,
    board_cards: BOARD_CARDS_HASH,
    milestone_cards: MILESTONE_CARDS_HASH,
  },
};

type StoredRecord = { keyHash: string; rangeKey: string | null; fields: Record<string, unknown> };

function fakeStoreNode(): NodeClient & {
  rows: (schemaHash: string) => StoredRecord[];
  queryLog: () => Array<{ schemaHash: string; fields: string[] }>;
} {
  const store = new Map<string, Map<string, StoredRecord>>();
  const queries: Array<{ schemaHash: string; fields: string[] }> = [];
  const storeKey = (keyHash: string, rangeKey?: string | null) => `${keyHash}\0${rangeKey ?? ""}`;
  const tableFor = (schemaHash: string) => {
    let t = store.get(schemaHash);
    if (!t) {
      t = new Map();
      store.set(schemaHash, t);
    }
    return t;
  };
  const rowsFor = (schemaHash: string, filter?: QueryFilter): QueryRow[] => {
    const t = tableFor(schemaHash);
    const entries = filter?.HashKey
      ? [...t.values()].filter((rec) => rec.keyHash === filter.HashKey)
      : [...t.values()];
    return entries.map(({ keyHash, rangeKey, fields }) => ({
      fields,
      key: { hash: keyHash, range: rangeKey },
    }));
  };
  const notImpl = (m: string) => async (): Promise<never> => {
    throw new Error(`fakeNode.${m} not implemented`);
  };
  return {
    baseUrl: cfg.nodeUrl,
    userHash: cfg.userHash,
    autoIdentity: notImpl("autoIdentity"),
    bootstrap: notImpl("bootstrap"),
    loadSchemas: notImpl("loadSchemas"),
    listSchemas: notImpl("listSchemas"),
    async createRecord({ schemaHash, fields, keyHash, rangeKey }) {
      tableFor(schemaHash).set(storeKey(keyHash, rangeKey), {
        keyHash,
        rangeKey: rangeKey ?? null,
        fields: { ...fields },
      });
    },
    async updateRecord({ schemaHash, fields, keyHash, rangeKey }) {
      const table = tableFor(schemaHash);
      const key = storeKey(keyHash, rangeKey);
      table.set(key, {
        keyHash,
        rangeKey: rangeKey ?? null,
        fields: { ...table.get(key)?.fields, ...fields },
      });
    },
    async deleteRecord({ schemaHash, keyHash, rangeKey }) {
      tableFor(schemaHash).delete(storeKey(keyHash, rangeKey));
    },
    async queryAll({ schemaHash, fields, filter }): Promise<QueryResponse> {
      queries.push({ schemaHash, fields: [...(fields ?? [])] });
      const results = rowsFor(schemaHash, filter);
      return { ok: true, results, returned_count: results.length, total_count: results.length };
    },
    rawCall: notImpl("rawCall") as NodeClient["rawCall"],
    nodeTransport: () => ({ transport: "unavailable" as const }),
    rows(schemaHash: string) {
      return [...tableFor(schemaHash).values()];
    },
    queryLog() {
      return queries;
    },
  };
}

const SLUG = "archived-card";
const MILESTONE = "ms-1";
const COLUMN = "done";
const POSITION = "7";

/** Seed the Card record plus both membership rows, as a live card would look. */
async function seedLiveCard(node: NodeClient): Promise<void> {
  await node.createRecord({
    schemaHash: CARD_HASH,
    keyHash: SLUG,
    fields: {
      slug: SLUG,
      title: "Archived card",
      board: "default",
      column: COLUMN,
      position: POSITION,
      milestone: MILESTONE,
    },
  });
  await node.createRecord({
    schemaHash: BOARD_CARDS_HASH,
    keyHash: "default",
    rangeKey: boardCardSk(COLUMN, POSITION, SLUG),
    fields: {
      board: "default",
      sk: boardCardSk(COLUMN, POSITION, SLUG),
      slug: SLUG,
      title: "Archived card",
      column: COLUMN,
      position: POSITION,
      milestone: MILESTONE,
      layout: BOARD_CARDS_LAYOUT,
    },
  });
  await node.createRecord({
    schemaHash: MILESTONE_CARDS_HASH,
    keyHash: MILESTONE,
    rangeKey: milestoneCardSk(COLUMN, POSITION, SLUG),
    fields: {
      milestone: MILESTONE,
      sk: milestoneCardSk(COLUMN, POSITION, SLUG),
      slug: SLUG,
      title: "Archived card",
      column: COLUMN,
      position: POSITION,
      layout: MILESTONE_CARDS_LAYOUT,
    },
  });
}

/**
 * Exactly what `listCardsByColumn(..., ARCHIVE_AGE_FIELDS, ...)` returns: the
 * BoardCards spine plus the age fields, and `milestone` reads back as "" —
 * because it was never asked for, not because the card lacks one.
 */
function thinArchiveCard(): Card {
  return {
    slug: SLUG,
    title: "Archived card",
    body: "",
    board: "default",
    column: COLUMN,
    position: POSITION,
    assignee: "",
    tags: [],
    deps: [],
    created_at: "2026-01-01T00:00:00.000Z",
    created_by: "",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...emptyStructuredFields(),
    kind: "pr",
    repo: "",
    milestone: "",
  };
}

const milestoneRowsFor = (node: ReturnType<typeof fakeStoreNode>) =>
  node.rows(MILESTONE_CARDS_HASH).filter((r) => r.fields.slug === SLUG);
const boardRowsFor = (node: ReturnType<typeof fakeStoreNode>) =>
  node.rows(BOARD_CARDS_HASH).filter((r) => r.fields.slug === SLUG);

describe("deleteCardRecord milestone provenance", () => {
  test("a thin card (archive-done / board rm) still retires its MilestoneCards row", async () => {
    const node = fakeStoreNode();
    await seedLiveCard(node);
    expect(milestoneRowsFor(node)).toHaveLength(1);

    // archive-done hands over a card whose `milestone` is "" only because the
    // projection omitted it. The delete must not read that as "no membership".
    await deleteCardRecord({ cfg, node }, thinArchiveCard());

    expect(node.rows(CARD_HASH)).toHaveLength(0);
    expect(boardRowsFor(node)).toHaveLength(0);
    expect(milestoneRowsFor(node)).toHaveLength(0);
  });

  test("a fully-hydrated card (rm) still retires its MilestoneCards row", async () => {
    const node = fakeStoreNode();
    await seedLiveCard(node);

    await deleteCardRecord({ cfg, node }, { ...thinArchiveCard(), milestone: MILESTONE });

    expect(node.rows(CARD_HASH)).toHaveLength(0);
    expect(boardRowsFor(node)).toHaveLength(0);
    expect(milestoneRowsFor(node)).toHaveLength(0);
  });

  test("a card that genuinely has no milestone costs no MilestoneCards writes", async () => {
    const node = fakeStoreNode();
    await node.createRecord({
      schemaHash: CARD_HASH,
      keyHash: SLUG,
      fields: {
        slug: SLUG,
        title: "No milestone",
        board: "default",
        column: COLUMN,
        position: POSITION,
        milestone: "",
      },
    });
    await node.createRecord({
      schemaHash: BOARD_CARDS_HASH,
      keyHash: "default",
      rangeKey: boardCardSk(COLUMN, POSITION, SLUG),
      fields: {
        board: "default",
        sk: boardCardSk(COLUMN, POSITION, SLUG),
        slug: SLUG,
        title: "No milestone",
        column: COLUMN,
        position: POSITION,
        layout: BOARD_CARDS_LAYOUT,
      },
    });

    await deleteCardRecord({ cfg, node }, thinArchiveCard());

    expect(node.rows(CARD_HASH)).toHaveLength(0);
    expect(node.rows(MILESTONE_CARDS_HASH)).toHaveLength(0);
  });

  test("the provenance read is narrow — it must not hydrate the whole card", async () => {
    const node = fakeStoreNode();
    await seedLiveCard(node);
    await deleteCardRecord({ cfg, node }, thinArchiveCard());

    const cardReads = node.queryLog().filter((q) => q.schemaHash === CARD_HASH);
    expect(cardReads.length).toBeGreaterThan(0);
    for (const read of cardReads) {
      expect(read.fields).not.toContain("body");
      expect(read.fields.length).toBeLessThanOrEqual(6);
    }
  });

  /**
   * The read ADDS the partition the caller could not name; it does not overrule
   * one the caller did. A card whose milestone was cleared can still have a
   * stale row under the old milestone — the caller's object is the only thing
   * that remembers it, and discarding that hint trades one orphan for another.
   */
  test("a stale caller milestone is retired too, not overruled by the Card record", async () => {
    const node = fakeStoreNode();
    // Card record: milestone cleared. Index: a row still sits under the old one.
    await node.createRecord({
      schemaHash: CARD_HASH,
      keyHash: SLUG,
      fields: {
        slug: SLUG,
        title: "Cleared milestone",
        board: "default",
        column: COLUMN,
        position: POSITION,
        milestone: "",
      },
    });
    await node.createRecord({
      schemaHash: MILESTONE_CARDS_HASH,
      keyHash: "ms-old",
      rangeKey: milestoneCardSk(COLUMN, POSITION, SLUG),
      fields: {
        milestone: "ms-old",
        sk: milestoneCardSk(COLUMN, POSITION, SLUG),
        slug: SLUG,
        column: COLUMN,
        position: POSITION,
        layout: MILESTONE_CARDS_LAYOUT,
      },
    });

    await deleteCardRecord({ cfg, node }, { ...thinArchiveCard(), milestone: "ms-old" });

    expect(milestoneRowsFor(node)).toHaveLength(0);
  });

  test("an already-absent Card falls back to the caller's card, it does not throw", async () => {
    const node = fakeStoreNode();
    // Membership rows with no Card behind them — the state the old bug leaves.
    await node.createRecord({
      schemaHash: MILESTONE_CARDS_HASH,
      keyHash: MILESTONE,
      rangeKey: milestoneCardSk(COLUMN, POSITION, SLUG),
      fields: {
        milestone: MILESTONE,
        sk: milestoneCardSk(COLUMN, POSITION, SLUG),
        slug: SLUG,
        column: COLUMN,
        position: POSITION,
        layout: MILESTONE_CARDS_LAYOUT,
      },
    });

    await deleteCardRecord({ cfg, node }, { ...thinArchiveCard(), milestone: MILESTONE });
    expect(milestoneRowsFor(node)).toHaveLength(0);
  });
});
