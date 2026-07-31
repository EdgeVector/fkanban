/**
 * A live-but-SPARSE proof card must not read as a missing one.
 *
 * A LastDB query returns a row only when every projected field has an atom on
 * it, so a card missing one field is dropped from a wide read with no error —
 * indistinguishable from deleted. `findCard` projects ~20 fields, so using it to
 * answer "does this exist?" inherits that false negative.
 *
 * The destructive instance (board-cards-heal deleting the membership of a sparse
 * card) was fixed in fkanban 8702be5 and is covered by
 * projection-drops-rows.test.ts. These cover the BLOCKING instances that were
 * left open: the milestone gates, where a sparse proof card made the milestone
 * unlinkable and untransitionable, with an error that sent the operator looking
 * for a card sitting right there.
 *
 * Existence is a key-only question, so it is asked with a key-only read
 * (`cardExists`, which projects `slug` alone and cannot false-negative).
 * Hydration still needs the fields — but when a hydrating read comes back empty,
 * absence is confirmed key-only before it is reported, so "sparse" and "absent"
 * get different errors.
 */
import { describe, expect, test } from "bun:test";

import type { NodeClient, QueryFilter, QueryResponse, QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { milestoneAddCmd, milestoneStateCmd, milestoneReconcileResult } from "../src/commands/milestone.ts";
import { cardExists, emptyStructuredFields, findCard, type Card } from "../src/record.ts";

const CARD_HASH = "card-hash";
const BOARD_HASH = "board-hash";
const MILESTONE_HASH = "milestone-hash";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://127.0.0.1:9",
  userHash: "user",
  schemaServiceUrl: "http://127.0.0.1:9",
  schemaHashes: { board: BOARD_HASH, card: CARD_HASH, milestone: MILESTONE_HASH },
};

type StoredRecord = { keyHash: string; rangeKey: string | null; fields: Record<string, unknown> };

/**
 * A node that drops rows the way LastDB does: a row is returned only if EVERY
 * requested field is present on it. A fake that ignores `fields` cannot
 * reproduce any of this.
 */
