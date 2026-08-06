/**
 * `milestone reconcile --apply` must not report a repair it did not make.
 *
 * The repair loop issues every write through `.catch(() => undefined)` and
 * increments `issued` unconditionally, so `issued` counts ATTEMPTS. Nothing
 * downstream distinguishes an attempt from a success:
 *
 *   - `repairs.issued` / `repairs.deferred` are identical whether the node
 *     accepted the write or refused it.
 *   - `renderRepairPlan` prints `index repair: N row(s) written`, which is a
 *     statement about the node that the command never checked.
 *
 * A `service_timeout` / "too many concurrent reads" is documented in CLAUDE.md
 * as ordinary backpressure on this node, not an outage — and it is exactly the
 * condition under which an operator reaches for `reconcile`. So the failure
 * mode is: the index is drifted, the heal is run, every write is shed, and the
 * command reports `index repair: 1 row(s) written` with `warnings: none`.
 * The drift survives and the operator has been told it is gone.
 *
 * ## This is the same defect as the read half, on the write half
 *
 * `test/milestone-reconcile-index-read-failure.test.ts` fixed the READ side of
 * this command and documented the rule the repo settled on: **REPORT, NEVER
 * REFUSE** — a heal that under-repairs is safe, a heal that does not run is
 * not. `MilestoneRepairPlan.index_read_failed` exists for precisely this, and
 * its doc comment says the counts "are only a claim about the DATA when this is
 * null". The write half had no such counter, so nothing below asserts the run
 * stops — only that it stops lying about what it wrote.
 */
import { describe, expect, test } from "bun:test";

import type { Config } from "../src/config.ts";
import type { NodeClient } from "../src/client.ts";
import { fakeNode, type FakeNode } from "./fake-node.ts";
import { milestoneAddCmd, milestoneReconcileResult } from "../src/commands/milestone.ts";
import { addCmd } from "../src/commands/add.ts";
import { boardToFields, nowIso } from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";

const MILESTONE_CARDS = "mscards-hash";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: {
    card: "cardhash",
    board: "boardhash",
    milestone: "milestonehash",
    board_cards: "boardcards-hash",
    board_milestones: "boardms-hash",
    milestone_cards: MILESTONE_CARDS,
  },
};

async function seed(node: FakeNode, milestone: string, slugs: string[]): Promise<void> {
  const now = nowIso();
  node.seed({
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
  await milestoneAddCmd({
    cfg,
    node,
    slug: milestone,
    title: `Outcome ${milestone}`,
    state: "active",
    northStar: `ns-${milestone}`,
    driver: "last-stack-milestone-driver",
  });
  for (const slug of slugs) {
    await addCmd({
      cfg,
      node,
      slug,
      title: `PR ${slug}`,
      milestone,
      northStar: `ns-${milestone}`,
      repo: "EdgeVector/fkanban",
      base: "main",
      kind: "pr",
      column: "todo",
      body: `Repo: EdgeVector/fkanban\nBase: main\n\n## GOAL\nWork ${slug}.\n\n## END STATE\nDone.\n`,
    });
  }
}

/**
 * Assert the partition really is unconverged before a test claims a repair was
 * lost. `seed` writes Cards, not MilestoneCards rows, so both seeded cards
 * classify as upserts — measured, not assumed. Without this a "drift survived"
 * assertion could be passing against a milestone that never had drift.
 */
async function pendingUpserts(node: NodeClient, milestone: string): Promise<number> {
  const plan = await milestoneReconcileResult({ cfg, node, slug: milestone, apply: false });
  return plan.repairs.upserts;
}

/**
 * Shed every WRITE against MilestoneCards, leaving reads intact.
 *
 * That asymmetry is the real shape and it is what makes the bug reachable: the
 * classifier reads fine, produces a correct repair plan, and only the writes
 * that would act on it are refused. A node shedding everything would be an
 * outage; this is backpressure.
 */
function shedsWrites(node: FakeNode): NodeClient {
  const refuse = async () => {
    throw new Error("service_timeout: node did not respond within 30000ms");
  };
  return new Proxy(node, {
    get(target, prop, receiver) {
      if (prop !== "createRecord" && prop !== "updateRecord" && prop !== "deleteRecord") {
        return Reflect.get(target, prop, receiver);
      }
      return async (req: { schemaHash: string }) => {
        if (req.schemaHash === MILESTONE_CARDS) return await refuse();
        return await (Reflect.get(target, prop, receiver) as (r: unknown) => Promise<unknown>)(req);
      };
    },
  }) as unknown as NodeClient;
}

describe("milestone reconcile: a shed repair WRITE is not a completed repair", () => {
  test("a refused repair write is counted as failed, not as written", async () => {
    const node = fakeNode();
    await seed(node, "ms-wfail", ["wf-a", "wf-b"]);
    expect(await pendingUpserts(node, "ms-wfail")).toBe(2);

    const r = await milestoneReconcileResult({
      cfg,
      node: shedsWrites(node),
      slug: "ms-wfail",
    });

    // The plan was classified correctly — this is not a read failure.
    expect(r.repairs.index_read_failed).toBeNull();
    expect(r.repairs.upserts).toBe(2);
    expect(r.repairs.issued).toBe(2);

    // Every write was refused, so nothing was written.
    expect(r.repairs.failed).toBe(2);
    expect(r.repairs.written).toBe(0);
  });

  test("the operator is told the repair failed, not that a row was written", async () => {
    const node = fakeNode();
    await seed(node, "ms-wtext", ["wt-a", "wt-b"]);

    const r = await milestoneReconcileResult({
      cfg,
      node: shedsWrites(node),
      slug: "ms-wtext",
    });

    expect(r.text).not.toContain("2 row(s) written");
    expect(r.text).toContain("0 row(s) written");
    expect(r.text).toContain("REPAIR WRITE REFUSED");
  });

  // The control: with writes ACCEPTED the same drift must report a real write
  // and no failure. Without this, both assertions above would pass against a
  // build that simply never reports a write at all.
  test("control — an accepted repair write still reports as written", async () => {
    const node = fakeNode();
    await seed(node, "ms-wok", ["wok-a", "wok-b"]);
    expect(await pendingUpserts(node, "ms-wok")).toBe(2);

    const r = await milestoneReconcileResult({ cfg, node, slug: "ms-wok" });

    expect(r.repairs.failed).toBe(0);
    expect(r.repairs.written).toBe(2);
    expect(r.text).toContain("2 row(s) written");
    expect(r.text).not.toContain("REPAIR WRITE REFUSED");
  });

  // The drift must SURVIVE a shed write. If the fake let the row through
  // anyway, the two tests above would be asserting against a repaired index
  // and the failure counter would be the only thing they measured.
  test("control — the drift the refused write would have fixed is still there", async () => {
    const node = fakeNode();
    await seed(node, "ms-wdrift", ["wd-a", "wd-b"]);
    expect(await pendingUpserts(node, "ms-wdrift")).toBe(2);

    await milestoneReconcileResult({ cfg, node: shedsWrites(node), slug: "ms-wdrift" });

    // Re-classify against the unproxied node: the same upserts are still needed.
    expect(await pendingUpserts(node, "ms-wdrift")).toBe(2);
  });
});
