// A write that hits the client deadline mid-flight leaves a card whose fields
// landed and whose OTHER fields did not — measured on the live primary
// 2026-07-28 (body/column/milestone written, title and board EMPTY). See
// papercut-kanban-write-timeout-leaves-a-partially-written-card.
//
// The card is then unrepairable by the exact retry the timeout hint recommends,
// because `add` reads the stored placement with `??`: an empty stored `board`
// is not nullish, so it wins over the `"default"` fallback and is then
// validated as if it were a real board slug. Same for `column` vs the board's
// first column. Both are the card's BoardCards partition/range key, so an
// empty one also means the card has no membership row and cannot be listed.
//
// A stored "" placement is the ABSENCE of a placement, not a placement named
// "". These tests pin that.

import { describe, expect, test } from "bun:test";
import type { NodeClient } from "../src/client.ts";
import { fakeNode } from "./fake-node.ts";
import type { Config } from "../src/config.ts";
import {
  boardToFields,
  cardToFields,
  ensureBoardRecord,
  findCard,
  listBoards,
  nowIso,
  type Card,
} from "../src/record.ts";
import { addCmd } from "../src/commands/add.ts";
import { milestoneAddCmd } from "../src/commands/milestone.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash", milestone: "milestonehash" },
  enforceLivePrMilestone: true,
};

const BRIEF = "## GOAL\nship the thing\n## END STATE\nthe thing is shipped\n";

async function seedBoard(node: NodeClient): Promise<void> {
  const now = nowIso();
  await node.createRecord({
    schemaHash: cfg.schemaHashes.board!,
    keyHash: "default",
    fields: boardToFields({
      slug: "default",
      title: "Default",
      body: "",
      columns: [...DEFAULT_COLUMNS],
      created_at: now,
      updated_at: now,
    }),
  });
}

/**
 * The exact shape the primary was left in by the timed-out write: body, column
 * and milestone landed; `title` and `board` did not.
 */
async function seedPartiallyWrittenCard(
  node: NodeClient,
  slug: string,
  overrides: Partial<Card> = {},
): Promise<void> {
  const now = nowIso();
  const card: Card = {
    slug,
    title: "", // ← dropped by the deadline
    body: BRIEF,
    board: "", // ← dropped by the deadline
    column: "todo",
    position: "1000",
    assignee: "",
    tags: [],
    deps: [],
    surfaces: [],
    created_at: now,
    updated_at: now,
    kind: "pr",
    repo: "EdgeVector/fkanban",
    base: "main",
    milestone: "",
    ...overrides,
  } as Card;
  await node.createRecord({
    schemaHash: cfg.schemaHashes.card!,
    keyHash: slug,
    fields: cardToFields(card),
  });
}

describe("recovering a card left partial by a timed-out write", () => {
  test("re-running the same add repairs an empty stored board", async () => {
    const node = fakeNode();
    await seedBoard(node);
    await seedPartiallyWrittenCard(node, "partial-board");

    // The retry the timeout hint tells the agent to run — no explicit --board,
    // because none was needed to create the card in the first place.
    const res = await addCmd({
      cfg,
      node,
      slug: "partial-board",
      title: "Partial board",
      kind: "pr",
      column: "todo",
      repo: "EdgeVector/fkanban",
      base: "main",
      body: BRIEF,
      force: true,
    });

    expect(res.board).toBe("default");
    const stored = await findCard(node, cfg, "partial-board");
    expect(stored?.board).toBe("default");
    expect(stored?.title).toBe("Partial board");
  });

  test("an empty stored board does not fail its own milestone's board check", async () => {
    const node = fakeNode();
    await seedBoard(node);
    await milestoneAddCmd({
      cfg,
      node,
      slug: "ms-partial",
      title: "MS",
      board: "default",
      body: "## GOAL\nx\n## END STATE\ny\n",
    });
    await seedPartiallyWrittenCard(node, "partial-milestone", { milestone: "ms-partial" });

    // Pre-fix this threw milestone_board_mismatch:
    //   Card board "" does not match milestone "ms-partial" (default).
    // — an error about a board the card does not have, on the retry the
    // previous error demanded.
    const res = await addCmd({
      cfg,
      node,
      slug: "partial-milestone",
      title: "Partial milestone",
      kind: "pr",
      column: "todo",
      repo: "EdgeVector/fkanban",
      base: "main",
      milestone: "ms-partial",
      body: BRIEF,
      force: true,
    });

    expect(res.board).toBe("default");
    expect((await findCard(node, cfg, "partial-milestone"))?.board).toBe("default");
  });

  test("an empty stored column falls back to the board's first column", async () => {
    const node = fakeNode();
    await seedBoard(node);
    await seedPartiallyWrittenCard(node, "partial-column", { column: "" });

    // No --column on the retry: pre-fix `existing.column` ("") won over the
    // board's first column and ensureColumn rejected it as invalid_column.
    const res = await addCmd({
      cfg,
      node,
      slug: "partial-column",
      title: "Partial column",
      body: BRIEF,
      force: true,
    });

    expect(res.column).toBe(DEFAULT_COLUMNS[0]);
    expect((await findCard(node, cfg, "partial-column"))?.column).toBe(DEFAULT_COLUMNS[0]);
  });

  test("ensureBoardRecord refuses to mint a board from an empty slug", async () => {
    const node = fakeNode();
    await seedBoard(node);
    // A damaged card pointing at board "" is exactly the evidence the self-heal
    // path consults. It must not count: the response to data damage cannot be
    // materializing a board whose slug is "".
    await seedPartiallyWrittenCard(node, "damaged");
    await expect(ensureBoardRecord(node, cfg, "")).rejects.toThrow(/Board "" does not exist/);
    const boards = await listBoards(node, cfg);
    expect(boards.map((b) => b.slug)).toEqual(["default"]);
  });

  test("an explicit --board \"\" is not a placement", async () => {
    const node = fakeNode();
    await seedBoard(node);
    const res = await addCmd({
      cfg,
      node,
      slug: "explicit-empty",
      title: "Explicit empty",
      board: "",
      body: BRIEF,
      force: true,
    });
    expect(res.board).toBe("default");
  });

  test("an explicit --board still wins over a healthy stored board", async () => {
    const node = fakeNode();
    await seedBoard(node);
    const now = nowIso();
    await node.createRecord({
      schemaHash: cfg.schemaHashes.board!,
      keyHash: "other",
      fields: boardToFields({
        slug: "other",
        title: "Other",
        body: "",
        columns: [...DEFAULT_COLUMNS],
        created_at: now,
        updated_at: now,
      }),
    });
    await seedPartiallyWrittenCard(node, "healthy", { board: "other", title: "Healthy" });

    // Regression guard for the fix: honoring a NON-empty stored board, and
    // letting an explicit --board move the card, must both still work.
    const kept = await addCmd({ cfg, node, slug: "healthy", body: BRIEF, force: true });
    expect(kept.board).toBe("other");

    const moved = await addCmd({
      cfg,
      node,
      slug: "healthy",
      board: "default",
      body: BRIEF,
      force: true,
    });
    expect(moved.board).toBe("default");
  });
});
