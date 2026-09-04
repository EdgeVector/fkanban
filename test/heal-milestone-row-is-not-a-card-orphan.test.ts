// `board-cards-heal` must not delete BoardMilestones rows as card orphans.
//
// WHY A MILESTONE ROW IS IN THE BOARDCARDS PARTITION AT ALL. `BoardMilestones`
// and `BoardCards` are both `HashRange` keyed
// `{hash_field: "board", range_field: "sk"}`, and their sk grammars are the same
// shape: `<segment>#<position(8)>#<slug>`, where the segment is a board COLUMN
// for a card and a milestone STATE for a milestone. They are separate
// identities today. They were not in July 2026: the declare-resolver expand bug
// collapsed `BoardMilestones_hashrange_v1_portfolio_20260723` onto
// `BoardCards_hashrange_v1`, and the milestones written in that window are still
// in the identity `board_cards` pins (`1ef2e7a3…`).
//
// So heal enumerates them, point-reads Card by slug, finds nothing, and reads
// that as an orphan. Measured on the live `default` board 2026-09-04: of 198
// rows classified `delete-orphan`, 29 were live milestones — `kanban milestone
// show` renders them, `kanban show` does not. `--apply` runs hourly from
// `last-stack-fkanban-watch`, so that plan was armed.
//
// THE DISCRIMINATOR TAKES BOTH HALVES, and the two negative cases below are why:
//
//   - state segment alone is not enough — a board may declare a column named
//     `active`, and a slug with rows under a real board column is a card
//     question whatever else it has;
//   - a Milestone record alone is not enough — a dead `complete#…#slug` row
//     would then be unreapable forever, trading a silent wrong delete for a
//     silent wrong keep.

import { describe, expect, test } from "bun:test";

import { fakeNode, type FakeNode } from "./fake-node.ts";
import type { Config } from "../src/config.ts";
import { boardCardsHealResult } from "../src/commands/board_cards_heal.ts";
import {
  boardToFields,
  cardToFields,
  milestoneToFields,
  nowIso,
  type Card,
  type Milestone,
} from "../src/record.ts";
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
    milestone: "milestonehash",
  },
};

const BOARD = "default";

function card(slug: string, column: string, position: string): Card {
  const now = nowIso();
  return {
    slug,
    title: slug,
    body: "",
    board: BOARD,
    column,
    position,
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

function milestone(slug: string, state: string): Milestone {
  const now = nowIso();
  return {
    slug,
    title: slug,
    body: "",
    board: BOARD,
    state,
    position: "1",
    north_star: "",
    driver: "",
    deps: [],
    proof_card: "",
    proof_status: "",
    block_reason: "",
    created_at: now,
    updated_at: now,
    completed_at: "",
  };
}

function seedBoard(): FakeNode {
  const node = fakeNode();
  const now = nowIso();
  node.seed({
    schemaHash: "boardhash",
    keyHash: BOARD,
    fields: boardToFields({
      slug: BOARD,
      title: BOARD,
      body: "",
      columns: [...DEFAULT_COLUMNS],
      created_at: now,
      updated_at: now,
    }),
  });
  return node;
}

/** Seed a BoardCards membership row for `slug` under sk segment `segment`. */
function member(node: FakeNode, slug: string, segment: string, position: string) {
  const c = card(slug, segment, position);
  node.seed({
    schemaHash: "boardcardshash",
    keyHash: BOARD,
    rangeKey: boardCardSk(segment, position, slug),
    fields: boardCardFieldsFromCard(c),
  });
}

const heal = (node: FakeNode, apply = false) =>
  boardCardsHealResult({ cfg, node, board: BOARD, json: true, apply });

const actionFor = (
  actions: { slug: string; action: string }[],
  slug: string,
): string | undefined => actions.find((a) => a.slug === slug)?.action;

describe("board-cards-heal: a milestone row is not a card orphan", () => {
  test("state-keyed row with a Milestone record is skipped, not deleted", async () => {
    const node = seedBoard();
    member(node, "ms-live", "active", "1");
    node.seed({
      schemaHash: "milestonehash",
      keyHash: "ms-live",
      fields: milestoneToFields(milestone("ms-live", "active")),
    });

    const { report, text } = await heal(node);

    expect(actionFor(report.actions, "ms-live")).toBe("skip-milestone-membership");
    expect(report.milestone_rows_skipped).toBe(1);
    // Not orphan drift: the row is healthy for the index it belongs to.
    expect(report.missing_card).toBe(0);
    expect(report.would_heal).toBe(0);
    // And not removal intent, so it cannot push a legitimate reap into the
    // ceiling refusal.
    expect(report.removals_possible).toBe(0);
    expect(text).toContain("MILESTONE ROWS");
  });

  test("--apply writes nothing for it", async () => {
    const node = seedBoard();
    member(node, "ms-live", "complete", "1");
    node.seed({
      schemaHash: "milestonehash",
      keyHash: "ms-live",
      fields: milestoneToFields(milestone("ms-live", "complete")),
    });

    const { report } = await heal(node, true);

    expect(report.blocked).toBeFalsy();
    expect(report.healed).toBe(0);
    // Asserted by ADDRESS, not by batch count: the janitor queue behind
    // `--apply` is module-level, so a sibling test file's enqueue is swept by
    // whichever apply runs next and the count is not this test's to own.
    expect(node.deleteBatches.flat()).not.toContain("complete#00000001#ms-live");
    expect(node.rowAt("boardcardshash", BOARD, "complete#00000001#ms-live")).toBeDefined();
  });

  test("state-keyed row with NO Milestone record is still reaped", async () => {
    const node = seedBoard();
    member(node, "ghost-state-row", "complete", "1");

    const { report } = await heal(node);

    expect(actionFor(report.actions, "ghost-state-row")).toBe("delete-orphan");
    expect(report.milestone_rows_skipped).toBe(0);
    expect(report.missing_card).toBe(1);
  });

  test("board-column row is still reaped even when a Milestone shares the slug", async () => {
    const node = seedBoard();
    member(node, "shared-slug", "todo", "1");
    node.seed({
      schemaHash: "milestonehash",
      keyHash: "shared-slug",
      fields: milestoneToFields(milestone("shared-slug", "active")),
    });

    const { report } = await heal(node);

    expect(actionFor(report.actions, "shared-slug")).toBe("delete-orphan");
    expect(report.milestone_rows_skipped).toBe(0);
  });

  test("a slug with both a state row and a board-column row is a card question", async () => {
    const node = seedBoard();
    member(node, "mixed", "active", "1");
    member(node, "mixed", "todo", "2");
    node.seed({
      schemaHash: "milestonehash",
      keyHash: "mixed",
      fields: milestoneToFields(milestone("mixed", "active")),
    });

    const { report } = await heal(node);

    expect(actionFor(report.actions, "mixed")).toBe("delete-orphan");
    expect(report.milestone_rows_skipped).toBe(0);
  });

  test("a live card is unaffected by the milestone branch", async () => {
    const node = seedBoard();
    const c = card("live-card", "todo", "1");
    node.seed({
      schemaHash: "boardcardshash",
      keyHash: BOARD,
      rangeKey: boardCardSk(c.column, c.position, c.slug),
      fields: boardCardFieldsFromCard(c),
    });
    node.seed({ schemaHash: "cardhash", keyHash: c.slug, fields: cardToFields(c) });

    const { report } = await heal(node);

    expect(report.milestone_rows_skipped).toBe(0);
    expect(report.missing_card).toBe(0);
    expect(report.drifted).toBe(0);
  });
});
