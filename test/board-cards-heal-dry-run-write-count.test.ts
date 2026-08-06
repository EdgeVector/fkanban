// `board-cards-heal`'s dry run must not report repairs it did not make.
//
// The field was `healed: opts.apply ? healed : drifted`, and the head line
// rendered it as `healed=N — DRY RUN, no writes`. Two separate defects sat in
// that one ternary:
//
//  1. A dry run claimed repairs. This is the DEFAULT invocation — `--apply` is
//     opt-in here — and it is the one the removal-ceiling refusal explicitly
//     sends the operator to ("Inspect with a dry run, then re-run with
//     --max-removals"). The `— DRY RUN` suffix protects a human reading the
//     whole sentence; it protects no `--json` consumer reading the field, and
//     `board-cards-heal-scheduled --json` embeds the whole dry-run report.
//
//  2. `drifted` is not `healed`'s quantity. `drifted` counts drifted
//     (board, slug) keys; `healed` counts repairs, and the delete-orphan branch
//     issues one per ROW. A slug with three orphan membership rows is
//     `drifted=1` and heals 3 — so the dry run did not merely mislabel the apply
//     run's number, it printed a DIFFERENT one. That is what the multi-row case
//     below pins, and it is why a plan derived after the fact from `drifted` or
//     from `actions` would not have been a fix.
//
// The rule is `archive_done`'s, shared through `renderSweepWrites`: count at the
// write, carry the plan in its own field, and change the KEY NAME with the
// meaning (`would_heal=` dry, `healed=` applied).

import { describe, expect, test } from "bun:test";

import { fakeNode, type FakeNode } from "./fake-node.ts";
import type { Config } from "../src/config.ts";
import { boardCardsHealResult } from "../src/commands/board_cards_heal.ts";
import { boardToFields, cardToFields, nowIso, type Card } from "../src/record.ts";
import { boardCardFieldsFromCard, boardCardSk } from "../src/board-cards.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash", board_cards: "boardcardshash" },
};

const BOARD = "default";

function card(slug: string, position: string): Card {
  const now = nowIso();
  return {
    slug,
    title: slug,
    body: "",
    board: BOARD,
    column: "todo",
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

function seedBoard(node: FakeNode): void {
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
}

function member(node: FakeNode, c: Card): void {
  node.seed({
    schemaHash: "boardcardshash",
    keyHash: c.board,
    rangeKey: boardCardSk(c.column, c.position, c.slug),
    fields: boardCardFieldsFromCard(c),
  });
}

/**
 * One orphan slug carrying `rows` membership rows — the same card left at three
 * positions by interrupted moves, with no Card record behind any of them.
 *
 * This is the fixture the old code could not describe: one drifted key, three
 * repairs.
 */
function multiRowOrphan(rows: number): FakeNode {
  const node = fakeNode();
  seedBoard(node);
  for (let i = 0; i < rows; i += 1) member(node, card("orphan-with-many-rows", `p${i}`));
  return node;
}

/** Two cards whose Card truth exists but whose membership row does not. */
function twoMissingMemberships(): FakeNode {
  const node = fakeNode();
  seedBoard(node);
  for (const slug of ["needs-a-row-a", "needs-a-row-b"]) {
    const c = card(slug, slug);
    node.seed({ schemaHash: "cardhash", keyHash: c.slug, fields: cardToFields(c) });
  }
  return node;
}

const heal = (node: FakeNode, apply: boolean) =>
  boardCardsHealResult({ cfg, node, board: BOARD, json: true, apply });

describe("board-cards-heal: a dry run reports the writes it made, which is none", () => {
  test("healed is 0 on a dry run that had real repairs to plan", async () => {
    const node = twoMissingMemberships();
    const before = node.writes.length;
    const { report } = await heal(node, false);

    expect(report.drifted).toBe(2);
    expect(report.healed).toBe(0);
    expect(report.would_heal).toBe(2);
    // The claim `healed` makes, checked against the thing it claims about.
    expect(node.writes.length).toBe(before);
  });

  test("the dry run's plan is the apply run's repair count, in the same units", async () => {
    // Three rows, one key. `drifted` cannot stand in for the repair count here,
    // and the pre-fix dry run reported 1 where an apply run reported 3.
    const dry = await heal(multiRowOrphan(3), false);
    const applied = await heal(multiRowOrphan(3), true);

    expect(dry.report.drifted).toBe(1);
    expect(dry.report.would_heal).toBe(3);
    expect(dry.report.would_heal).toBe(applied.report.healed);
    expect(dry.report.would_heal).not.toBe(dry.report.drifted);
  });

  test("the head line names which of the two questions its number answers", async () => {
    const { text } = await heal(multiRowOrphan(3), false);

    expect(text).toContain("would_heal=3");
    // Not merely "the honest key is present" — the dishonest one must be gone,
    // which is the half a bare `toContain` would let through.
    expect(text).not.toContain(" healed=");
    expect(text).toContain("DRY RUN, no writes");
  });

  test("an apply run still reports under `healed`, with no `would_heal` in the line", async () => {
    // The quiet gate: this is the reading the hourly `last-stack-fkanban-watch`
    // log has carried since 2026-07-30, and the one field this change must not
    // move. It passes before the fix as well as after — that is the point.
    const node = multiRowOrphan(3);
    const { report, text } = await heal(node, true);

    expect(report.healed).toBe(3);
    expect(text).toContain("healed=3");
    expect(text).not.toContain("would_heal");
    expect(text).not.toContain("DRY RUN");
  });

  test("a clean board reports 0 both ways, and the two agree", async () => {
    const node = fakeNode();
    seedBoard(node);
    const c = card("already-membered", "a");
    node.seed({ schemaHash: "cardhash", keyHash: c.slug, fields: cardToFields(c) });
    member(node, c);

    const { report } = await heal(node, false);

    expect(report.drifted).toBe(0);
    expect(report.healed).toBe(0);
    expect(report.would_heal).toBe(0);
  });
});
