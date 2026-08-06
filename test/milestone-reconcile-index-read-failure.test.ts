/**
 * `milestone reconcile` / `detail` must not report a shed MilestoneCards read
 * as a converged milestone.
 *
 * The reconcile wave issues TWO reads against the same partition, and both
 * return `null` from a bare `catch {}`:
 *
 *   - `listMilestoneCardsPartition`      — the wide payload read
 *   - `listMilestoneCardsPartitionSpine` — the address enumeration
 *
 * A `service_timeout` / "too many concurrent reads" — documented in CLAUDE.md
 * as ordinary backpressure on this node, not an outage — was therefore
 * indistinguishable from an empty partition, and each half produced a different
 * lie:
 *
 *   - wide null  => the classifier is skipped entirely and the repair plan is
 *                   hard-coded to all-zero. `renderRepairPlan` returns nothing
 *                   when `classified === 0`, so the command printed EXACTLY
 *                   what a converged milestone prints, down to `warnings: none`.
 *   - spine null => `indexAddresses ?? []`, so every card classifies stale and
 *                   queues an unverified upsert, while every orphan removal is
 *                   skipped because `rows[0]` is undefined — reported as
 *                   `removals: 0`, which reads as "no orphans".
 *
 * ## Measured, not derived
 *
 * `scripts/probe-milestone-reconcile-read-shed-silence.ts` runs the real
 * classifier against the live primary in `apply: false` mode under all three
 * arms. On 2026-08-06:
 *
 *   | milestone                          | arm   | upserts | removals | line? |
 *   |------------------------------------|-------|---------|----------|-------|
 *   | lastdb-mutation-phase-observability| none  | 0       | 0        | NO    |
 *   | lastdb-mutation-phase-observability| wide  | 0       | 0        | NO    |  <- byte-identical
 *   | operation-trinity-m0-charter       | none  | 0       | 1        | yes   |
 *   | operation-trinity-m0-charter       | wide  | 0       | 0        | NO    |  <- real orphan lost
 *   | operation-trinity-m0-charter       | spine | 0       | 0        | NO    |  <- real orphan lost
 *   | lastdb-0231-read-regression-fixes  | none  | 7       | 0        | yes   |
 *   | lastdb-0231-read-regression-fixes  | spine | 11      | 0        | yes   |  <- 4 unverified
 *
 * Every shed arm above also printed `warnings: none`.
 *
 * ## This is the fifth instance of one pattern, and the fix shape is fixed
 *
 * `sweepBoardCardsPartition`, `board_cards_heal`, the enumeration sweep, and
 * `milestone_indexes_heal` each learned the same lesson separately. The rule
 * this repo settled on is REPORT, NEVER REFUSE: a heal that under-repairs is
 * safe, a heal that does not run is not. So nothing below asserts that the run
 * stops — only that it stops lying about what it saw.
 */
import { describe, expect, test } from "bun:test";

import type { Config } from "../src/config.ts";
import type { NodeClient } from "../src/client.ts";
import { fakeNode, type FakeNode } from "./fake-node.ts";
import { milestoneAddCmd, milestoneReconcileResult } from "../src/commands/milestone.ts";
import { addCmd } from "../src/commands/add.ts";
import { boardToFields, findCard, nowIso } from "../src/record.ts";
import { milestoneCardFieldsFromCard } from "../src/milestone-cards.ts";
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

/**
 * The same config with MilestoneCards simply not bound — not a failure.
 *
 * The key is OMITTED rather than set to `undefined`: `schemaHashes` is
 * `Record<string, string>`, and an explicit undefined is both a type error and
 * a different shape from the one a real unbound config has.
 */
const cfgUnbound: Config = (() => {
  const { milestone_cards: _unbound, ...rest } = cfg.schemaHashes;
  return { ...cfg, schemaHashes: rest };
})();

