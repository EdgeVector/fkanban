/**
 * A write must not be refused over a link it never supplied.
 *
 * `milestoneAddCmd` is the only writer of milestone records (`milestone state`
 * routes through it). It rebuilds the whole record on every write, inheriting
 * each field the caller omitted, and then validated that whole record. So once
 * a milestone's proof card was deleted, EVERY write to that milestone was
 * refused — `milestone state <slug> blocked`, a `--block-reason` note, a title
 * fix — by an error naming a card the caller never mentioned. `complete →
 * active` is the only exit from `complete`, and it was refused too, so the
 * record was frozen exactly when it most needed annotating as broken.
 *
 * Measured on the live primary 2026-08-03 with
 * `scripts/probe-milestone-frozen-by-inherited-link.ts` (arm B, which targets
 * `active` so `proofGate` cannot fire and the refusal is attributable to
 * `validateLinks` alone): **20 of 41 milestones could not be moved to active.**
 *
 * The fix validates only links the write SUPPLIES. What makes that safe is that
 * the meaningful rule — you cannot CLAIM proof without proof — lives in
 * `proofGate`, which is stricter and untouched. The last two tests here pin
 * exactly that, because they are what fails if a later run "simplifies" this
 * into dropping the proof-card check altogether.
 */
import { describe, expect, test } from "bun:test";

