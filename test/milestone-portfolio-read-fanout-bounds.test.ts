/**
 * `milestone portfolio` fans out three ways, and none of the three had a width.
 *
 * The codebase already has the load guard and the reason for it:
 * `mapWithConcurrency` exists because "LastDB Mini sheds load with 'too many
 * concurrent reads', so an unbounded `Promise.all` over N slugs is a load
 * hazard, not a speedup", and `listAllBoardCards` pools the per-board partition
 * fan-out at {@link PARTITION_READ_CONCURRENCY} for exactly that reason.
 * `milestone.ts` imported the pool, used it elsewhere, and left three call sites
 * on a raw `Promise.all`:
 *
 *   - the per-board partition read (the HEAVY class — one whole partition each)
 *   - the proof-card wide reads, one per distinct `proof_card`
 *   - the `cardExists` re-reads for proof slugs the wide read missed
 *
 * All three are inert at today's shape (two boards) and that is precisely why
 * they survived review: a bound that is never reached is indistinguishable from
 * a bound that is absent, until the board count grows. `board-cards.ts` records
 * this node having carried **34 Board slugs at once**, and the third fan-out is
 * WIDEST when the board is in its worst state — every dangling proof ref adds a
 * `cardExists` call, and 19 of 22 proof refs dangle on the live board today.
 *
 * These tests pin the CEILING, which is the half a "does it still work" test
 * cannot see. Each one seeds more items than its width and asserts the observed
 * peak never exceeds it — and also asserts the peak is greater than one, so a
 * future change that "fixes" the bound by serializing the reads fails too. That
 * second assertion is the one that makes these tests able to read failure in
 * both directions rather than just the direction that was broken.
 */
import { describe, expect, test } from "bun:test";

import type { Config } from "../src/config.ts";
import { fakeNode, type FakeNode } from "./fake-node.ts";
import { milestonePortfolioResult } from "../src/commands/milestone.ts";
import { PARTITION_READ_CONCURRENCY, POINT_READ_CONCURRENCY } from "../src/concurrency.ts";
import { boardCardSk } from "../src/board-cards.ts";
import { boardMilestoneFieldsFromMilestone, boardMilestoneSk } from "../src/board-milestones.ts";
import type { Milestone } from "../src/record.ts";
import type { NodeClient } from "../src/client.ts";

const CARD = "cardhash";
const BOARD = "boardhash";
const MILESTONE = "milestonehash";
const BOARD_CARDS = "boardcards-hash";
const BOARD_MILESTONES = "boardms-hash";
const MILESTONE_CARDS = "mscards-hash";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: {
    card: CARD,
    board: BOARD,
    milestone: MILESTONE,
    board_cards: BOARD_CARDS,
    board_milestones: BOARD_MILESTONES,
    milestone_cards: MILESTONE_CARDS,
  },
};

/**
 * Wrap a node so every `queryAll` is held open for one macrotask.
 *
 * The hold is what makes the peak observable at all: `fakeNode` resolves
 * synchronously, so without a real suspension point each read would finish
 * before the next began and every implementation — bounded or not — would
 * measure a peak of 1. With it, every call started in the same tick overlaps,
 * so an unbounded `Promise.all` over N items peaks at N and a pool peaks at its
 * width. No timing assertion, no flake: the numbers are structural.
 */
function trackInFlight(node: FakeNode): {
  node: NodeClient;
  peak: (schemaHash: string) => number;
  count: (schemaHash: string) => number;
} {
  const inFlight = new Map<string, number>();
  const peak = new Map<string, number>();
  const total = new Map<string, number>();
  const realQueryAll = node.queryAll.bind(node);
  const wrapped = Object.assign(Object.create(Object.getPrototypeOf(node)), node, {
    queryAll: async (args: Parameters<NodeClient["queryAll"]>[0]) => {
      const h = (args as { schemaHash: string }).schemaHash;
      const now = (inFlight.get(h) ?? 0) + 1;
      inFlight.set(h, now);
      peak.set(h, Math.max(peak.get(h) ?? 0, now));
      total.set(h, (total.get(h) ?? 0) + 1);
      try {
        await new Promise((resolve) => setTimeout(resolve, 0));
        return await realQueryAll(args);
      } finally {
        inFlight.set(h, (inFlight.get(h) ?? 1) - 1);
      }
    },
  }) as NodeClient;
  return {
    node: wrapped,
    peak: (h) => peak.get(h) ?? 0,
    count: (h) => total.get(h) ?? 0,
  };
}

function cardFields(partial: Record<string, unknown>): Record<string, unknown> {
  return {
    slug: "c",
    title: "A card",
    body: "## GOAL\nWork.\n\n## END STATE\nDone.\n",
    board: "default",
    column: "todo",
    position: "10",
    assignee: "",
    tags: [],
    deps: [],
    surfaces: [],
    created_at: "2026-01-01T00:00:00.000Z",
    created_by: "test",
    updated_at: "2026-01-01T00:00:00.000Z",
    done_at: "",
    db: "",
    repo: "EdgeVector/fkanban",
    base: "main",
    kind: "pr",
    block_status: "none",
    block_reason: "",
    north_star: "ns-1",
    milestone: "m1",
    pr_url: "",
    branch: "",
    ...partial,
  };
}

