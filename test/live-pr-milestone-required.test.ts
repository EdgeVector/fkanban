import { describe, expect, test } from "bun:test";
import type { NodeClient } from "../src/client.ts";
import { fakeNode } from "./fake-node.ts";
import type { Config } from "../src/config.ts";
import { assertLivePrMilestone, boardToFields, nowIso } from "../src/record.ts";
import { FkanbanError } from "../src/client.ts";
import { addCmd } from "../src/commands/add.ts";
import { moveCmd } from "../src/commands/move.ts";
import { setCmd } from "../src/commands/set.ts";
import { pickupExplainResult } from "../src/commands/pickup_explain.ts";
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

describe("assertLivePrMilestone", () => {
  test("requires milestone for Kind:pr in todo/doing (pickup lane)", () => {
    expect(() =>
      assertLivePrMilestone({ slug: "x", kind: "pr", column: "todo", milestone: "" }, false, {
        enforce: true,
      })
    ).toThrow(FkanbanError);
    try {
      assertLivePrMilestone({ slug: "x", kind: "pr", column: "doing", milestone: "" }, false, {
        enforce: true,
      });
    } catch (err) {
      expect(err).toMatchObject({ code: "live_pr_milestone_required" });
    }
    // backlog is allowed without milestone (hygiene flags; not hard-reject)
    expect(() =>
      assertLivePrMilestone({ slug: "x", kind: "pr", column: "backlog", milestone: "" }, false, {
        enforce: true,
      })
    ).not.toThrow();
    expect(() =>
      assertLivePrMilestone({ slug: "x", kind: "pr", column: "doing", milestone: "ms-a" }, false, {
        enforce: true,
      })
    ).not.toThrow();
    // enforce flag off → no-op (unit-test default)
    expect(() =>
      assertLivePrMilestone({ slug: "x", kind: "pr", column: "todo", milestone: "" })
    ).not.toThrow();
  });

  test("allows non-pr, done column, backlog, and --force", () => {
    expect(() =>
      assertLivePrMilestone({ slug: "x", kind: "validation", column: "todo", milestone: "" }, false, {
        enforce: true,
      })
    ).not.toThrow();
    expect(() =>
      assertLivePrMilestone({ slug: "x", kind: "pr", column: "done", milestone: "" }, false, {
        enforce: true,
      })
    ).not.toThrow();
    expect(() =>
      assertLivePrMilestone({ slug: "x", kind: "pr", column: "todo", milestone: "" }, true, {
        enforce: true,
      })
    ).not.toThrow();
  });

  test("rejects abandoned milestones", () => {
    try {
      assertLivePrMilestone(
        { slug: "x", kind: "pr", column: "todo", milestone: "old" },
        false,
        { milestoneState: "abandoned", enforce: true },
      );
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toMatchObject({ code: "live_pr_milestone_abandoned" });
    }
  });

  test("add/move enforce live Kind:pr milestone with force escape", async () => {
    const node = fakeNode();
    await seedBoard(node);
    await milestoneAddCmd({
      cfg,
      node,
      slug: "ms-live",
      title: "Live",
      state: "active",
      northStar: "ns-a",
    });
    await expect(
      addCmd({
        cfg,
        node,
        slug: "no-ms-pr",
        title: "No MS",
        kind: "pr",
        column: "todo",
        repo: "EdgeVector/fkanban",
        base: "main",
        body: "## GOAL\nok\n## END STATE\nok\n",
      }),
    ).rejects.toMatchObject({ code: "live_pr_milestone_required" });

    await addCmd({
      cfg,
      node,
      slug: "with-ms-pr",
      title: "With MS",
      kind: "pr",
      column: "todo",
      milestone: "ms-live",
      northStar: "ns-a",
      repo: "EdgeVector/fkanban",
      base: "main",
      body: "## GOAL\nok\n## END STATE\nok\n",
    });

    await addCmd({
      cfg,
      node,
      slug: "force-pr",
      title: "Forced",
      kind: "pr",
      column: "backlog",
      repo: "EdgeVector/fkanban",
      base: "main",
      force: true,
      body: "## GOAL\nok\n## END STATE\nok\n",
    });
    await expect(moveCmd({
      cfg,
      node,
      slug: "force-pr",
      column: "todo",
    })).rejects.toMatchObject({ code: "live_pr_milestone_required" });
    await moveCmd({ cfg, node, slug: "force-pr", column: "todo", force: true });
  });

  test("move into default/todo uses the claim write-guard; set --milestone then explain is eligible", async () => {
    const node = fakeNode();
    await seedBoard(node);
    await milestoneAddCmd({
      cfg,
      node,
      slug: "ms-live",
      title: "Live",
      state: "active",
      northStar: "ns-a",
    });
    const brief =
      "Repo: EdgeVector/fkanban\nBase: main\nKind: pr\n\n## GOAL\nShip the gate.\n\n## END STATE\nMove and explain agree.\n";
    await addCmd({
      cfg,
      node,
      slug: "gate-pr",
      title: "Gate PR",
      kind: "pr",
      column: "backlog",
      repo: "EdgeVector/fkanban",
      base: "main",
      northStar: "ns-a",
      body: brief,
    });

    let moveErr: unknown;
    try {
      await moveCmd({ cfg, node, slug: "gate-pr", column: "todo" });
    } catch (err) {
      moveErr = err;
    }
    expect(moveErr).toMatchObject({
      code: "live_pr_milestone_required",
      message: 'Kind:pr card "gate-pr" cannot enter todo without a milestone.',
    });
    expect((moveErr as { hint?: string }).hint).toContain("kanban set gate-pr --milestone");
    expect((moveErr as { hint?: string }).hint).toContain("--north-star");

    const before = await pickupExplainResult({ cfg, node, slug: "gate-pr" });
    expect(before.write_guard.ok).toBe(false);
    expect(before.write_guard.code).toBe("live_pr_milestone_required");
    expect(before.write_guard.message).toBe((moveErr as { message: string }).message);
    expect(before.write_guard.hint).toBe((moveErr as { hint: string }).hint);
    expect(before.eligible_for_claim).toBe(false);

    await setCmd({ cfg, node, slug: "gate-pr", milestone: "ms-live" });
    await moveCmd({ cfg, node, slug: "gate-pr", column: "todo" });

    const after = await pickupExplainResult({ cfg, node, slug: "gate-pr" });
    expect(after.write_guard.ok).toBe(true);
    expect(after.column).toBe("todo");
    expect(after.eligible_for_claim).toBe(true);
    expect(after.category).toBe("pickup-ready");
  });
});
