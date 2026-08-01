/**
 * `upsertMilestoneCard` is the REPAIR path — `groom milestone-indexes` and
 * `milestone reconcile` call it, the heal case with `previous = null`, which
 * takes an unconditional whole-partition sweep of the destination milestone.
 *
 * It used to retire before it wrote. A repair verb that deletes more than it
 * writes leaves the board worse than it found it: the card loses its only
 * MilestoneCards row, `milestone detail` and `reconcile` stop seeing it as a
 * child, and the next heal cannot rediscover a row it just destroyed.
 *
 * Same rule as `board-cards-move-durability.test.ts` and
 * `board-milestones-move-durability.test.ts`: the destination row must be
 * durable before anything is retired.
 */
import { describe, expect, test } from "bun:test";

import type { Config } from "../src/config.ts";
import {
  listMilestoneCardsPartition,
  milestoneCardFieldsFromCard,
  milestoneCardSk,
  upsertMilestoneCard,
} from "../src/milestone-cards.ts";
import { emptyStructuredFields, type Card } from "../src/record.ts";
import { fakeNode, type FakeNode } from "./fake-node.ts";

const MC = "milestone-cards-hash";
const MS = "ship-it";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://127.0.0.1:9",
  userHash: "user",
  schemaServiceUrl: "http://127.0.0.1:9",
  schemaHashes: {
    board: "board-hash",
    card: "card-hash",
    milestone_cards: MC,
  },
};

/**
 * MilestoneCards is measured NOT to drop partial rows on the live primary
 * (56 rows return, 47–56 carrying any given payload field —
 * `scripts/probe-projection-rule-regression.ts`, 2026-08-01), so the strict
 * default would model the wrong index. See the `fake-node.ts` header.
 */
const mcNode = () => fakeNode({ dropIncompleteRows: false });

function card(partial: Partial<Card> = {}): Card {
  return {
    slug: "heal-me",
    title: "Heal me",
    body: "",
    board: "default",
    column: "todo",
    position: "1",
    assignee: "tom",
    tags: [],
    deps: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    ...emptyStructuredFields(),
    // After the spread: `emptyStructuredFields()` blanks `milestone`.
    milestone: MS,
    surfaces: [],
    done_at: "",
    kind: "pr",
    repo: "EdgeVector/fkanban",
    ...partial,
  } as Card;
}

function seedRow(node: FakeNode, c: Card): void {
  const fields = milestoneCardFieldsFromCard(c);
  if (!fields) throw new Error("test card has no milestone");
  node.seed({
    schemaHash: MC,
    keyHash: MS,
    rangeKey: milestoneCardSk(c.column, c.position, c.slug),
    fields,
  });
}

function failWritesAt(node: FakeNode, sk: string): void {
  const wrap = (orig: FakeNode["updateRecord"]) =>
    (async (args: Parameters<FakeNode["updateRecord"]>[0]) => {
      if (args.rangeKey === sk) throw new Error("deadline_exceeded");
      return orig(args);
    }) as FakeNode["updateRecord"];
  node.updateRecord = wrap(node.updateRecord.bind(node));
  node.createRecord = wrap(node.createRecord.bind(node)) as FakeNode["createRecord"];
}

const slugsOf = (rows: Array<{ slug: string }> | null) => (rows ?? []).map((c) => c.slug);

describe("MilestoneCards repair durability", () => {
  test("a failed heal write leaves the card's membership where it was", async () => {
    // The heal shape: previous = null, so the sweep is unconditional. This is
    // the case where retiring first destroyed the row the repair was meant to
    // correct.
    const node = mcNode();
    seedRow(node, card({ column: "todo", position: "1" }));
    const next = card({ column: "doing", position: "2", updated_at: "2026-01-03T00:00:00.000Z" });
    failWritesAt(node, milestoneCardSk(next.column, next.position, next.slug));

    await expect(upsertMilestoneCard(node, cfg, next, null)).rejects.toThrow();

    const rows = await listMilestoneCardsPartition(node, cfg, MS);
    expect(slugsOf(rows)).toEqual(["heal-me"]);
    expect(rows![0]!.column).toBe("todo"); // still where it was, not erased
  });

  test("a failed reconcile write does not strip the previous membership", async () => {
    const node = mcNode();
    const prev = card({ column: "todo", position: "1" });
    const next = card({ column: "done", position: "3", updated_at: "2026-01-03T00:00:00.000Z" });
    seedRow(node, prev);
    failWritesAt(node, milestoneCardSk(next.column, next.position, next.slug));

    await expect(upsertMilestoneCard(node, cfg, next, prev)).rejects.toThrow();

    const rows = await listMilestoneCardsPartition(node, cfg, MS);
    expect(slugsOf(rows)).toEqual(["heal-me"]);
    expect(rows![0]!.column).toBe("todo");
  });

  test("the destination write is issued before any retirement", async () => {
    const node = mcNode();
    const prev = card({ column: "todo", position: "1" });
    const next = card({ column: "doing", position: "2", updated_at: "2026-01-03T00:00:00.000Z" });
    seedRow(node, prev);

    await upsertMilestoneCard(node, cfg, next, prev);

    const mc = node.writes.filter((w) => w.schemaHash === MC);
    const wroteDest = mc.findIndex(
      (w) => w.op !== "delete" && w.rangeKey === milestoneCardSk(next.column, next.position, next.slug),
    );
    const firstDelete = mc.findIndex((w) => w.op === "delete");
    expect(wroteDest).toBeGreaterThanOrEqual(0);
    expect(firstDelete).toBeGreaterThanOrEqual(0);
    expect(wroteDest).toBeLessThan(firstDelete);
  });

  test("a successful repair still converges on exactly one row", async () => {
    // Deferring the sweep must not cancel it.
    const node = mcNode();
    seedRow(node, card({ column: "todo", position: "1" }));
    seedRow(node, card({ column: "backlog", position: "7" }));
    const next = card({ column: "doing", position: "2", updated_at: "2026-01-03T00:00:00.000Z" });

    await upsertMilestoneCard(node, cfg, next, null);

    expect(node.rowsOf(MC)).toHaveLength(1);
    expect(node.rowAt(MC, MS, milestoneCardSk("doing", "2", "heal-me"))).toBeDefined();
  });

  test("clearing the milestone still retires immediately", async () => {
    // No destination row exists to wait for, so the retirement IS the
    // operation. Reordering must not turn a clear into a no-op.
    const node = mcNode();
    const prev = card({ column: "todo", position: "1" });
    seedRow(node, prev);

    await upsertMilestoneCard(node, cfg, card({ milestone: "" }), prev);

    expect(node.rowsOf(MC)).toHaveLength(0);
  });
});