function seedBoard(node: FakeNode, slug: string): void {
  node.seed({
    schemaHash: BOARD,
    keyHash: slug,
    fields: {
      slug,
      title: slug,
      body: "",
      columns: ["backlog", "todo", "doing", "done"],
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
  });
}

function seedBoardCard(node: FakeNode, partial: Record<string, unknown>): void {
  const fields = cardFields(partial);
  node.seed({ schemaHash: CARD, keyHash: String(fields.slug), fields });
  node.seed({
    schemaHash: BOARD_CARDS,
    keyHash: String(fields.board),
    rangeKey: boardCardSk(String(fields.column), String(fields.position), String(fields.slug)),
    fields: {
      ...fields,
      board: String(fields.board),
      sk: boardCardSk(String(fields.column), String(fields.position), String(fields.slug)),
    },
  });
}

function seedMilestone(node: FakeNode, partial: Partial<Milestone> = {}): void {
  const m: Milestone = {
    slug: "m1",
    title: "Milestone one",
    body: "",
    board: "default",
    state: "active",
    position: "10",
    north_star: "ns-1",
    driver: "last-stack-milestone-driver",
    deps: [],
    proof_card: "",
    proof_status: "pending",
    block_reason: "",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    completed_at: "",
    ...partial,
  };
  node.seed({ schemaHash: MILESTONE, keyHash: m.slug, fields: { ...m } });
  node.seed({
    schemaHash: BOARD_MILESTONES,
    keyHash: m.board,
    rangeKey: boardMilestoneSk(m.state, m.position, m.slug),
    fields: { ...boardMilestoneFieldsFromMilestone(m), completed_at: m.completed_at },
  });
}

describe("milestone portfolio bounds every read fan-out", () => {
  test("per-board partition reads are pooled at PARTITION_READ_CONCURRENCY", async () => {
    // More boards than the width, so the ceiling is actually exercised. The
    // whole-partition read is the heavy class; this is the fan-out that shed
    // risk actually attaches to.
    const BOARDS = PARTITION_READ_CONCURRENCY * 2;
    const raw = fakeNode();
    for (let i = 0; i < BOARDS; i++) {
      const slug = `board-${String(i).padStart(2, "0")}`;
      seedBoard(raw, slug);
      seedBoardCard(raw, { slug: `card-${i}`, board: slug, milestone: "" });
    }
    seedMilestone(raw, { board: "board-00" });

    const t = trackInFlight(raw);
    await milestonePortfolioResult({ cfg, node: t.node });

    expect(t.count(BOARD_CARDS)).toBe(BOARDS);
    expect(t.peak(BOARD_CARDS)).toBeLessThanOrEqual(PARTITION_READ_CONCURRENCY);
    // …and still genuinely concurrent. A pool is the fix; a serial loop is not.
    expect(t.peak(BOARD_CARDS)).toBeGreaterThan(1);
  });

  test("proof-card reads are pooled at POINT_READ_CONCURRENCY", async () => {
    // Every milestone carries a DISTINCT proof_card that does not exist, which
    // is the live board's shape (19 of 22 dangle) and drives both point-read
    // fan-outs at once: the wide `findProofCard` read, and then the `cardExists`
    // re-read that is issued only for the slugs the wide read missed.
    const MILESTONES = POINT_READ_CONCURRENCY * 2;
    const raw = fakeNode();
    seedBoard(raw, "default");
    for (let i = 0; i < MILESTONES; i++) {
      seedMilestone(raw, {
        slug: `m-${String(i).padStart(2, "0")}`,
        position: String(10 + i),
        proof_card: `dangling-proof-${i}`,
      });
    }

    const t = trackInFlight(raw);
    await milestonePortfolioResult({ cfg, node: t.node });

    // Both fan-outs land on CARD: MILESTONES wide reads + MILESTONES existence
    // re-reads, none of which resolve.
    expect(t.count(CARD)).toBeGreaterThanOrEqual(MILESTONES * 2);
    expect(t.peak(CARD)).toBeLessThanOrEqual(POINT_READ_CONCURRENCY);
    expect(t.peak(CARD)).toBeGreaterThan(1);
  });

  test("the board read is still started BEFORE the milestone list is awaited", async () => {
    // The pool must not become a lazy thunk. `milestonePortfolioSnapshot`
    // deliberately starts the board partition reads without awaiting them, so
    // they overlap the milestone list rather than queue behind it — a comment
    // there records that doing otherwise made the command 15-20% slower in wall
    // clock even as its node time fell.
    //
    // Deterministic, not timed: the milestone-list read is HELD until a board
    // partition read has arrived. If the board reads were moved after the
    // milestone await, nothing would ever arrive, the gate would never open and
    // this test would fail on timeout — which is the regression signal wanted.
    const raw = fakeNode();
    seedBoard(raw, "default");
    seedBoardCard(raw, { slug: "card-1", milestone: "m1" });
    seedMilestone(raw);

    let boardCardsArrived!: () => void;
    const boardCardsSeen = new Promise<void>((resolve) => (boardCardsArrived = resolve));

    const realQueryAll = raw.queryAll.bind(raw);
    const gated = Object.assign(Object.create(Object.getPrototypeOf(raw)), raw, {
      queryAll: async (args: Parameters<NodeClient["queryAll"]>[0]) => {
        const h = (args as { schemaHash: string }).schemaHash;
        if (h === BOARD_CARDS) boardCardsArrived();
        if (h === BOARD_MILESTONES) await boardCardsSeen;
        return realQueryAll(args);
      },
    }) as NodeClient;

    const portfolio = await milestonePortfolioResult({ cfg, node: gated });
    expect(portfolio.entries.find((e) => e.slug === "m1")?.ready).toContain("card-1");
  });
});
