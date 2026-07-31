/**
 * LastDB projection semantics, and the two places they bite fkanban.
 *
 * A LastDB query returns a row only when EVERY projected field has an atom on
 * that row. A field missing from the SCHEMA is a loud `unknown_fields` error; a
 * field missing from a ROW is a silent drop of the whole row — no error, no
 * null, the row is simply not in `results`. So a wide projection is not a
 * superset read, it is a filter.
 *
 * Measured on the live board 2026-07-30, after the multi-key catalog expand
 * added `milestone` to BoardCards without backfilling it:
 *
 *   HashKey=default, project ["slug"]              -> 896 rows
 *   HashKey=default, project ["slug","milestone"]  -> 761 rows
 *
 * Two consequences, both tested here:
 *
 *   1. `board-cards-heal` enumerated through the wide read, so the 58 orphan
 *      rows in that gap were invisible to the ONLY code path allowed to delete
 *      orphans. It reported `missing_card: 0` against a partition that had 58.
 *
 *   2. Worse: heal decides "orphan" from a wide point-read of Card. A live card
 *      missing one field reads as absent — and that branch DELETES board
 *      membership. A sparse card would have been silently swept off the board.
 *
 * The fake node below models the drop faithfully; that is the whole point of
 * it. A fake that ignores `fields` cannot reproduce either bug.
 */
import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config.ts";
import { fakeNode, type FakeNode } from "./fake-node.ts";
import {
  boardCardSk,
  listBoardCardsPartition,
  listBoardCardsPartitionSpine,
} from "../src/board-cards.ts";
import { boardCardsHealResult } from "../src/commands/board_cards_heal.ts";
import { cardExists, emptyStructuredFields, type Card } from "../src/record.ts";
import { BOARD_CARDS_LAYOUT } from "../src/schemas.ts";

const CARD_HASH = "card-hash";
const BOARD_HASH = "board-hash";
const BOARD_CARDS_HASH = "board-cards-hash";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://127.0.0.1:9",
  userHash: "user",
  schemaServiceUrl: "http://127.0.0.1:9",
  schemaHashes: {
    board: BOARD_HASH,
    card: CARD_HASH,
    board_cards: BOARD_CARDS_HASH,
  },
};

/**
 * A node that drops rows the way LastDB does.
 *
 * The ONE rule that matters — a row is returned only if every requested field
 * is present on it; absent is absent, not empty string, not null — now lives
 * in the shared fake (`test/fake-node.ts`) and is the default for every test
 * in the suite. This is a thin seeding wrapper over it, kept because these
 * tests are written in terms of "cards and boardCards as stored".
 */
function projectionFaithfulNode(seed: {
  cards: Array<Record<string, unknown>>;
  boardCards: Array<Record<string, unknown>>;
}): FakeNode {
  const node = fakeNode({ baseUrl: cfg.nodeUrl, userHash: cfg.userHash });

  for (const c of seed.cards) {
    node.seed({ schemaHash: CARD_HASH, keyHash: String(c.slug), fields: c });
  }
  for (const r of seed.boardCards) {
    node.seed({
      schemaHash: BOARD_CARDS_HASH,
      keyHash: String(r.board),
      rangeKey: String(r.sk),
      fields: r,
    });
  }
  node.seed({
    schemaHash: BOARD_HASH,
    keyHash: "default",
    fields: { slug: "default", title: "Default", body: "", columns: [], created_at: "", updated_at: "" },
  });

  return node;
}

function fullCard(partial: Partial<Card> = {}): Card {
  return {
    slug: "healthy",
    title: "Healthy card",
    body: "",
    board: "default",
    column: "todo",
    position: "10",
    assignee: "",
    tags: [],
    deps: [],
    created_at: "2026-01-01T00:00:00.000Z",
    created_by: "test",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...emptyStructuredFields(),
    kind: "pr",
    repo: "EdgeVector/fkanban",
    ...partial,
  } as Card;
}

