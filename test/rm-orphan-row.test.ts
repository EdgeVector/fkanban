// `kanban rm <slug> --board <b> --column <c>` — delete a BoardCards row that
// has no backing Card, addressed by an operator who already knows the row's
// coordinates (from `kanban list --column <c>`, which shows the ghost, while
// `kanban show`/bare `kanban rm` both refuse it with "No card with slug").
//
// `groom board-cards-heal --slug <slug>` is the general-purpose orphan
// reaper, and it still owns DISCOVERY (finding an orphan whose board/column
// nobody named). Measured live 2026-09-06 on the real orphan
// `mini-cutover-post-flip-soak`: an unscoped heal timed out past 90s and a
// `--board default --slug ...` heal still ran past 2 minutes, because both
// pay for a whole-partition wide read, a 24-field-lead sweep, and a
// cross-board membership census meant for the "board/column unknown" case.
// This path is for the case where they ARE known: one column-scoped prefix
// read instead of all of that.

import { describe, expect, test } from "bun:test";

import { fakeNode, type FakeNode } from "./fake-node.ts";
import type { Config } from "../src/config.ts";
import { rmCmd } from "../src/commands/rm.ts";
import { boardToFields, cardToFields, milestoneToFields, nowIso, type Card, type Milestone } from "../src/record.ts";
import { boardCardFieldsFromCard, boardCardSk } from "../src/board-cards.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";
import { FkanbanError } from "../src/client.ts";

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

/** Seed a BoardCards membership row for `slug` under sk segment `segment`, no Card. */
function member(node: FakeNode, slug: string, segment: string, position: string) {
  const c = card(slug, segment, position);
  node.seed({
    schemaHash: "boardcardshash",
    keyHash: BOARD,
    rangeKey: boardCardSk(segment, position, slug),
    fields: boardCardFieldsFromCard(c),
  });
}

async function expectError(p: Promise<unknown>, code: string) {
  try {
    await p;
    throw new Error(`expected FkanbanError(${code}) but call succeeded`);
  } catch (err) {
    expect(err).toBeInstanceOf(FkanbanError);
    expect((err as FkanbanError).code).toBe(code);
  }
}

describe("rm --board --column: orphan BoardCards row deletion", () => {
  test("deletes a plain orphan row with no Card", async () => {
    const node = seedBoard();
    member(node, "orphan-1", "backlog", "1");

    const res = await rmCmd({ cfg, node, slug: "orphan-1", board: BOARD, column: "backlog" });

    expect(res.rowOnly).toBe(true);
    expect(res.deletedRows).toBe(1);
    expect(node.deleteBatches.flat()).toContain("backlog#00000001#orphan-1");
  });

  test("refuses when a live Card still exists — this path is orphan-only", async () => {
    const node = seedBoard();
    const c = card("alive", "todo", "1");
    node.seed({ schemaHash: "cardhash", keyHash: c.slug, fields: cardToFields(c) });
    member(node, "alive", "todo", "1");

    await expectError(
      rmCmd({ cfg, node, slug: "alive", board: BOARD, column: "todo" }),
      "card_exists",
    );
    // Refused before any delete was issued.
    expect(node.deleteBatches.flat()).not.toContain("todo#00000001#alive");
  });

  test("reports row_not_found when there is nothing at that address", async () => {
    const node = seedBoard();

    await expectError(
      rmCmd({ cfg, node, slug: "nothing-here", board: BOARD, column: "todo" }),
      "row_not_found",
    );
  });

  test("requires both --board and --column", async () => {
    const node = seedBoard();
    member(node, "orphan-2", "backlog", "1");

    await expectError(
      rmCmd({ cfg, node, slug: "orphan-2", board: BOARD }),
      "orphan_row_requires_board_and_column",
    );
    await expectError(
      rmCmd({ cfg, node, slug: "orphan-2", column: "backlog" }),
      "orphan_row_requires_board_and_column",
    );
  });

  test("refuses a milestone-state row backed by a live Milestone", async () => {
    const node = seedBoard();
    member(node, "ms-live", "active", "1");
    node.seed({
      schemaHash: "milestonehash",
      keyHash: "ms-live",
      fields: milestoneToFields(milestone("ms-live", "active")),
    });

    await expectError(
      rmCmd({ cfg, node, slug: "ms-live", board: BOARD, column: "active" }),
      "row_is_milestone_membership",
    );
    expect(node.deleteBatches.flat()).not.toContain("active#00000001#ms-live");
  });

  test("a milestone-state-shaped row with no Milestone record is still an orphan", async () => {
    const node = seedBoard();
    member(node, "ghost-state-row", "complete", "1");

    const res = await rmCmd({ cfg, node, slug: "ghost-state-row", board: BOARD, column: "complete" });

    expect(res.rowOnly).toBe(true);
    expect(node.deleteBatches.flat()).toContain("complete#00000001#ghost-state-row");
  });

  test("existing bare `rm <slug>` (no --board/--column) is unchanged", async () => {
    const node = seedBoard();
    const c = card("plain", "todo", "1");
    node.seed({ schemaHash: "cardhash", keyHash: c.slug, fields: cardToFields(c) });

    const res = await rmCmd({ cfg, node, slug: "plain" });

    expect(res.rowOnly).toBeUndefined();
    expect(res.slug).toBe("plain");
  });
});