function projectionFaithfulNode(seed: {
  cards: Array<Record<string, unknown>>;
  milestones?: Array<Record<string, unknown>>;
}): NodeClient {
  const store = new Map<string, Map<string, StoredRecord>>();
  const storeKey = (keyHash: string, rangeKey?: string | null) => `${keyHash}\0${rangeKey ?? ""}`;
  const tableFor = (schemaHash: string) => {
    let t = store.get(schemaHash);
    if (!t) store.set(schemaHash, (t = new Map()));
    return t;
  };

  for (const c of seed.cards) {
    tableFor(CARD_HASH).set(storeKey(String(c.slug), null), { keyHash: String(c.slug), rangeKey: null, fields: { ...c } });
  }
  for (const m of seed.milestones ?? []) {
    tableFor(MILESTONE_HASH).set(storeKey(String(m.slug), null), { keyHash: String(m.slug), rangeKey: null, fields: { ...m } });
  }
  tableFor(BOARD_HASH).set(storeKey("default", null), {
    keyHash: "default",
    rangeKey: null,
    fields: {
      slug: "default",
      title: "Default",
      body: "",
      columns: ["backlog", "todo", "doing", "done"],
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
  });

  const matchesFilter = (rec: StoredRecord, filter?: QueryFilter): boolean => {
    if (!filter) return true;
    const f = filter as Record<string, unknown>;
    if (typeof f.HashKey === "string") return rec.keyHash === f.HashKey;
    const prefix = f.HashRangePrefix as { hash: string; prefix: string } | undefined;
    if (prefix) return rec.keyHash === prefix.hash && (rec.rangeKey ?? "").startsWith(prefix.prefix);
    return true;
  };
  const notImpl = (m: string) => async (): Promise<never> => {
    throw new Error(`fakeNode.${m} not implemented`);
  };

  return {
    baseUrl: cfg.nodeUrl,
    userHash: cfg.userHash,
    autoIdentity: notImpl("autoIdentity"),
    bootstrap: notImpl("bootstrap"),
    loadSchemas: notImpl("loadSchemas"),
    listSchemas: notImpl("listSchemas"),
    async createRecord({ schemaHash, fields, keyHash, rangeKey }) {
      tableFor(schemaHash).set(storeKey(keyHash, rangeKey), { keyHash, rangeKey: rangeKey ?? null, fields: { ...fields } });
    },
    async updateRecord({ schemaHash, fields, keyHash, rangeKey }) {
      tableFor(schemaHash).set(storeKey(keyHash, rangeKey), { keyHash, rangeKey: rangeKey ?? null, fields: { ...tableFor(schemaHash).get(storeKey(keyHash, rangeKey))?.fields, ...fields } });
    },
    async deleteRecord({ schemaHash, keyHash, rangeKey }) {
      tableFor(schemaHash).delete(storeKey(keyHash, rangeKey));
    },
    async queryAll({ schemaHash, fields, filter }): Promise<QueryResponse> {
      const results: QueryRow[] = [];
      for (const rec of tableFor(schemaHash).values()) {
        if (!matchesFilter(rec, filter)) continue;
        // THE RULE: any projected field with no atom on this row drops the row.
        if (fields.some((name) => !(name in rec.fields))) continue;
        const projected: Record<string, unknown> = {};
        for (const name of fields) projected[name] = rec.fields[name];
        results.push({ fields: projected, key: { hash: rec.keyHash, range: rec.rangeKey } });
      }
      return { ok: true, results, returned_count: results.length, total_count: results.length };
    },
    rawCall: notImpl("rawCall") as NodeClient["rawCall"],
    nodeTransport: () => ({ transport: "unavailable" as const }),
  };
}

function cardRecord(partial: Partial<Card> = {}): Record<string, unknown> {
  return {
    slug: "proof",
    title: "Prove it end to end",
    body: "## GOAL\nProve it.\n\n## END STATE\nIt is proven.\n",
    board: "default",
    column: "todo",
    position: "10",
    assignee: "",
    tags: [],
    deps: [],
    created_at: "2026-01-01T00:00:00.000Z",
    created_by: "test",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...emptyStructuredFields(),
    kind: "validation",
    repo: "EdgeVector/fkanban",
    milestone: "m1",
    ...partial,
  } as Record<string, unknown>;
}

/** The same card with one field's atom absent — the shape that reads as gone. */
function sparse(rec: Record<string, unknown>, field: string): Record<string, unknown> {
  const copy = { ...rec };
  delete copy[field];
  return copy;
}

/**
 * Every MILESTONE_FIELDS field must be present, or the projection rule modeled
 * above drops this fixture's own row and the milestone reads as missing. (Which
 * is a fair demonstration of the rule under test.)
 */
const milestoneRecord = (partial: Record<string, unknown> = {}) => ({
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
});

describe("a sparse proof card is not a missing proof card", () => {
  test("precondition: the wide read misses it while the key-only read finds it", async () => {
    const node = projectionFaithfulNode({ cards: [sparse(cardRecord(), "north_star")] });
    // This asymmetry IS the bug's mechanism. If it ever stops holding, the rest
    // of this file is testing nothing.
    expect(await findCard(node, cfg, "proof")).toBeNull();
    expect(await cardExists(node, cfg, "proof")).toBe(true);
  });

  test("linking a sparse proof card is ALLOWED (existence asked key-only)", async () => {
    const node = projectionFaithfulNode({
      cards: [sparse(cardRecord(), "north_star")],
      milestones: [milestoneRecord()],
    });
    // Pre-fix this threw milestone_proof_card_not_found and the milestone could
    // never be linked to a card that was sitting right there.
    const res = await milestoneAddCmd({
      cfg,
      node,
      slug: "m1",
      title: "Milestone one",
      board: "default",
      proofCard: "proof",
      northStar: "ns-1",
    } as never);
    expect(res.slug).toBe("m1");
  });

  test("a genuinely absent proof card is still refused", async () => {
    const node = projectionFaithfulNode({ cards: [], milestones: [milestoneRecord()] });
    await expect(
      milestoneAddCmd({
        cfg,
        node,
        slug: "m1",
        title: "Milestone one",
        board: "default",
        proofCard: "nope",
        northStar: "ns-1",
      } as never),
    ).rejects.toThrow(/not found/i);
  });

  test("a transition blocked by a sparse proof card says SPARSE, not 'not found'", async () => {
    const node = projectionFaithfulNode({
      cards: [sparse(cardRecord(), "north_star")],
      milestones: [milestoneRecord({ proof_card: "proof" })],
    });
    // The gate still refuses — it genuinely cannot read board/milestone/kind —
    // but the error must name the real problem. Pre-fix it said "not found",
    // sending the operator to recreate a card that already exists.
    let code = "";
    try {
      await milestoneStateCmd({ cfg, node, slug: "m1", state: "proving" });
    } catch (err) {
      code = (err as { code?: string }).code ?? String(err);
    }
    expect(code).toBe("milestone_proof_card_unreadable");
  });

  test("reconcile warns 'unreadable', not 'missing', for a sparse proof card", async () => {
    const node = projectionFaithfulNode({
      cards: [sparse(cardRecord(), "north_star")],
      milestones: [milestoneRecord({ proof_card: "proof" })],
    });
    const res = await milestoneReconcileResult({ cfg, node, slug: "m1" });
    const codes = res.warnings.map((w) => w.code);
    expect(codes).toContain("unreadable-proof-card");
    expect(codes).not.toContain("missing-proof-card");
  });

  test("reconcile still warns 'missing' when the proof card is genuinely absent", async () => {
    const node = projectionFaithfulNode({
      cards: [],
      milestones: [milestoneRecord({ proof_card: "gone" })],
    });
    const res = await milestoneReconcileResult({ cfg, node, slug: "m1" });
    const codes = res.warnings.map((w) => w.code);
    expect(codes).toContain("missing-proof-card");
    expect(codes).not.toContain("unreadable-proof-card");
  });
});