import type { NodeClient, QueryResponse, QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { FkanbanError } from "../src/client.ts";
import { milestoneAddCmd, milestoneStateCmd } from "../src/commands/milestone.ts";
import { emptyStructuredFields } from "../src/record.ts";

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

function fakeNode(seed: {
  cards?: Array<Record<string, unknown>>;
  milestones?: Array<Record<string, unknown>>;
}): NodeClient {
  const store = new Map<string, Map<string, StoredRecord>>();
  const key = (h: string, r?: string | null) => `${h}\0${r ?? ""}`;
  const tableFor = (schemaHash: string) => {
    let t = store.get(schemaHash);
    if (!t) store.set(schemaHash, (t = new Map()));
    return t;
  };
  for (const c of seed.cards ?? []) {
    tableFor(CARD_HASH).set(key(String(c.slug)), { keyHash: String(c.slug), rangeKey: null, fields: { ...c } });
  }
  for (const m of seed.milestones ?? []) {
    tableFor(MILESTONE_HASH).set(key(String(m.slug)), { keyHash: String(m.slug), rangeKey: null, fields: { ...m } });
  }
  tableFor(BOARD_HASH).set(key("default"), {
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
      tableFor(schemaHash).set(key(keyHash, rangeKey), { keyHash, rangeKey: rangeKey ?? null, fields: { ...fields } });
    },
    async updateRecord({ schemaHash, fields, keyHash, rangeKey }) {
      const prev = tableFor(schemaHash).get(key(keyHash, rangeKey))?.fields;
      tableFor(schemaHash).set(key(keyHash, rangeKey), {
        keyHash,
        rangeKey: rangeKey ?? null,
        fields: { ...prev, ...fields },
      });
    },
    async deleteRecord({ schemaHash, keyHash, rangeKey }) {
      tableFor(schemaHash).delete(key(keyHash, rangeKey));
    },
    async queryAll({ schemaHash, fields, filter }): Promise<QueryResponse> {
      const results: QueryRow[] = [];
      for (const rec of tableFor(schemaHash).values()) {
        const f = filter as Record<string, unknown> | undefined;
        if (f && typeof f.HashKey === "string" && rec.keyHash !== f.HashKey) continue;
        // LastDB drops a row when a projected field has no atom on it.
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

const cardRecord = (partial: Record<string, unknown> = {}) =>
  ({
    slug: "proof",
    title: "Prove it",
    body: "PROOF: PASS\n",
    board: "default",
    column: "done",
    position: "10",
    assignee: "",
    tags: [],
    deps: [],
    created_at: "2026-01-01T00:00:00.000Z",
    created_by: "test",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...emptyStructuredFields(),
    kind: "validation",
    milestone: "m1",
    ...partial,
  }) as Record<string, unknown>;

describe("an inherited link does not freeze the record", () => {
  test("a milestone whose proof card is GONE can still be moved to active", async () => {
    // The milestone names a proof card; no such card is in the store. This is
    // the live shape: 20 of 41 milestones on the primary, 2026-08-03.
    const node = fakeNode({
      milestones: [milestoneRecord({ state: "complete", proof_card: "deleted-proof", proof_status: "passing" })],
    });
    // `active` is the ONLY transition out of `complete`, so this is the sole
    // repair path. Pre-fix it threw milestone_proof_card_not_found.
    const res = await milestoneStateCmd({ cfg, node, slug: "m1", state: "active" });
    expect(res.to).toBe("active");
  });

  test("…and can be annotated as blocked, which is the point of being able to write", async () => {
    const node = fakeNode({
      milestones: [milestoneRecord({ state: "active", proof_card: "deleted-proof" })],
    });
    await milestoneAddCmd({ cfg, node, slug: "m1", state: "blocked", blockReason: "proof card was deleted" });
    const after = await milestoneAddCmd({ cfg, node, slug: "m1", state: "blocked" });
    expect(after.state).toBe("blocked");
  });

  test("an inherited dangling DEP does not block an unrelated write either", async () => {
    const node = fakeNode({
      milestones: [milestoneRecord({ deps: ["no-such-milestone"] })],
    });
    const res = await milestoneAddCmd({ cfg, node, slug: "m1", title: "renamed" });
    expect(res.action).toBe("updated");
  });

  // ---- the check is scoped, NOT removed -----------------------------------

  test("NAMING a proof card that does not exist is still refused", async () => {
    const node = fakeNode({ milestones: [milestoneRecord()] });
    const err = await milestoneAddCmd({ cfg, node, slug: "m1", proofCard: "not-a-card" }).catch((e) => e);
    expect(err).toBeInstanceOf(FkanbanError);
    expect((err as FkanbanError).code).toBe("milestone_proof_card_not_found");
  });

  test("SUPPLYING a dangling dep is still refused", async () => {
    const node = fakeNode({ milestones: [milestoneRecord()] });
    const err = await milestoneAddCmd({ cfg, node, slug: "m1", deps: ["no-such-milestone"] }).catch((e) => e);
    expect(err).toBeInstanceOf(FkanbanError);
    expect((err as FkanbanError).code).toBe("milestone_dependency_not_found");
  });

  /**
   * THE DESIGN LOCK.
   *
   * Scoping `validateLinks` is only safe because `proofGate` still refuses to
   * CLAIM proof without proof. A future run that reads the fix as "the proof
   * card check was unnecessary" and deletes it outright would pass every test
   * above and fail these two — which is the whole reason they are here.
   */
  test("entering `proving` with a dangling proof card is STILL refused", async () => {
    const node = fakeNode({
      milestones: [milestoneRecord({ state: "active", proof_card: "deleted-proof" })],
    });
    const err = await milestoneStateCmd({ cfg, node, slug: "m1", state: "proving" }).catch((e) => e);
    expect(err).toBeInstanceOf(FkanbanError);
    expect((err as FkanbanError).code).toBe("milestone_proof_card_not_found");
  });

  test("entering `complete` with a dangling proof card is STILL refused", async () => {
    const node = fakeNode({
      milestones: [milestoneRecord({ state: "proving", proof_card: "deleted-proof", proof_status: "passing" })],
      cards: [],
    });
    const err = await milestoneStateCmd({ cfg, node, slug: "m1", state: "complete" }).catch((e) => e);
    expect(err).toBeInstanceOf(FkanbanError);
    expect((err as FkanbanError).code).toBe("milestone_proof_card_not_found");
  });

  test("a real, passing proof card still completes — the gate is not merely refusing everything", async () => {
    const node = fakeNode({
      milestones: [milestoneRecord({ state: "proving", proof_card: "proof", proof_status: "passing" })],
      cards: [cardRecord()],
    });
    const res = await milestoneStateCmd({ cfg, node, slug: "m1", state: "complete", proofStatus: "passing" });
    expect(res.to).toBe("complete");
  });
});
