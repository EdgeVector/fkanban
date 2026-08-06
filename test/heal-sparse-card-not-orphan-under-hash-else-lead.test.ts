/**
 * COMPOUND PREVENTION — papercut-kanban-cardexists-cites-superseded-projection-rule
 *
 * Failure invariant: a membership heal must not treat a sparse-but-present Card
 * as ABSENT based on superseded `any_missing` semantics while the node uses
 * HASH-ELSE-LEAD.
 *
 * Components: fake-node projection default → Card wide read / findCard →
 * cardExists → board_cards_heal delete-orphan authorization.
 *
 * Under the measured rule (Card hash = `slug`), a row with only a few atoms
 * still returns from the full product projection. Heal must therefore KEEP
 * membership (noop-match / drift repair), never delete-orphan, solely because
 * optional fields are empty. The husk (hash-only post-delete) is the only shape
 * where cardExists vetoes a wide miss — covered in
 * `card-wide-read-keeps-sparse-rows.test.ts` and `delete-husk-row-is-not-a-card.test.ts`.
 *
 * Red-before: if the fake default flipped to `any_missing` OR heal reaped on a
 * sparse wide miss without cardExists, this file fails.
 */
import { describe, expect, test } from "bun:test";

import { fakeNode, type FakeNode } from "./fake-node.ts";
import type { Config } from "../src/config.ts";
import { boardCardsHealResult } from "../src/commands/board_cards_heal.ts";
import {
  boardToFields,
  cardExists,
  findCard,
  nowIso,
  type Card,
} from "../src/record.ts";
import { boardCardFieldsFromCard, boardCardSk } from "../src/board-cards.ts";
import { CARD_FIELDS, DEFAULT_COLUMNS } from "../src/schemas.ts";

const CARD_HASH = "cardhash";
const BOARD_HASH = "boardhash";
const BOARD_CARDS_HASH = "boardcardshash";
const BOARD = "default";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: {
    card: CARD_HASH,
    board: BOARD_HASH,
    board_cards: BOARD_CARDS_HASH,
  },
};

/** Live witness shape from scripts/probe-card-projection-sparse.ts (5 of 23). */
const SPARSE_FIELDS = {
  slug: "sparse-live",
  title: "sparse title",
  board: BOARD,
  column: "todo",
  position: "m",
};

