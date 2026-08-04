/**
 * The wide MilestoneCards read must not be gated on the partition key.
 *
 * `listMilestoneCardsPartition` is the read behind `milestone detail`,
 * `milestone reconcile` and every milestone rollup. It projected
 * `MILESTONE_CARDS_FIELDS`, whose first entry is `milestone` — the HASH field —
 * and the node gates a row on the hash field whenever the hash field appears in
 * the projection. A row whose payload copy of the partition key did not persist
 * was therefore invisible to every one of those callers, while remaining
 * addressable and remaining visible to the spine read that deletes rows. The
 * half that DECIDES could not see rows the half that DELETES could.
 *
 * ## The rule these tests encode, and why the old one did not catch this
 *
 * Three read paths shipped on "a row is returned iff the field LEADING the
 * projection has an atom". Measured on the live primary 2026-08-04 against four
 * constructed rows with verified atom sets
 * (`scripts/probe-projection-rule-constructed.ts` — 51 projections x 4 rows):
 *
 *     LEAD            191 correct / 13 wrong
 *     ANY             173 / 31
 *     LEAD+KEY        193 / 11
 *     HASH-ELSE-LEAD  204 / 0
 *
 * Under LEAD, the fix would have been to move `slug` to the front. That was
 * tried against the live board first and recovered NOTHING
 * (`scripts/probe-milestone-detail-lead-drop.ts`), because the hash field gates
 * from wherever it sits. The gate moves only when the field is REMOVED.
 *
 * These tests therefore run the fake in `hash_else_lead` mode. The first
 * describe block is a guard against the guard: if the oracle does not
 * reproduce the node's rule, nothing below means anything.
 */
import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config.ts";
import { fakeNode, type FakeNode } from "./fake-node.ts";
import {
  findMilestoneCardBySk,
  listMilestoneCardsPartition,
  MILESTONE_CARDS_PAYLOAD_FIELDS,
  milestoneCardSk,
} from "../src/milestone-cards.ts";
import { MILESTONE_CARDS_FIELDS, MILESTONE_CARDS_LAYOUT } from "../src/schemas.ts";

const MC_HASH = "milestone-cards-hash";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://127.0.0.1:9",
  userHash: "user",
  schemaServiceUrl: "http://127.0.0.1:9",
  schemaHashes: { milestone_cards: MC_HASH },
};

/** The node as measured: one gate, hash field if projected, else the lead. */
function measuredNode(): FakeNode {
  return fakeNode({
    baseUrl: cfg.nodeUrl,
    userHash: cfg.userHash,
    projectionRule: "hash_else_lead",
    hashFields: { [MC_HASH]: "milestone" },
  });
}

const SK = milestoneCardSk("todo", "10", "card-a");

function mcRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    milestone: "ms-a",
    sk: SK,
    slug: "card-a",
    title: "Card A",
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
    db: "",
    repo: "",
    base: "",
    kind: "pr",
    block_status: "",
    block_reason: "",
    north_star: "",
    pr_url: "",
    branch: "",
    layout: MILESTONE_CARDS_LAYOUT,
    ...over,
  };
}

/** The live shape: a row that lost exactly its payload copy of the hash field. */
function seedRowWithoutHashAtom(node: FakeNode): void {
  const fields = mcRow();
  delete fields.milestone;
  node.seed({ schemaHash: MC_HASH, keyHash: "ms-a", rangeKey: SK, fields });
}

