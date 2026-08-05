// `groom parity-check` is the detector a ROUTINE runs, and a routine reads the
// exit code, not the prose. So the property that decides whether staffing it
// helps is not "can it go red on drift" — `parity-check-command.test.ts` already
// pins that — but the one underneath it:
//
//   **a green must mean "I looked and everything agreed", never "I did not look".**
//
// It did not hold. Measured 2026-08-05 with
// `scripts/probe-parity-unconfigured-index-vacuous-green.ts`, three routes all
// returning `ok: true` and exit 0:
//
//   - no `board_cards` hash in config -> partitions=0, rows=0, with rows seeded
//   - `milestone_cards` hash absent   -> every milestone partition silently gone
//   - `--board <typo>`                -> confirmed on the LIVE board, exit 0
//
// Each sweep returns `null` on an unresolvable schema hash and every call site
// said `if (sweep === null) continue`, so the skipped partition left no trace in
// a report whose only coverage signal was a grand total.
//
// The `milestone_cards` route is the reachable one rather than the theoretical
// one: that index is pinned under the *Milestone* entity identity
// (`papercut-kanban-primary-milestone-cards-pinned-under-the-milestone-identity`),
// so "its hash does not resolve" is a live state of this system, and it would
// have removed MilestoneCards from the verdict without removing the ✓.
//
// The tests below therefore come in matched pairs: each "must go red" has a
// negative twin that must stay GREEN. A gate that fails safe by failing always
// gets muted in a week, and a muted gate is the unstaffed detector again — the
// exact condition this command was written to end.

import { describe, expect, test } from "bun:test";

import { fakeNode, type FakeNode } from "./fake-node.ts";
import type { Config } from "../src/config.ts";
import { parityCheckResult } from "../src/commands/parity_check.ts";
import { boardCardSk } from "../src/board-cards.ts";

const BOARD = "default";

function cfgWith(schemaHashes: Record<string, string>): Config {
  return {
    configVersion: 1,
    nodeUrl: "http://unused.invalid",
    schemaServiceUrl: "http://unused.invalid",
    userHash: "test-user",
    schemaHashes,
  } as Config;
}

const FULL = { card: "cardhash", board: "boardhash", board_cards: "bchash" };

function board(): FakeNode {
  const node = fakeNode({
    projectionRule: "hash_else_lead",
    hashFields: { bchash: "board", boardhash: "slug", mchash: "milestone" },
  });
  node.seed({
    schemaHash: "boardhash",
    keyHash: BOARD,
    rangeKey: null,
    fields: {
      slug: BOARD,
      title: "Default",
      body: "",
      columns: "backlog,todo,doing,done",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
  });
  return node;
}

function seedCard(node: FakeNode, slug: string, fields: Record<string, unknown> = {}) {
  const sk = boardCardSk("todo", "1", slug);
  node.seed({
    schemaHash: "bchash",
    keyHash: BOARD,
    rangeKey: sk,
    fields: { board: BOARD, sk, slug, title: slug, column: "todo", position: "1", ...fields },
  });
}

describe("parity-check cannot report a green it did not earn", () => {
  test("an unresolved board_cards hash is RED, not an empty green", async () => {
    const node = board();
    seedCard(node, "stays");
    seedCard(node, "leaves");

    // The board index itself does not resolve. Two rows exist and none of them
    // was examined; before the fix this returned ok:true with partitions=0.
    const report = await parityCheckResult({
      cfg: cfgWith({ card: "cardhash", board: "boardhash" }),
      node,
    });

    expect(report.ok).toBe(false);
    expect(report.partitions_checked).toBe(0);
    expect(report.unchecked.map((u) => u.index)).toEqual(["BoardCards"]);
    expect(report.unchecked[0]?.partitions).toEqual([BOARD]);
    // The remedy must point at the install layer. Healing an index that does
    // not resolve is a repair aimed at the wrong thing.
    expect(report.unchecked[0]?.remedy).toContain("kanban init");
  });

  test("an unresolved milestone_cards hash is RED when a card names a milestone", async () => {
    const node = board();
    seedCard(node, "stays", { milestone: "m1" });

    const report = await parityCheckResult({ cfg: cfgWith(FULL), node });

    expect(report.ok).toBe(false);
    // BoardCards still checked and clean — the point is that the run is not
    // green *overall* while an index it needed went unexamined.
    expect(report.drift).toEqual([]);
    expect(report.unchecked.map((u) => u.index).sort()).toEqual([
      "BoardMilestones",
      "MilestoneCards",
    ]);
    expect(report.unchecked.find((u) => u.index === "MilestoneCards")?.partitions).toEqual(["m1"]);
  });

  // The negative twin. Without this, "fail whenever a hash is missing" would
  // pass every test above and go red on every milestone-free board.
  test("a board that names no milestone stays GREEN without the milestone hashes", async () => {
    const node = board();
    seedCard(node, "stays");
    seedCard(node, "leaves");

    const report = await parityCheckResult({ cfg: cfgWith(FULL), node });

    expect(report.ok).toBe(true);
    expect(report.unchecked).toEqual([]);
  });

  test("--board naming no board is RED — nothing was checked", async () => {
    const node = board();
    seedCard(node, "stays");

    const report = await parityCheckResult({ cfg: cfgWith(FULL), node, board: "no-such-board" });

    expect(report.ok).toBe(false);
    expect(report.unresolved_board).toBe("no-such-board");
    expect(report.partitions_checked).toBe(0);
  });

  test("--board naming a real board is GREEN and reports only that board", async () => {
    const node = board();
    seedCard(node, "stays");

    const report = await parityCheckResult({ cfg: cfgWith(FULL), node, board: BOARD });

    expect(report.ok).toBe(true);
    expect(report.unresolved_board).toBe(null);
    expect(report.partitions_checked).toBe(1);
  });

  // Coverage is the half that survives a green. A grand total cannot show that
  // one index contributed everything and another contributed nothing, which is
  // the shape every route above produced.
  test("coverage is reported per index, on a green run", async () => {
    const node = board();
    seedCard(node, "stays");
    seedCard(node, "leaves");

    const report = await parityCheckResult({ cfg: cfgWith(FULL), node });

    expect(report.ok).toBe(true);
    const bc = report.coverage.find((c) => c.index === "BoardCards");
    expect(bc?.partitions).toBe(1);
    expect(bc?.rows).toBe(2);
    // Named with zeroes rather than omitted: "checked and empty" and "never
    // resolved" must both be visible, and an absent key looks like neither.
    expect(report.coverage.map((c) => c.index).sort()).toEqual([
      "BoardCards",
      "BoardMilestones",
      "MilestoneCards",
    ]);
    expect(report.coverage.find((c) => c.index === "MilestoneCards")?.rows).toBe(0);
  });

  test("the sum still equals the parts — coverage cannot drift from the total", async () => {
    const node = board();
    seedCard(node, "stays");
    seedCard(node, "leaves");

    const report = await parityCheckResult({ cfg: cfgWith(FULL), node });

    expect(report.coverage.reduce((n, c) => n + c.partitions, 0)).toBe(report.partitions_checked);
    expect(report.coverage.reduce((n, c) => n + c.rows, 0)).toBe(report.rows_checked);
  });
});
