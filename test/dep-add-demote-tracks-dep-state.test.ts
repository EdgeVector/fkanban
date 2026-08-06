// `dep add` demotes a default/todo card to backlog because "unfinished deps
// belong in backlog" — and until 2026-08-06 the condition it used contained no
// notion of unfinished. It read:
//
//     if (card.board === "default" && card.column === "todo")
//
// which tests the CARD's placement and never looks at the DEP. Adding an edge
// to a dependency that is ALREADY in `done` therefore demoted a card that
// `depStatus` immediately reported unblocked. Nothing promotes it back:
// `move`'s `promoteUnblockedBacklogDependents` fires only when a dependency
// TRANSITIONS into the terminal column, and a dependency already sitting there
// never transitions again. The card is not blocked, does not appear in
// `blocked-on-dependency`, and reads as ordinary backlog — so it leaves the
// pickup queue permanently and nothing downstream flags it as stranded.
//
// THE ASSERTION HERE IS THE INVARIANT, NOT THE ARMS. Any of these arms could be
// satisfied by a second copy of the blocking rule inside `depAddCmd` that
// happens to agree today. What must hold is that the demote and the block are
// the same verdict about the same edge:
//
//     demoted  ⟺  the new edge blocks this card
//
// so every arm asserts the observed demote against `depStatus` re-read from the
// board AFTER the write, rather than against a hand-written expectation. That
// is what fails if the two readings ever drift apart again — which is the shape
// this component keeps hitting (the comment was right and the predicate was
// written about the wrong noun).
//
// The meta-kind arm is not decoration: `depStatus` exempts meta cards from
// blocking, so a rule that only checked `column !== "done"` would pass the
// done/unfinished arms and still demote for a `tracker` dep that blocks nothing.

import { describe, expect, test } from "bun:test";

import type { NodeClient } from "../src/client.ts";
import { fakeNode } from "./fake-node.ts";
import type { Config } from "../src/config.ts";
import { boardToFields, depStatus, findCard, listCardStatuses, nowIso } from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";
import { addCmd } from "../src/commands/add.ts";
import { depAddCmd } from "../src/commands/dep.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash" },
};

const body = (text = "Dep demote fixture.") => `Repo: EdgeVector/fkanban\nBase: main\n\n${text}`;

function seedBoard(node: NodeClient, slug: string) {
  const now = nowIso();
  return node.createRecord({
    schemaHash: cfg.schemaHashes.board!,
    keyHash: slug,
    fields: boardToFields({
      slug,
      title: slug,
      body: "",
      columns: [...DEFAULT_COLUMNS],
      created_at: now,
      updated_at: now,
    }),
  });
}

/**
 * Run one arm: seed a dependent in `dependentColumn` on `board`, seed a dep in
 * `depColumn` with `depKind`, add the edge, and return what actually happened.
 *
 * `blocked` is re-read from the board after the write, so it is the system's
 * own verdict on the edge — not this test's opinion of it.
 */
async function addEdge(opts: {
  board?: string;
  dependentColumn?: string;
  depColumn: string;
  depKind?: string;
}): Promise<{ demoted: boolean; column: string; blocked: boolean }> {
  const board = opts.board ?? "default";
  const node = fakeNode();
  await seedBoard(node, board);
  await addCmd({
    cfg,
    node,
    slug: "dependent",
    title: "dependent",
    body: body(),
    board,
    column: opts.dependentColumn ?? "todo",
  });
  await addCmd({
    cfg,
    node,
    slug: "dependency",
    title: "dependency",
    body: body(),
    board,
    column: opts.depColumn,
    ...(opts.depKind !== undefined ? { kind: opts.depKind } : {}),
  });

  const result = await depAddCmd({ cfg, node, slug: "dependent", dep: "dependency" });
  const after = await findCard(node, cfg, "dependent");
  if (!after) throw new Error("dependent card vanished");
  const blocked = depStatus(after, await listCardStatuses(node, cfg)).blocked;
  return { demoted: result.demoted !== undefined, column: after.column, blocked };
}

describe("dep add demotes only for an edge that actually blocks", () => {
  test("an unfinished dep demotes out of the pickup lane, and the card is blocked", async () => {
    const { demoted, column, blocked } = await addEdge({ depColumn: "doing" });
    expect(blocked).toBe(true);
    expect(demoted).toBe(true);
    expect(column).toBe("backlog");
  });

  test("a dep already in done does NOT demote — nothing would promote it back", async () => {
    const { demoted, column, blocked } = await addEdge({ depColumn: "done" });
    expect(blocked).toBe(false);
    expect(demoted).toBe(false);
    expect(column).toBe("todo");
  });

  test("a meta-kind dep does NOT demote — meta cards never block", async () => {
    // `backlog`, not `todo`: a separate and correct gate
    // (`default_todo_not_pickup_ready`) refuses to place a tracker in the
    // pickup lane at all. Backlog is still NON-terminal, which is all this arm
    // needs — a rule that only checked `column !== "done"` demotes here, and
    // `depStatus` reports the dependent unblocked.
    const { demoted, column, blocked } = await addEdge({ depColumn: "backlog", depKind: "tracker" });
    expect(blocked).toBe(false);
    expect(demoted).toBe(false);
    expect(column).toBe("todo");
  });

  test("the demote stays scoped to default/todo: a non-default board never demotes", async () => {
    // Blocked and NOT demoted is the one legitimate asymmetry — the pickup lane
    // is a property of `default`, so this arm asserts the demote's scope guard
    // survived the predicate change rather than the invariant.
    const { demoted, column, blocked } = await addEdge({ board: "scratch", depColumn: "doing" });
    expect(blocked).toBe(true);
    expect(demoted).toBe(false);
    expect(column).toBe("todo");
  });

  test("a default card outside todo never demotes", async () => {
    const { demoted, column } = await addEdge({ dependentColumn: "doing", depColumn: "doing" });
    expect(demoted).toBe(false);
    expect(column).toBe("doing");
  });
});
