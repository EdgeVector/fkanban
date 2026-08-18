/**
 * The archive sweep must retire its cards in BATCHES, not one node request per
 * card.
 *
 * ## The measurement this pins
 *
 * The node splits hard erasures off a request and calls `purge_records_bulk`
 * ONCE per (schema, verb) for the whole request, and that one call runs
 * `refresh_runtime_field_molecules` once — restoring every runtime field
 * molecule for the schema. BoardCards has 24 fields and molecules are evicted
 * between requests, so the restore is paid per REQUEST, not per row.
 *
 * Measured on the live primary 2026-08-18 (`lastdb ops`, client label
 * `kanban-groom-archive-done`, `lastdbd 0.23.3-880-g2e7775fe2`): 54 archives
 * cost 108 purges and 120.2 s of materialize — 1.11 s each — all of it inside
 * the exclusive purge barrier that blocks every other writer of Card and
 * BoardCards. `DEFAULT_ARCHIVE_MAX` is 200, so a full run spent ~7.4 min/day
 * re-materializing what one batch materializes once.
 *
 * See `papercut-kanban-archive-done-purges-one-card-per-request`.
 *
 * ## What each half can independently get wrong
 *
 * 1. the sweep ASKS for a batch (fake-node `deleteBatches`), and does not
 *    quietly regress to a per-card loop that still passes every outcome
 *    assertion;
 * 2. the rows are actually GONE afterwards — Card, BoardCards AND
 *    MilestoneCards. A batch that reaps the Card and strands its membership is
 *    the silent permanent drift `delete-card-membership-provenance.test.ts`
 *    exists for, and batching is exactly where it would come back.
 */
import { describe, expect, test } from "bun:test";
import { fakeNode } from "./fake-node.ts";
import { archiveDoneResult } from "../src/commands/archive_done.ts";
import { boardCardSk } from "../src/board-cards.ts";
import { milestoneCardSk } from "../src/milestone-cards.ts";
import type { Board, Card } from "../src/record.ts";
import type { Config } from "../src/config.ts";

const CARD_HASH = "card-hash";
const BOARD_CARDS = "board-cards-hash";
const MILESTONE_CARDS = "milestone-cards-hash";

const cfg = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: {
    board: "board-hash",
    card: CARD_HASH,
    board_cards: BOARD_CARDS,
    milestone_cards: MILESTONE_CARDS,
  },
} as unknown as Config;

