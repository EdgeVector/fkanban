// `board-cards-heal --apply` must refuse a run that would reap most of the board.
//
// WHY A CEILING WHEN EVERY DELETE IS ALREADY AUTHORIZED. The delete-orphan
// branch point-reads Card truth and then confirms with `cardExists`, which
// projects the hash key alone and so cannot false-negative. That pair is a sound
// guard against a WRONG ROW. It is no guard at all against a SYSTEMIC miss: aim
// the config at the wrong node, or at a Card plane that has not been populated,
// and every point-read legitimately returns nothing, `cardExists` agrees, and
// the run reaps the whole board one correctly-reasoned row at a time. Each
// individual decision is defensible; the aggregate is data loss. Only a ceiling
// sees the aggregate.
//
// WHY 50% AND NOT THE SIBLING'S 25%. `milestone-indexes-heal --max-removals`
// ships a 25%-of-rows-examined ratio, and copying it here would have been
// precisely the error that command's own design notes warn about — a guard sized
// to the loudest number blocking the legitimate large case. `board_cards_heal`
// records a real one-time reap of 58 orphan rows on 2026-07-30 (~27% of a
// ~218-row board), the backlog the heal was built to clear. A 25% ceiling
// refuses that correct run. Steady state, meanwhile, is far smaller: across 617
// production runs of `last-stack-fkanban-watch` that healed anything, the
// largest repair was 13 rows. The ceiling has to clear 58 and still refuse ~218,
// which is what 50%-with-a-floor does.
//
// The cases below pin both ends of that interval, so a future narrowing of the
// ratio fails here with the reason attached rather than silently breaking a
// bootstrap reap that only happens once.

import { describe, expect, test } from "bun:test";

import { fakeNode, type FakeNode } from "./fake-node.ts";
import type { Config } from "../src/config.ts";
import {
  boardCardsHealResult,
  countPossibleOrphanRemovals,
  resolveRemovalCeiling,
  DEFAULT_BOARD_CARDS_HEAL_REMOVAL_FLOOR,
} from "../src/commands/board_cards_heal.ts";
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

/**
 * A board of `live + orphans` membership rows, where `live` of them have a Card
 * record behind them and `orphans` do not. Orphan rows take the delete-orphan
 * branch; live rows are noop-match.
 */
function board(live: number, orphans: number): FakeNode {
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
  const member = (c: Card) =>
    node.seed({
      schemaHash: "boardcardshash",
      keyHash: c.board,
      rangeKey: boardCardSk(c.column, c.position, c.slug),
      fields: boardCardFieldsFromCard(c),
    });
  for (let i = 0; i < live; i += 1) {
    const c = card(`live-${i}`, `l${i}`);
    member(c);
    node.seed({ schemaHash: "cardhash", keyHash: c.slug, fields: cardToFields(c) });
  }
  for (let i = 0; i < orphans; i += 1) member(card(`orphan-${i}`, `o${i}`));
  return node;
}

const heal = (node: FakeNode, opts: { apply?: boolean; maxRemovals?: number | null } = {}) =>
  boardCardsHealResult({ cfg, node, board: BOARD, json: true, apply: true, ...opts });

