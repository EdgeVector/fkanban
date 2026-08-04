// The dependency soft-block must enforce on the TERMINAL (completion) column,
// not only on `doing`: a card blocked by an undone dep can't be moved or placed
// into `done` without --force, on any board.
//
// This file was written for custom-columns boards (#87 — a board with
// `spec,build,ship` had no enforced column, so a blocked card could be moved
// all the way into `ship`). Columns became fixed in 2026-07 and `board create`
// now refuses any other list, so what remains is the SAME gate with one
// terminal column everywhere. The invariant that makes that safe to assume is
// pinned in `terminal-column-is-fixed.test.ts`; what this file still earns is
// the end-to-end exercise through the real addCmd/moveCmd, on the same
// in-memory fake NodeClient used in add-update-board.test.ts.

import { beforeEach, describe, expect, test } from "bun:test";

import type { NodeClient } from "../src/client.ts";
import { fakeNode } from "./fake-node.ts";
import type { Config } from "../src/config.ts";
import { boardToFields, findCard, isDepEnforcedColumn, nowIso } from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";
import { addCmd } from "../src/commands/add.ts";
import { moveCmd } from "../src/commands/move.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash" },
};


function seedBoard(node: NodeClient, slug: string, columns: string[]) {
  const now = nowIso();
  return node.createRecord({
    schemaHash: cfg.schemaHashes.board!,
    keyHash: slug,
    fields: boardToFields({
      slug,
      title: slug,
      body: "",
      columns,
      created_at: now,
      updated_at: now,
    }),
  });
}

describe("isDepEnforcedColumn", () => {
  test("the gated set is doing + the terminal column; backlog/todo are not", () => {
    // Todo is a queue lane. Unfinished deps are refused only when work starts
    // or completes, so blocked cards can still be represented before pickup.
    expect(isDepEnforcedColumn("backlog")).toBe(false);
    expect(isDepEnforcedColumn("todo")).toBe(false);
    expect(isDepEnforcedColumn("doing")).toBe(true);
    expect(isDepEnforcedColumn("done")).toBe(true);
  });

  test("a name no board can declare is not gated", () => {
    // `review` and `ship` are not columns any longer — never gates, never
    // terminal. Board-independence itself is pinned in
    // `terminal-column-is-fixed.test.ts`.
    expect(isDepEnforcedColumn("review")).toBe(false);
    expect(isDepEnforcedColumn("ship")).toBe(false);
  });
});

describe("move: blocked card can't reach done on a non-default board", () => {
  let node: NodeClient;

  beforeEach(async () => {
    node = fakeNode();
    await seedBoard(node, "zz", [...DEFAULT_COLUMNS]);
  });

  test("move into `done` is refused while the dep is unfinished, voiced + no write", async () => {
    await addCmd({ cfg, node, slug: "c1", board: "zz", column: "todo" });
    await addCmd({ cfg, node, slug: "c2", board: "zz", column: "todo", deps: ["c1"] });

    // Place c2 in doing (allowed on non-default while blocked? doing is working → blocked)
    await expect(moveCmd({ cfg, node, slug: "c2", column: "doing" })).rejects.toMatchObject({
      code: "card_blocked",
    });
    await expect(moveCmd({ cfg, node, slug: "c2", column: "done" })).rejects.toMatchObject({
      code: "card_blocked",
    });
    expect((await findCard(node, cfg, "c2"))?.column).toBe("todo");
  });

  test("--force overrides the terminal-column block", async () => {
    await addCmd({ cfg, node, slug: "c1", board: "zz", column: "todo" });
    await addCmd({ cfg, node, slug: "c2", board: "zz", column: "todo", deps: ["c1"] });
    const res = await moveCmd({ cfg, node, slug: "c2", column: "done", force: true });
    expect(res).toMatchObject({ to: "done" });
    expect((await findCard(node, cfg, "c2"))?.column).toBe("done");
  });

  test("once the dep reaches the terminal column, the move succeeds", async () => {
    await addCmd({ cfg, node, slug: "c1", board: "zz", column: "todo" });
    await addCmd({ cfg, node, slug: "c2", board: "zz", column: "todo", deps: ["c1"] });
    await moveCmd({ cfg, node, slug: "c1", column: "done" });
    const res = await moveCmd({ cfg, node, slug: "c2", column: "done" });
    expect(res).toMatchObject({ to: "done" });
    expect((await findCard(node, cfg, "c2"))?.column).toBe("done");
  });
});

describe("default board: enforcement unchanged", () => {
  let node: NodeClient;

  beforeEach(async () => {
    node = fakeNode();
    await seedBoard(node, "default", [...DEFAULT_COLUMNS]);
  });

  test("blocked card still refused into `doing`", async () => {
    await addCmd({ cfg, node, slug: "d1", title: "D1" });
    await addCmd({ cfg, node, slug: "d2", title: "D2", deps: ["d1"] });
    await expect(moveCmd({ cfg, node, slug: "d2", column: "doing" })).rejects.toMatchObject({
      code: "card_blocked",
    });
  });

  test("unblocked card moves freely into `doing`", async () => {
    await addCmd({ cfg, node, slug: "d1", title: "D1", column: "done" });
    await addCmd({ cfg, node, slug: "d2", title: "D2", deps: ["d1"] });
    const res = await moveCmd({ cfg, node, slug: "d2", column: "doing" });
    expect(res).toMatchObject({ to: "doing" });
  });
});
