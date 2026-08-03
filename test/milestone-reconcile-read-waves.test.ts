/**
 * `milestone reconcile` / `milestone detail` must issue their milestone-keyed
 * reads in ONE wave, and must not read the board list twice.
 *
 * On this node a request costs ~190ms whatever it asks for, so a command's wall
 * time is its serial round-trip DEPTH, not its request count
 * (`scripts/probe-round-trip-depth.ts`). `milestone detail` was the worst
 * depth-per-request command on the board — 6 requests in 6 waves, 1359ms —
 * because `milestoneReconcileResult` awaited four independent reads one after
 * another and then `milestoneDetailResult` read the board list a second time.
 *
 * Nothing sequenced them. `listBoards` needs only the config; the proof card is
 * keyed by `milestone.proof_card`, which the milestone read already returned;
 * and the MilestoneCards partition and the board's cards are both keyed off the
 * milestone. Measured after collapsing them: 5 requests, 2 waves, 661ms.
 *
 * These tests pin the SHAPE, not the timing. A wall-clock assertion would be
 * flaky, so the fake parks each of the three partition reads until all three
 * have arrived — serial code parks the first one forever and the test fails on
 * timeout, which is exactly the regression signal wanted. This is the same
 * rendezvous trick `test/read-fanout-concurrency.test.ts` uses.
 */
import { describe, expect, test } from "bun:test";

import type { Config } from "../src/config.ts";
import type { NodeClient } from "../src/client.ts";
import { fakeNode, type FakeNode } from "./fake-node.ts";
import { milestoneDetailResult, milestoneReconcileResult } from "../src/commands/milestone.ts";
import { boardCardSk } from "../src/board-cards.ts";
import { boardMilestoneFieldsFromMilestone, boardMilestoneSk } from "../src/board-milestones.ts";
import type { Milestone } from "../src/record.ts";

const CARD = "cardhash";
const BOARD = "boardhash";
const MILESTONE = "milestonehash";
const BOARD_CARDS = "boardcards-hash";
const BOARD_MILESTONES = "boardms-hash";
const MILESTONE_CARDS = "mscards-hash";

// No `card_list_index` hash, so `listBoards` falls through to its Board scan —
// one read, on a schema nothing else in this path touches.
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

function seedBoardCard(node: FakeNode, partial: Record<string, unknown>): void {
  const fields = cardFields(partial);
  const sk = boardCardSk(String(fields.column), String(fields.position), String(fields.slug));
  node.seed({ schemaHash: CARD, keyHash: String(fields.slug), fields });
  node.seed({
    schemaHash: BOARD_CARDS,
    keyHash: String(fields.board),
    rangeKey: sk,
    fields: { ...fields, board: String(fields.board), sk },
  });
}

function milestoneRecord(partial: Partial<Milestone> = {}): Milestone {
  return {
    slug: "m1",
    title: "Milestone one",
    body: "",
    board: "default",
    state: "active",
    position: "10",
    north_star: "ns-1",
    driver: "last-stack-milestone-driver",
    deps: [],
    proof_card: "proof-card",
    proof_status: "pending",
    block_reason: "",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    completed_at: "",
    ...partial,
  };
}

function seedFixture(): FakeNode {
  const node = fakeNode();
  node.seed({
    schemaHash: BOARD,
    keyHash: "default",
    fields: {
      slug: "default",
      title: "Default",
      body: "",
      columns: ["backlog", "todo", "doing", "done"],
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
  });
  const m = milestoneRecord();
  node.seed({ schemaHash: MILESTONE, keyHash: m.slug, fields: { ...m } });
  node.seed({
    schemaHash: BOARD_MILESTONES,
    keyHash: m.board,
    rangeKey: boardMilestoneSk(m.state, m.position, m.slug),
    fields: { ...boardMilestoneFieldsFromMilestone(m), completed_at: m.completed_at },
  });
  seedBoardCard(node, { slug: "live-card", milestone: "m1" });
  seedBoardCard(node, { slug: "proof-card", milestone: "m1", column: "done", position: "20" });
  return node;
}

/**
 * Park the FIRST read of each named schema until all of them have arrived.
 *
 * Only the first read per schema is gated: later waves legitimately re-read
 * `Card` (dep and summary hydration), and gating those would deadlock a
 * correct implementation.
 */
function gateFirstReadOf(node: FakeNode, schemas: string[]): { node: NodeClient; arrived: () => number } {
  const pending = new Set(schemas);
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const real = node.queryAll.bind(node);
  const wrapped = Object.assign(Object.create(Object.getPrototypeOf(node)), node, {
    queryAll: async (args: Parameters<NodeClient["queryAll"]>[0]) => {
      if (pending.has(args.schemaHash)) {
        pending.delete(args.schemaHash);
        arrived += 1;
        if (pending.size === 0) open();
        await gate;
      }
      return real(args);
    },
  }) as NodeClient;
  return { node: wrapped, arrived: () => arrived };
}

describe("milestone reconcile issues its milestone-keyed reads in one wave", () => {
  test("the MilestoneCards, BoardCards and board-list reads are all in flight at once", async () => {
    const fake = seedFixture();
    // Serial code never reaches the second of these, so it hangs here.
    const { node, arrived } = gateFirstReadOf(fake, [MILESTONE_CARDS, BOARD_CARDS, BOARD]);

    const result = await milestoneReconcileResult({ cfg, node, slug: "m1", apply: false });

    expect(arrived()).toBe(3);
    expect(result.children.map((c) => c.slug).sort()).toEqual(["live-card", "proof-card"]);
  });

  test("the proof card is point-read off the milestone, not after the membership reads", async () => {
    const fake = seedFixture();
    await milestoneReconcileResult({ cfg, node: fake, slug: "m1", apply: false });

    // The proof-card read is keyed by `milestone.proof_card`, which wave 1
    // returned — so it cannot be sequenced behind membership. Pinning it by
    // position: it is issued no later than the membership reads themselves.
    const proofAt = fake.reads.findIndex((r) => r.schemaHash === CARD && r.filter?.HashKey === "proof-card");
    const membershipAt = fake.reads.findIndex((r) => r.schemaHash === MILESTONE_CARDS);
    expect(proofAt).toBeGreaterThanOrEqual(0);
    expect(membershipAt).toBeGreaterThanOrEqual(0);
    expect(proofAt).toBeLessThan(membershipAt + 4);
  });
});

describe("milestone detail does not read the board list twice", () => {
  test("detail adds no board read of its own", async () => {
    // Compared against reconcile rather than asserted as an absolute count:
    // how many reads `listBoards` itself costs depends on whether a
    // CardListIndex is configured, and that is not what this pins. What it pins
    // is that WRAPPING reconcile in detail adds none.
    const reconcileOnly = seedFixture();
    await milestoneReconcileResult({ cfg, node: reconcileOnly, slug: "m1", apply: false });
    const baseline = reconcileOnly.reads.filter((r) => r.schemaHash === BOARD).length;

    const fake = seedFixture();
    const detail = await milestoneDetailResult({ cfg, node: fake, slug: "m1" });

    // Reconcile needs the board list for terminal columns; detail needs the same
    // list for its column groups. It travels out of reconcile rather than being
    // re-read — and the rendered columns still come from it.
    expect(fake.reads.filter((r) => r.schemaHash === BOARD)).toHaveLength(baseline);
    expect(Object.keys(detail.detail.columns)).toEqual(["backlog", "todo", "doing", "done"]);
    expect(detail.detail.columns.todo?.map((c) => c.slug)).toEqual(["live-card"]);
  });
});