function seedBoard(node: FakeNode) {
  const now = nowIso();
  node.seed({
    schemaHash: BOARD_HASH,
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
}

function memberSparse(node: FakeNode) {
  // Membership row is whole; the Card plane is deliberately sparse.
  const summary = {
    slug: SPARSE_FIELDS.slug,
    title: SPARSE_FIELDS.title,
    board: BOARD,
    column: "todo",
    position: "m",
    assignee: "",
    tags: [] as string[],
    deps: [] as string[],
    surfaces: [] as string[],
    created_at: nowIso(),
    updated_at: nowIso(),
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
  } as Card;
  node.seed({
    schemaHash: BOARD_CARDS_HASH,
    keyHash: BOARD,
    rangeKey: boardCardSk(summary.column, summary.position, summary.slug),
    fields: boardCardFieldsFromCard(summary),
  });
}

describe("compound: sparse Card under hash_else_lead is not an orphan", () => {
  test("fake default is hash_else_lead (regression if flipped to any_missing)", () => {
    const node = fakeNode({ hashFields: { [CARD_HASH]: "slug" } });
    expect(node.projectionRule).toBe("hash_else_lead");
  });

  test("product projection returns a sparse Card; cardExists agrees", async () => {
    const node = fakeNode({ hashFields: { [CARD_HASH]: "slug" } });
    node.seed({
      schemaHash: CARD_HASH,
      keyHash: SPARSE_FIELDS.slug,
      fields: SPARSE_FIELDS,
    });

    // Full product field list — this is the path heal/findCard use.
    const wide = await node.queryAll({
      schemaHash: CARD_HASH,
      fields: [...CARD_FIELDS],
      filter: { HashKey: SPARSE_FIELDS.slug },
    });
    expect(wide.results.length).toBe(1);
    expect(wide.results[0]!.fields.slug).toBe(SPARSE_FIELDS.slug);
    // Non-gate absence stays absent on the raw row (no assignee atom).
    expect("assignee" in wide.results[0]!.fields).toBe(false);

    expect(await findCard(node, cfg, SPARSE_FIELDS.slug)).not.toBeNull();
    expect(await cardExists(node, cfg, SPARSE_FIELDS.slug)).toBe(true);
  });

  test("under any_missing the same sparse row would drop — pins the divergence", async () => {
    const node = fakeNode({
      projectionRule: "any_missing",
      hashFields: { [CARD_HASH]: "slug" },
    });
    node.seed({
      schemaHash: CARD_HASH,
      keyHash: SPARSE_FIELDS.slug,
      fields: SPARSE_FIELDS,
    });

    const wide = await node.queryAll({
      schemaHash: CARD_HASH,
      fields: [...CARD_FIELDS],
      filter: { HashKey: SPARSE_FIELDS.slug },
    });
    // Superseded model eats the row; hash_else_lead does not (test above).
    expect(wide.results.length).toBe(0);
  });

  test("board_cards_heal dry-run does not delete-orphan a sparse live card", async () => {
    const node = fakeNode({
      hashFields: {
        [CARD_HASH]: "slug",
        // BoardCards live catalog gate after multi-key expand; leave unset for
        // lead fallback on complete membership rows so the partition lists them.
      },
    });
    seedBoard(node);
    memberSparse(node);
    node.seed({
      schemaHash: CARD_HASH,
      keyHash: SPARSE_FIELDS.slug,
      fields: SPARSE_FIELDS,
    });

    const { report } = await boardCardsHealResult({
      cfg,
      node,
      board: BOARD,
      json: true,
      apply: false,
    });

    const forSlug = report.actions.filter((a) => a.slug === SPARSE_FIELDS.slug);
    expect(forSlug.length).toBeGreaterThan(0);
    // The failure invariant is specifically "not reaped as orphan". Sparse
    // Cards may still need thin-field refresh or column drift repair — those
    // keep membership. delete-orphan is the only action that removes it.
    expect(forSlug.every((a) => a.action !== "delete-orphan")).toBe(true);
    expect(forSlug.map((a) => a.action)).not.toContain("delete-orphan");
  });

  test("heal still reaps a true orphan (control — sparse guard did not disable deletes)", async () => {
    const node = fakeNode({ hashFields: { [CARD_HASH]: "slug" } });
    seedBoard(node);
    const ghost = {
      slug: "ghost-orphan",
      title: "ghost",
      board: BOARD,
      column: "todo",
      position: "z",
      assignee: "",
      tags: [] as string[],
      deps: [] as string[],
      surfaces: [] as string[],
      created_at: nowIso(),
      updated_at: nowIso(),
      kind: "pr",
      priority: "",
      block_status: "none",
      block_reason: "",
      north_star: "",
      milestone: "",
      repo: "",
      base: "",
      pr_url: "",
      branch: "",
    } as Card;
    node.seed({
      schemaHash: BOARD_CARDS_HASH,
      keyHash: BOARD,
      rangeKey: boardCardSk(ghost.column, ghost.position, ghost.slug),
      fields: boardCardFieldsFromCard(ghost),
    });
    // No Card plane row for ghost-orphan.

    const { report } = await boardCardsHealResult({
      cfg,
      node,
      board: BOARD,
      json: true,
      apply: false,
    });

    const orphanActions = report.actions.filter(
      (a) => a.slug === "ghost-orphan" && a.action === "delete-orphan",
    );
    expect(orphanActions.length).toBe(1);
  });
});