describe("the oracle reproduces HASH-ELSE-LEAD", () => {
  // Each of these is a case that killed one of the other candidate rules on the
  // live primary. If the fake passes them it is modelling the measured node,
  // not a convenient approximation of it.
  test("the hash field gates from a NON-leading position (kills LEAD)", async () => {
    const node = measuredNode();
    seedRowWithoutHashAtom(node);

    const res = await node.queryAll({
      schemaHash: MC_HASH,
      fields: ["slug", "milestone"],
      filter: { HashKey: "ms-a" },
    });
    expect(res.results).toEqual([]);
  });

  test("an ordinary missing field does NOT drop the row (kills ANY)", async () => {
    const node = measuredNode();
    const fields = mcRow();
    delete fields.kind;
    node.seed({ schemaHash: MC_HASH, keyHash: "ms-a", rangeKey: SK, fields });

    const res = await node.queryAll({
      schemaHash: MC_HASH,
      fields: ["slug", "kind"],
      filter: { HashKey: "ms-a" },
    });
    expect(res.results).toHaveLength(1);
    // Returned WITHOUT the absent key — omitted, not `undefined`.
    expect("kind" in res.results[0]!.fields).toBe(false);
  });

  test("an absent lead does not drop a row the hash field can gate (kills LEAD+KEY)", async () => {
    const node = measuredNode();
    const fields = mcRow();
    delete fields.title;
    node.seed({ schemaHash: MC_HASH, keyHash: "ms-a", rangeKey: SK, fields });

    const res = await node.queryAll({
      schemaHash: MC_HASH,
      fields: ["title", "milestone"],
      filter: { HashKey: "ms-a" },
    });
    expect(res.results).toHaveLength(1);
  });

  test("with the hash field absent from the projection, the LEAD gates", async () => {
    const node = measuredNode();
    const fields = mcRow();
    delete fields.title;
    node.seed({ schemaHash: MC_HASH, keyHash: "ms-a", rangeKey: SK, fields });

    const led = await node.queryAll({
      schemaHash: MC_HASH,
      fields: ["title", "slug"],
      filter: { HashKey: "ms-a" },
    });
    expect(led.results).toEqual([]);
  });
});

describe("the wide read reaches a row whose hash atom is gone", () => {
  test("the projection does not contain the partition key", () => {
    // Stated as a fact about the constant, not only about a call: this is the
    // whole mechanism, and a future edit that re-adds `milestone` for
    // tidiness would silently restore the blind spot.
    expect([...MILESTONE_CARDS_PAYLOAD_FIELDS]).not.toContain("milestone");
    // …and it must still carry the payload the callers render.
    for (const f of MILESTONE_CARDS_FIELDS) {
      if (f === "milestone") continue;
      expect([...MILESTONE_CARDS_PAYLOAD_FIELDS], f).toContain(f);
    }
  });

  test("the fixture is genuinely invisible under the OLD projection", async () => {
    // The half whose absence lets a fixed test pass green against an unfixed
    // read. If this ever stops failing, the test below proves nothing.
    const node = measuredNode();
    seedRowWithoutHashAtom(node);

    const old = await node.queryAll({
      schemaHash: MC_HASH,
      fields: [...MILESTONE_CARDS_FIELDS],
      filter: { HashKey: "ms-a" },
    });
    expect(old.results).toEqual([]);
  });

  test("listMilestoneCardsPartition returns it", async () => {
    const node = measuredNode();
    seedRowWithoutHashAtom(node);

    const cards = await listMilestoneCardsPartition(node, cfg, "ms-a");

    expect(cards?.map((c) => c.slug)).toEqual(["card-a"]);
  });

  test("the returned card carries the milestone, taken from the filter argument", async () => {
    // `reconcileMilestoneCardChildren` compares `summary.milestone` against
    // truth. Recovering the row but handing back an empty milestone would swap
    // an invisible row for a permanently-stale one — every run classifying it
    // as needing an upsert, forever.
    const node = measuredNode();
    seedRowWithoutHashAtom(node);

    const cards = await listMilestoneCardsPartition(node, cfg, "ms-a");

    expect(cards?.[0]?.milestone).toBe("ms-a");
  });

  test("findMilestoneCardBySk returns it, with the milestone stamped", async () => {
    const node = measuredNode();
    seedRowWithoutHashAtom(node);

    const card = await findMilestoneCardBySk(node, cfg, "ms-a", SK);

    expect(card?.slug).toBe("card-a");
    expect(card?.milestone).toBe("ms-a");
  });

  test("a row that DOES carry the hash atom is unchanged", async () => {
    // The fix must be a recovery, not a swap: rows that were always visible
    // still are, and still read the same.
    const node = measuredNode();
    node.seed({ schemaHash: MC_HASH, keyHash: "ms-a", rangeKey: SK, fields: mcRow() });

    const cards = await listMilestoneCardsPartition(node, cfg, "ms-a");

    expect(cards).toHaveLength(1);
    expect(cards?.[0]?.slug).toBe("card-a");
    expect(cards?.[0]?.milestone).toBe("ms-a");
    expect(cards?.[0]?.title).toBe("Card A");
  });

  test("a foreign-layout row is still refused", async () => {
    // The recovery must not become a way past the layout check.
    const node = measuredNode();
    const fields = mcRow({ layout: "some_other_layout" });
    delete fields.milestone;
    node.seed({ schemaHash: MC_HASH, keyHash: "ms-a", rangeKey: SK, fields });

    expect(await listMilestoneCardsPartition(node, cfg, "ms-a")).toEqual([]);
  });
});
