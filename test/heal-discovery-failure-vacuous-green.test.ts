// `board-cards heal` must not report a clean board from a run whose discovery
// never happened.
//
// This is the same defect class the file already names for the OTHER half of
// its reads. `sweepBoardCardsPartition` reports `failedLeads`, and heal renders
// them as a loud `⚠ INCOMPLETE`, with the reason spelled out at the call site:
// "silence would make the next run's `missing_card: 0` look like convergence."
//
// Twelve lines earlier, the candidate-discovery scan was wrapped in a bare
// `catch {}` that did exactly that.
//
// ## Why the documented fallback is not one
//
// The comment on that catch said "fall back to the rollup". Measured on the
// live primary 2026-08-05 (`probe-heal-discovery-fallback.ts`):
//
//   board_cards bound:                      true
//   rollup SUPERSEDED (write path retired): true
//   all_cards rollup entries:               0
//   Card full scan:                         217 distinct slugs in 822ms
//
// `cardListIndexIsSuperseded(cfg)` is true whenever `board_cards` is bound —
// i.e. on every current node — and both `writeCardListIndex` and
// `patchCardListIndex` return early in that case. So the rollup is FROZEN, and
// on this node it has already been emptied by `card-list-index-retire`. The
// fallback is a fallback to ZERO candidates.
//
// The two halves of heal fail in opposite directions, which is why only one of
// them was noticed:
//
//   - a refused partition LEAD costs heal rows it could have DELETED
//     (under-reap: safe, and already reported);
//   - a refused SCAN costs heal every card whose Card record is live and whose
//     BoardCards row is missing — cards invisible to `kanban list` entirely,
//     which is the condition heal exists to repair. Nothing else re-derives
//     them, and the run reports `missing_card=0 drifted=0` and exits 0.
//
// `last-stack-fkanban-watch` has run this command hourly with `--apply` since
// 2026-07-30. A `service_timeout` or "too many concurrent reads" on that one
// read — both documented as routine load signals on this node — produced a run
// indistinguishable from a converged one.
//
// ## And the unbound case, which claims work it did not do
//
// With `board_cards` unbound every partition read returns null, every write
// no-ops in `upsertBoardCard`'s `if (!schemaHash) return`, and heal still
// counted `healed += 1` per candidate. Measured pre-fix on a 5-entry
// `all_cards` rollup: `scanned=0 drifted=5 healed=5` with **0 BoardCards
// writes** — one claimed repair per rollup entry, none of them written.
//
// On a node that has run `card-list-index-retire` the rollup is empty, so the
// same state renders `scanned=0 drifted=0 healed=0` instead: quieter, same
// defect. That is what the live primary produces (measured 2026-08-05 against
// a config with `board_cards` removed), and it is why the fixture here asserts
// on the report shape rather than on a particular repair count.
//
// `board-list-heal` and `milestone-indexes-heal` both refuse this state by
// name; this command was the one that did not.

import { beforeEach, describe, expect, test } from "bun:test";

import { fakeNode, type FakeNode } from "./fake-node.ts";
import type { Config } from "../src/config.ts";
import { boardCardsHealResult } from "../src/commands/board_cards_heal.ts";
import { boardToFields, cardToFields, nowIso, type Card } from "../src/record.ts";
import { boardCardFieldsFromCard, boardCardSk } from "../src/board-cards.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: {
    card: "cardhash",
    board: "boardhash",
    board_cards: "boardcardshash",
    card_list_index: "cardlistindexhash",
  },
};

/** The same config with BoardCards unbound — every read null, every write a no-op. */
const cfgUnbound: Config = {
  ...cfg,
  schemaHashes: { card: "cardhash", board: "boardhash", card_list_index: "cardlistindexhash" },
};

/** The load signal CLAUDE.md documents as routine on this node, not a dead node. */
const LOAD_ERROR = "too many concurrent reads";