describe("board-cards-heal: the orphan-removal ceiling", () => {
  // NON-VACUITY. Every assertion below is meaningless if the fixture does not
  // actually drive delete-orphan, so prove the branch runs and the ceiling is
  // not simply blocking everything.
  test("a small reap is unaffected — the ceiling is not a brake on normal healing", async () => {
    const node = board(200, 13); // the worst production run ever observed
    const { report } = await heal(node);

    expect(report.blocked).toBeFalsy();
    expect(report.missing_card).toBe(13);
    expect(report.healed).toBe(13);
    expect(node.rowsOf("boardcardshash")).toHaveLength(200);
  });

  test("the 2026-07-30 bootstrap reap (58 of 218) is still allowed", async () => {
    // The case a borrowed 25% ratio would have refused. Pinned deliberately:
    // narrowing the ratio must fail HERE, with this comment, not in production.
    const node = board(160, 58);
    const { report } = await heal(node);

    expect(report.blocked).toBeFalsy();
    expect(report.healed).toBe(58);
    expect(node.rowsOf("boardcardshash")).toHaveLength(160);
  });

  test("a systemic miss — every row orphaned — is refused, and writes NOTHING", async () => {
    const node = board(0, 218); // the shape of a config aimed at an empty Card plane
    const { report, text } = await heal(node);

    expect(report.blocked).toBe(true);
    expect(report.removals_possible).toBe(218);
    expect(report.removal_ceiling).toBe(109);
    // The refusal is total: not "delete up to the ceiling", not "do the upserts
    // anyway". An index this far from truth is where the classification itself
    // is in doubt.
    expect(report.healed).toBe(0);
    expect(node.rowsOf("boardcardshash")).toHaveLength(218);
    expect(text).toContain("BLOCKED");
  });

  test("--max-removals unlimited opts out", async () => {
    const node = board(0, 218);
    const { report } = await heal(node, { maxRemovals: null });

    expect(report.blocked).toBeFalsy();
    expect(report.healed).toBe(218);
    expect(node.rowsOf("boardcardshash")).toHaveLength(0);
  });

  test("an explicit --max-removals overrides the default in both directions", async () => {
    const tight = await heal(board(200, 13), { maxRemovals: 5 });
    expect(tight.report.blocked).toBe(true);
    expect(tight.report.removal_ceiling).toBe(5);

    const loose = await heal(board(0, 218), { maxRemovals: 500 });
    expect(loose.report.blocked).toBeFalsy();
    expect(loose.report.healed).toBe(218);
  });

  test("the headroom is reported on clean runs, not only on refusals", async () => {
    // A limit visible only in the report announcing its own breach cannot be
    // watched. The run before the one that blocks must not look like a quiet one.
    const { report } = await heal(board(200, 13));

    expect(report.blocked).toBe(false);
    expect(report.removal_ceiling).toBe(106);
    expect(report.removals_possible).toBe(13);
  });

  test("a dry run is never blocked — inspection must survive the ceiling", async () => {
    // The operator's first move after a refusal is to look at what it wanted to
    // do. If the ceiling gagged the dry run too, the refusal would be unreadable.
    const node = board(0, 218);
    const { report } = await heal(node, { apply: false });

    expect(report.blocked).toBeFalsy();
    expect(report.drifted).toBe(218);
    expect(report.actions.every((a) => a.action === "delete-orphan")).toBe(true);
    expect(node.rowsOf("boardcardshash")).toHaveLength(218);
  });
});

describe("board-cards-heal: ceiling arithmetic", () => {
  test("the floor governs small boards, where a bare ratio is meaningless", () => {
    // 2 orphans out of 4 rows is 50% and entirely ordinary on a scratch board.
    expect(resolveRemovalCeiling(undefined, 4)).toBe(DEFAULT_BOARD_CARDS_HEAL_REMOVAL_FLOOR);
    expect(resolveRemovalCeiling(undefined, 0)).toBe(DEFAULT_BOARD_CARDS_HEAL_REMOVAL_FLOOR);
  });

  test("the ratio governs once it clears the floor", () => {
    expect(resolveRemovalCeiling(undefined, 218)).toBe(109);
    expect(resolveRemovalCeiling(undefined, 1000)).toBe(500);
  });

  test("explicit values win; null is unlimited", () => {
    expect(resolveRemovalCeiling(3, 218)).toBe(3);
    expect(resolveRemovalCeiling(0, 218)).toBe(0);
    expect(resolveRemovalCeiling(null, 218)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("board-cards-heal: what the ceiling counts", () => {
  const truth = (slug: string) => card(slug, "p0");

  test("rows whose Card resolves are not removals", () => {
    const byKey = new Map([[`${BOARD}\0live`, [{ column: "todo", position: "p0" }]]]);
    const truthBySlug = new Map([["live", truth("live")]]);
    expect(countPossibleOrphanRemovals(byKey, truthBySlug)).toBe(0);
  });

  test("every row of an unresolved slug counts — a slug can hold several", () => {
    const byKey = new Map([
      [`${BOARD}\0gone`, [
        { column: "todo", position: "p0" },
        { column: "done", position: "p1" },
      ]],
    ]);
    const truthBySlug = new Map<string, Card | null>([["gone", null]]);
    expect(countPossibleOrphanRemovals(byKey, truthBySlug)).toBe(2);
  });

  test("a synthetic missing-membership candidate has no rows and cannot delete", () => {
    // `\0<slug>` keys are repaired by an UPSERT. Counting them would let a
    // first heal of an unindexed board — all upserts, zero deletions — trip a
    // ceiling meant for destruction.
    const byKey = new Map([["\0unmembered", [] as { column: string; position: string }[]]]);
    const truthBySlug = new Map<string, Card | null>([["unmembered", null]]);
    expect(countPossibleOrphanRemovals(byKey, truthBySlug)).toBe(0);
  });
});