/** A BoardCards row carrying every field the wide read projects. */
function fullRow(card: Card): Record<string, unknown> {
  return {
    board: card.board,
    sk: boardCardSk(card.column, card.position, card.slug),
    slug: card.slug,
    title: card.title,
    column: card.column,
    position: card.position,
    assignee: "",
    tags: [],
    deps: [],
    surfaces: [],
    created_at: card.created_at,
    created_by: "test",
    updated_at: card.updated_at,
    db: "",
    repo: card.repo,
    base: "",
    kind: card.kind,
    block_status: "",
    block_reason: "",
    north_star: "",
    milestone: "",
    pr_url: "",
    branch: "",
    layout: BOARD_CARDS_LAYOUT,
  };
}

/** The same row as written BEFORE `milestone` existed — the live board's shape. */
function sparseRow(card: Card): Record<string, unknown> {
  const row = fullRow(card);
  delete row.milestone;
  return row;
}

describe("LastDB drops rows missing a projected field", () => {
  test("the wide partition read loses a sparse row; the spine read does not", async () => {
    const visible = fullCard({ slug: "visible" });
    const sparse = fullCard({ slug: "sparse", position: "20" });
    const node = projectionFaithfulNode({
      cards: [fullRow(visible), fullRow(sparse)].map((r) => ({ ...r, body: "" })),
      boardCards: [fullRow(visible), sparseRow(sparse)],
    });

    const wide = await listBoardCardsPartition(node, cfg, "default");
    const spine = await listBoardCardsPartitionSpine(node, cfg, "default");

    expect(wide!.map((c) => c.slug)).toEqual(["visible"]);
    expect(spine!.map((r) => r.slug).sort()).toEqual(["sparse", "visible"]);
    // The gap is the bug: one row exists that no wide reader can see.
    expect(spine!.length - wide!.length).toBe(1);
  });

  test("the spine trusts the range key over the copied column/position fields", async () => {
    const card = fullCard({ slug: "moved", column: "doing", position: "70" });
    const row = sparseRow(card);
    // Copied scalars drift; `sk` is the row's address and cannot.
    row.column = "todo";
    row.position = "10";
    const node = projectionFaithfulNode({ cards: [], boardCards: [row] });

    const spine = await listBoardCardsPartitionSpine(node, cfg, "default");
    expect(spine![0]).toMatchObject({ slug: "moved", column: "doing", position: "70" });
  });
});

describe("board-cards-heal and the rows it could not see", () => {
  test("heal now finds the orphan the wide read hid (was: missing_card 0)", async () => {
    const live = fullCard({ slug: "live-card" });
    const orphan = fullCard({ slug: "orphan-card", position: "20" });
    const node = projectionFaithfulNode({
      // `orphan-card` has NO Card record — only a leftover membership row,
      // and that row is sparse, so the wide partition read cannot see it.
      cards: [{ ...fullRow(live), body: "" }],
      boardCards: [fullRow(live), sparseRow(orphan)],
    });

    const { report: res } = await boardCardsHealResult({ cfg, node, apply: true });

    expect(res.missing_card).toBe(1);
    expect(res.actions.some((a) => a.action === "delete-orphan" && a.slug === "orphan-card")).toBe(true);
    // And it is actually gone from the partition afterwards.
    const left = node.rowsOf(BOARD_CARDS_HASH).map((r) => r.fields.slug);
    expect(left).not.toContain("orphan-card");
    expect(left).toContain("live-card");
  });

  test("a LIVE card whose Card record is sparse is NOT reaped as an orphan", async () => {
    const live = fullCard({ slug: "live-card" });
    // This card exists, but its Card record is missing `milestone` — so the
    // wide point-read heal uses returns nothing for it, exactly as it would for
    // a deleted card. Deleting its membership would drop a real card off the
    // board with no error anywhere.
    const sparseCardRecord: Record<string, unknown> = { ...fullRow(live), body: "" };
    delete sparseCardRecord.milestone;

    const node = projectionFaithfulNode({
      cards: [sparseCardRecord],
      boardCards: [fullRow(live)],
    });

    // Precondition: the card IS there, but only a key-only projection proves it.
    expect(await cardExists(node, cfg, "live-card")).toBe(true);

    const { report: res } = await boardCardsHealResult({ cfg, node, apply: true });

    expect(res.missing_card).toBe(0);
    expect(res.actions.some((a) => a.action === "delete-orphan")).toBe(false);
    // The membership row survives — the card stays on the board.
    expect(node.rowsOf(BOARD_CARDS_HASH).map((r) => r.fields.slug)).toContain("live-card");
  });
});