function card(over: Partial<Card> & { slug: string }): Card {
  const now = nowIso();
  return {
    slug: over.slug,
    title: over.title ?? over.slug,
    body: "",
    board: over.board ?? "default",
    column: over.column ?? "todo",
    position: over.position ?? "m",
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

function seedBoard(node: FakeNode, slug: string): void {
  const now = nowIso();
  node.seed({
    schemaHash: "boardhash",
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

function seedCardTruth(node: FakeNode, c: Card): void {
  node.seed({ schemaHash: "cardhash", keyHash: c.slug, fields: cardToFields(c) });
}

function seedMembership(node: FakeNode, c: Card, at?: { column: string; position: string }): void {
  const column = at?.column ?? c.column;
  const position = at?.position ?? c.position;
  node.seed({
    schemaHash: "boardcardshash",
    keyHash: c.board,
    rangeKey: boardCardSk(column, position, c.slug),
    fields: boardCardFieldsFromCard({ ...c, column, position }),
  });
}

/**
 * A node that refuses the Card FULL SCAN and answers every keyed read normally.
 *
 * Narrow on purpose: the point-reads that authorize repairs must keep working,
 * so the only thing this run loses is candidate DISCOVERY. A fake that failed
 * every Card read would prove something else entirely.
 */
function withFailingCardScan(node: FakeNode): FakeNode {
  const inner = node.queryAll.bind(node);
  return {
    ...node,
    queryAll: (async (req: Parameters<FakeNode["queryAll"]>[0]) => {
      const r = req as { schemaHash: string; allowFullScan?: boolean };
      if (r.allowFullScan && r.schemaHash === "cardhash") throw new Error(LOAD_ERROR);
      return inner(req);
    }) as FakeNode["queryAll"],
  };
}

describe("a heal whose discovery scan was refused must not report a clean board", () => {
  let node: FakeNode;
  // Card truth is live; BoardCards row is missing. Invisible to `kanban list`
  // until heal restores it, and ONLY the discovery scan can find it.
  const unmembered = card({ slug: "card-with-no-membership-row" });
  // Membership row exists but sits in the wrong column. Visible on the
  // partition, so heal finds it WITHOUT the scan — the control.
  const misplaced = card({ slug: "card-in-wrong-column", column: "doing", position: "n" });

  beforeEach(() => {
    node = fakeNode();
    seedBoard(node, "default");
    seedCardTruth(node, unmembered);
    seedCardTruth(node, misplaced);
    seedMembership(node, misplaced, { column: "todo", position: "n" });
  });

  // NON-VACUITY. Every negative assertion below is only meaningful if the
  // fixture really reproduces the hazard: with a WORKING scan the unmembered
  // card must be discovered and repaired. A fixture that quietly stopped
  // seeding it would make the rest of this file pass for the wrong reason.
  test("control: a working scan discovers the unmembered card", async () => {
    const { report, text } = await boardCardsHealResult({ cfg, node, json: true });

    const action = report.actions.find((a) => a.slug === unmembered.slug);
    expect(action?.action).toBe("upsert-truth");
    expect(report.discovery_failed).toBeNull();
    expect(text).not.toContain("DISCOVERY");
  });

  test("a refused scan is reported, not swallowed", async () => {
    const { report } = await boardCardsHealResult({ cfg, node: withFailingCardScan(node), json: true });

    expect(report.discovery_failed).toContain(LOAD_ERROR);
  });

  test("the operator's line says the counts are a lower bound, not a clean board", async () => {
    const { text } = await boardCardsHealResult({ cfg, node: withFailingCardScan(node), json: false });

    // Loud, and it must name the CONSEQUENCE — a bare error string next to
    // `missing_card=0` still reads as a clean board with a hiccup.
    expect(text).toContain("⚠");
    expect(text).toContain("DISCOVERY INCOMPLETE");
    expect(text).toContain(LOAD_ERROR);
    expect(text.toLowerCase()).toContain("lower bound");
  });

  test("it still repairs what it can see — reporting is not refusing", async () => {
    const { report } = await boardCardsHealResult({
      cfg,
      node: withFailingCardScan(node),
      apply: true,
      json: true,
    });

    // The misplaced row is on the partition, so the scan was never needed for
    // it. A transient scan timeout must not disable the hourly heal outright:
    // heal under-repairing is safe, heal not running is not.
    const action = report.actions.find((a) => a.slug === misplaced.slug);
    expect(action?.action).toBe("delete-stale-and-upsert");
    expect(report.healed).toBeGreaterThan(0);
    expect(report.blocked).toBe(false);
  });

  test("the unmembered card is absent from the run, which is exactly what the warning is for", async () => {
    const { report } = await boardCardsHealResult({ cfg, node: withFailingCardScan(node), json: true });

    // Not a bug to fix here — heal cannot repair what the node would not
    // enumerate. The defect was claiming otherwise.
    expect(report.actions.find((a) => a.slug === unmembered.slug)).toBeUndefined();
    // `not.toBeNull()` would pass on the old `undefined` field and make this a
    // vacuous green of exactly the kind the file is about.
    expect(typeof report.discovery_failed).toBe("string");
  });
});

describe("a heal with BoardCards unbound must not claim repairs it cannot write", () => {
  let node: FakeNode;
  const c = card({ slug: "card-on-an-unbound-node" });

  beforeEach(() => {
    node = fakeNode();
    seedBoard(node, "default");
    seedCardTruth(node, c);
  });

  test("it reports NOT CHECKED rather than a per-card repair count", async () => {
    const { report, text } = await boardCardsHealResult({ cfg: cfgUnbound, node, json: true });

    expect(report.board_cards_bound).toBe(false);
    expect(report.drifted).toBe(0);
    expect(report.healed).toBe(0);
    expect(report.actions).toHaveLength(0);
    expect(text).toContain("NOT CHECKED");
  });

  test("--apply writes nothing and says so", async () => {
    const before = node.writes.length;
    const { report } = await boardCardsHealResult({ cfg: cfgUnbound, node, apply: true, json: true });

    expect(node.writes.length).toBe(before);
    // The old code reported one `healed` per card here, for zero writes.
    expect(report.healed).toBe(0);
  });

  test("a bound node still reports its repairs — the guard is not a blanket mute", async () => {
    const { report } = await boardCardsHealResult({ cfg, node, json: true });

    expect(report.board_cards_bound).toBe(true);
    expect(report.actions.find((a) => a.slug === c.slug)?.action).toBe("upsert-truth");
  });
});