const NOW = Date.parse("2026-08-18T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

function card(partial: Partial<Card> & { slug: string }): Card {
  return {
    title: partial.slug,
    body: "",
    board: "default",
    column: "done",
    position: "0",
    assignee: "",
    tags: [],
    deps: [],
    surfaces: [],
    created_at: hoursAgo(500),
    created_by: "test",
    updated_at: hoursAgo(500),
    done_at: "",
    db: "",
    repo: "",
    base: "",
    kind: "",
    block_status: "",
    block_reason: "",
    north_star: "",
    milestone: "",
    pr_url: "",
    branch: "",
    ...partial,
  };
}

const board = (slug: string): Board =>
  ({
    slug,
    title: slug,
    body: "",
    columns: ["backlog", "todo", "doing", "done"],
    created_at: "",
    updated_at: "",
  }) as Board;

function node() {
  return fakeNode({
    hashFields: {
      [CARD_HASH]: "slug",
      [BOARD_CARDS]: "board",
      [MILESTONE_CARDS]: "milestone",
    },
  });
}

/**
 * Seed the three planes a real card occupies, so the sweep has something to
 * reap on each of them.
 *
 * The Card row carries `milestone` and the BoardCards row does NOT — that is
 * the real projection asymmetry (`ARCHIVE_AGE_FIELDS` omits `milestone`), and
 * seeding it any other way would let a batch that trusts the caller's thin row
 * pass a test the live node fails.
 */
function seedCard(n: ReturnType<typeof node>, c: Card) {
  n.seed({
    schemaHash: CARD_HASH,
    keyHash: c.slug,
    rangeKey: null,
    fields: {
      slug: c.slug,
      board: c.board,
      column: c.column,
      position: c.position,
      milestone: c.milestone,
    },
  });
  const sk = boardCardSk(c.column, c.position, c.slug);
  n.seed({
    schemaHash: BOARD_CARDS,
    keyHash: c.board,
    rangeKey: sk,
    fields: { board: c.board, sk, slug: c.slug, column: c.column, position: c.position },
  });
  if (c.milestone) {
    const msk = milestoneCardSk(c.column, c.position, c.slug);
    n.seed({
      schemaHash: MILESTONE_CARDS,
      keyHash: c.milestone,
      rangeKey: msk,
      fields: { milestone: c.milestone, sk: msk, slug: c.slug, column: c.column, position: c.position },
    });
  }
  return sk;
}

/** The sweep's injected readers; `remove`/`removeMany` are deliberately NOT injected. */
function sweepOpts(n: ReturnType<typeof node>, byBoardColumn: Record<string, Record<string, Card[]>>) {
  return {
    cfg,
    node: n,
    now: NOW,
    apply: true,
    boardsFor: async () => Object.keys(byBoardColumn).map(board),
    cardsIn: async (_n: unknown, _c: unknown, column: string, b: string) =>
      byBoardColumn[b]?.[column] ?? [],
    milestonesFor: async () => [],
  };
}

/** The thin row the sweep really reads — `ARCHIVE_AGE_FIELDS` carries no `milestone`. */
const thin = (c: Card): Card => ({ ...c, milestone: "" });

describe("archive-done batched deletes", () => {
  test("retires 60 cards in batched requests, not one per card", async () => {
    const n = node();
    const cards = Array.from({ length: 60 }, (_, i) =>
      card({ slug: `old-${String(i).padStart(3, "0")}`, position: String(i), updated_at: hoursAgo(100 + i) }),
    );
    for (const c of cards) seedCard(n, c);

    const { report } = await archiveDoneResult(
      sweepOpts(n, { default: { done: cards.map(thin) } }),
    );

    expect(report.archived).toBe(60);
    expect(report.failed).toBe(0);

    // The assertion that fails if this reverts to a per-card loop. Both planes
    // chunk at 48 (CARD_DELETE_BATCH / BOARD_CARDS_WRITE_BATCH), so 60 cards
    // cost 2 Card requests + 2 BoardCards requests. A per-card loop would be
    // 60 Card deletes and 60 partition spine reads.
    expect(n.deleteBatches.length).toBe(4);
    expect(n.deleteBatches.map((b) => b.length).sort((a, b) => b - a)).toEqual([48, 48, 12, 12]);

    // ...and both planes are actually empty, not merely "requested".
    for (const c of cards) {
      expect(n.rowAt(CARD_HASH, c.slug)).toBeUndefined();
      expect(n.rowAt(BOARD_CARDS, c.board, boardCardSk(c.column, c.position, c.slug))).toBeUndefined();
    }
  });

  test("reaps the MilestoneCards row the sweep's thin projection cannot name", async () => {
    const n = node();
    const c = card({ slug: "has-ms", milestone: "ms-1", updated_at: hoursAgo(100) });
    const msk = milestoneCardSk(c.column, c.position, c.slug);
    seedCard(n, c);
    expect(n.rowAt(MILESTONE_CARDS, "ms-1", msk)).toBeDefined();

    // The sweep hands over a row with NO milestone — the provenance read is the
    // only thing that can supply it.
    const { report } = await archiveDoneResult(sweepOpts(n, { default: { done: [thin(c)] } }));

    expect(report.archived).toBe(1);
    expect(n.rowAt(MILESTONE_CARDS, "ms-1", msk)).toBeUndefined();
  });

  test("groups by board: one BoardCards batch per partition, not per card", async () => {
    const n = node();
    const a = Array.from({ length: 4 }, (_, i) =>
      card({ slug: `a-${i}`, board: "alpha", position: String(i), updated_at: hoursAgo(100 + i) }),
    );
    const b = Array.from({ length: 4 }, (_, i) =>
      card({ slug: `b-${i}`, board: "beta", position: String(i), updated_at: hoursAgo(200 + i) }),
    );
    for (const c of [...a, ...b]) seedCard(n, c);

    const { report } = await archiveDoneResult(
      sweepOpts(n, { alpha: { done: a.map(thin) }, beta: { done: b.map(thin) } }),
    );

    expect(report.archived).toBe(8);
    // 1 Card batch (8 <= 48) + 1 per board partition.
    expect(n.deleteBatches.length).toBe(3);
    for (const c of [...a, ...b]) {
      expect(n.rowAt(BOARD_CARDS, c.board, boardCardSk(c.column, c.position, c.slug))).toBeUndefined();
    }
  });

  test("a rejected Card batch falls back per card, and only the bad card is failed", async () => {
    const n = node();
    const cards = ["good-1", "bad", "good-2"].map((slug, i) =>
      card({ slug, position: String(i), updated_at: hoursAgo(100 + i) }),
    );
    for (const c of cards) seedCard(n, c);

    // The node names the BATCH, never the item, so any Card-schema batch is
    // rejected here and the fallback has to ask for each card separately.
    const realDelete = n.deleteRecord.bind(n);
    // `deleteRecords` is optional on NodeClient — the fake implements it.
    const realBatch = n.deleteRecords!.bind(n);
    n.deleteRecords = async (rows) => {
      if (rows.some((r) => r.schemaHash === CARD_HASH)) throw new Error("batch rejected");
      return await realBatch(rows);
    };
    n.deleteRecord = async (row) => {
      if (row.schemaHash === CARD_HASH && row.keyHash === "bad") throw new Error("nope");
      return await realDelete(row);
    };

    const { report } = await archiveDoneResult(sweepOpts(n, { default: { done: cards.map(thin) } }));

    expect(report.archived).toBe(2);
    expect(report.failed).toBe(1);
    expect(report.actions.map((a) => [a.slug, a.action])).toEqual([
      ["good-2", "archived"],
      ["bad", "failed"],
      ["good-1", "archived"],
    ]);

    // A card whose Card record survived must KEEP its membership row: a
    // BoardCards row reaped out from under a live Card loses it from `list`
    // while `show` still finds it.
    expect(n.rowAt(CARD_HASH, "bad")).toBeDefined();
    expect(n.rowAt(BOARD_CARDS, "default", boardCardSk("done", "1", "bad"))).toBeDefined();
    for (const slug of ["good-1", "good-2"]) {
      expect(n.rowAt(CARD_HASH, slug)).toBeUndefined();
    }
  });

  test("a dry run still writes nothing at all", async () => {
    const n = node();
    const c = card({ slug: "old", updated_at: hoursAgo(100) });
    seedCard(n, c);

    const { report } = await archiveDoneResult({
      ...sweepOpts(n, { default: { done: [thin(c)] } }),
      apply: false,
    });

    expect(report.archived).toBe(0);
    expect(n.deleteBatches.length).toBe(0);
    expect(n.writes.length).toBe(0);
    expect(n.rowAt(CARD_HASH, "old")).toBeDefined();
  });
});