async function seed(node: FakeNode, milestone: string, slugs: string[]): Promise<void> {
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

/** The converged MilestoneCards row a reconciled card has. */
async function seedRow(node: FakeNode, milestone: string, slug: string): Promise<void> {
  const card = await findCard(node, cfg, slug);
  const fields = { ...milestoneCardFieldsFromCard(card!)! };
  node.seed({ schemaHash: MILESTONE_CARDS, keyHash: milestone, rangeKey: String(fields.sk), fields });
}

/**
 * Shed one half of the MilestoneCards partition read, discriminated by
 * projection width — the spine projects `slug` alone.
 *
 * Only that schema, and only the keyed partition query: point reads still
 * answer, which is the real shape. The node sheds a broad query and serves a
 * narrow one.
 */
function sheds(node: FakeNode, which: "wide" | "spine"): NodeClient {
  return new Proxy(node, {
    get(target, prop, receiver) {
      if (prop !== "queryAll") return Reflect.get(target, prop, receiver);
      return async (req: Parameters<NodeClient["queryAll"]>[0]) => {
        const filter = req.filter as { HashKey?: unknown } | undefined;
        if (req.schemaHash === MILESTONE_CARDS && filter?.HashKey !== undefined) {
          const isSpine = req.fields.length === 1 && req.fields[0] === "slug";
          if ((which === "spine") === isSpine) {
            throw new Error("service_timeout: node did not respond within 30000ms");
          }
        }
        return await target.queryAll(req);
      };
    },
  }) as unknown as NodeClient;
}

describe("milestone reconcile: a shed MilestoneCards read is not a converged milestone", () => {
  test("a shed WIDE read is named in the repair plan", async () => {
    const node = await (async () => {
      const n = fakeNode();
      await seed(n, "ms-wide", ["work-a"]);
      await seedRow(n, "ms-wide", "work-a");
      return n;
    })();

    const r = await milestoneReconcileResult({ cfg, node: sheds(node, "wide"), slug: "ms-wide", apply: false });

    expect(r.repairs.index_read_failed).toBe("payload");
  });

  test("a shed SPINE read is named in the repair plan", async () => {
    const node = fakeNode();
    await seed(node, "ms-spine", ["work-a"]);
    await seedRow(node, "ms-spine", "work-a");

    const r = await milestoneReconcileResult({ cfg, node: sheds(node, "spine"), slug: "ms-spine", apply: false });

    expect(r.repairs.index_read_failed).toBe("addresses");
  });

  test("the consequence is in the rendered text, not only in JSON", async () => {
    // The silent case: an all-zero plan renders byte-identically to a converged
    // milestone, because `renderRepairPlan` returns nothing at `classified === 0`.
    // So the banner has to come from somewhere the repair line does not.
    const node = fakeNode();
    await seed(node, "ms-text", ["work-a"]);
    await seedRow(node, "ms-text", "work-a");

    const r = await milestoneReconcileResult({ cfg, node: sheds(node, "wide"), slug: "ms-text", apply: false });

    expect(r.text).toContain("⚠ INDEX READ INCOMPLETE");
    expect(r.text).toContain("the payload read (what the index rows say)");
  });

  test("`warnings: none` no longer covers a milestone nobody read", async () => {
    // `warnings` is the machine-readable surface — `milestone groom`, the
    // portfolio `warning_count`, every `--json` consumer. The banner does not
    // reach any of them.
    const node = fakeNode();
    await seed(node, "ms-warn", ["work-a"]);
    await seedRow(node, "ms-warn", "work-a");

    const r = await milestoneReconcileResult({ cfg, node: sheds(node, "wide"), slug: "ms-warn", apply: false });

    expect(r.warnings.map((w) => w.code)).toContain("unreadable-milestone-index");
    expect(r.text).not.toContain("warnings: none");
  });

  test("the banner sits ABOVE every count it qualifies", async () => {
    // Placement, not presence. A caveat appended below `index drift: 11 row(s)`
    // is read as part of the good news — the exact way `board_cards_heal_scheduled`
    // came to print `clean` for a run with no coverage. The spine arm is used
    // because it is the one that produces BOTH a banner and a repair line.
    const node = fakeNode();
    await seed(node, "ms-order", ["work-a", "work-b"]);
    await seedRow(node, "ms-order", "work-a");
    await seedRow(node, "ms-order", "work-b");

    const r = await milestoneReconcileResult({ cfg, node: sheds(node, "spine"), slug: "ms-order", apply: false });
    const lines = r.text.split("\n");
    const banner = lines.findIndex((l) => l.includes("⚠ INDEX READ INCOMPLETE"));
    const repair = lines.findIndex((l) => l.startsWith("index drift:") || l.startsWith("index repair:"));
    const warnings = lines.findIndex((l) => l.startsWith("warnings"));

    expect(banner).toBeGreaterThanOrEqual(0);
    expect(repair).toBeGreaterThan(banner);
    expect(warnings).toBeGreaterThan(banner);
  });

  test("a shed spine read inflates the classification, and that is what is being warned about", async () => {
    // Behaviour pin, deliberately not a regression test: this passes with the
    // fix reverted. It exists to state WHY the warning is worth printing — the
    // counts under a shed spine read are every card, not the drifted ones — and
    // to fail loudly if someone later makes this path refuse instead of report.
    const node = fakeNode();
    await seed(node, "ms-inflate", ["work-a", "work-b"]);
    await seedRow(node, "ms-inflate", "work-a");
    await seedRow(node, "ms-inflate", "work-b");

    const healthy = await milestoneReconcileResult({ cfg, node, slug: "ms-inflate", apply: false });
    const shed = await milestoneReconcileResult({ cfg, node: sheds(node, "spine"), slug: "ms-inflate", apply: false });

    expect(healthy.repairs.upserts).toBe(0);
    expect(shed.repairs.upserts).toBe(2);
  });
});

describe("the gate stays quiet when it should", () => {
  test("a healthy run prints no banner", async () => {
    // MUST survive a revert of the fix. A gate that fires on every run gets
    // muted in a week, and the test guarding against that has to pass when the
    // feature is absent — the mistake run (p) and run (a) each made once.
    const node = fakeNode();
    await seed(node, "ms-clean", ["work-a"]);
    await seedRow(node, "ms-clean", "work-a");

    const r = await milestoneReconcileResult({ cfg, node, slug: "ms-clean", apply: false });

    expect(r.text).not.toContain("INDEX READ INCOMPLETE");
    expect(r.warnings.map((w) => w.code)).not.toContain("unreadable-milestone-index");
  });

  test("a healthy run reports no read failure", async () => {
    const node = fakeNode();
    await seed(node, "ms-clean2", ["work-a"]);
    await seedRow(node, "ms-clean2", "work-a");

    const r = await milestoneReconcileResult({ cfg, node, slug: "ms-clean2", apply: false });

    expect(r.repairs.index_read_failed).toBeNull();
  });

  test("an UNBOUND MilestoneCards index is not a read failure", async () => {
    // Both reads return `null` here too — from `if (!schemaHash) return null`,
    // before any query is issued. Deriving the flag from the `null` alone would
    // flag every milestone on a node where the index is simply not bound, which
    // is the false-positive that mutes the gate. The discriminator is the hash.
    const node = fakeNode();
    await seed(node, "ms-unbound", ["work-a"]);

    const r = await milestoneReconcileResult({ cfg: cfgUnbound, node, slug: "ms-unbound", apply: false });

    expect(r.repairs.index_read_failed).toBeNull();
    expect(r.text).not.toContain("INDEX READ INCOMPLETE");
  });
});
