/**
 * A milestone's `proof_status` is a gate's conclusion, stored — and never
 * re-checked against the evidence it was drawn from.
 *
 * `proofGate` runs at the transition into `proving`/`complete` and then never
 * again. Everything it inspected stays mutable: the proof card can be deleted,
 * unlinked, moved back out of `done`, or have its `PROOF: PASS` line edited
 * away. Measured on the live board 2026-08-04, 19 of the 22 milestones naming a
 * proof card named one that no longer existed, and 14 of those still read
 * `state=complete` + `proof_status=passing`.
 *
 * `portfolio`/`detail`/`groom` recomputed the truth into a prose `warnings[]`
 * array while `proof_status` kept saying `passing` beside it; `show` recomputed
 * nothing at all. `milestone-driver.md` gates completion on `state=complete` and
 * `proof_status=passing` and reads neither.
 *
 * `milestoneProofVerdict` re-runs the gate's evidence test on every read. These
 * tests exist to keep it HONEST in two directions at once:
 *
 *   1. it must not miss a failure the gate would have caught, and
 *   2. it must not invent one the gate would have allowed.
 *
 * The only way to assert that without re-implementing the gate is to RUN the
 * gate. So the correspondence block drives the real `milestoneStateCmd`
 * (→ `validateTransition` → `proofGate`) against a fake node for every
 * dimension, and asserts the verdict agrees with what the gate actually did —
 * not with a second copy of the gate's rules written out here, which would be
 * the same two-functions-that-cannot-drift trap this codebase has hit before.
 */
import { describe, expect, test } from "bun:test";

import type { NodeClient, QueryFilter, QueryResponse, QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { milestonePortfolioResult, milestoneShowResult, milestoneStateCmd } from "../src/commands/milestone.ts";
import { milestoneProofVerdict } from "../src/milestone_proof.ts";
import { emptyStructuredFields, type Card, type Milestone } from "../src/record.ts";

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
 * A node that drops a row when ANY projected field has no atom on it, which is
 * how LastDB actually answers. Modeling that is not incidental here: the
 * `unreadable-proof-card` verdict exists only because a live card can vanish
 * from a wide read, and a fake that ignores `fields` cannot produce that case at
 * all — it would let a test claim coverage of a branch it never entered.
 */
function fakeNode(seed: { cards?: Array<Record<string, unknown>>; milestones?: Array<Record<string, unknown>> }): NodeClient {
  const store = new Map<string, Map<string, StoredRecord>>();
  const storeKey = (keyHash: string, rangeKey?: string | null) => `${keyHash}\0${rangeKey ?? ""}`;
  const tableFor = (schemaHash: string) => {
    let t = store.get(schemaHash);
    if (!t) store.set(schemaHash, (t = new Map()));
    return t;
  };
  for (const c of seed.cards ?? []) tableFor(CARD_HASH).set(storeKey(String(c.slug)), { keyHash: String(c.slug), rangeKey: null, fields: { ...c } });
  for (const m of seed.milestones ?? []) tableFor(MILESTONE_HASH).set(storeKey(String(m.slug)), { keyHash: String(m.slug), rangeKey: null, fields: { ...m } });
  tableFor(BOARD_HASH).set(storeKey("default"), {
    keyHash: "default",
    rangeKey: null,
    fields: { slug: "default", title: "Default", body: "", columns: ["backlog", "todo", "doing", "done"], created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" },
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

const PASSING_BODY = "## GOAL\nProve it.\n\n## END STATE\nProven.\n\nPROOF: PASS\n";

const cardRecord = (partial: Record<string, unknown> = {}): Record<string, unknown> => ({
  slug: "proof",
  title: "Prove it end to end",
  body: PASSING_BODY,
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
  repo: "EdgeVector/fkanban",
  milestone: "m1",
  ...partial,
});

const milestoneRecord = (partial: Record<string, unknown> = {}): Record<string, unknown> => ({
  slug: "m1",
  title: "Milestone one",
  body: "",
  board: "default",
  state: "active",
  position: "10",
  north_star: "ns-1",
  driver: "last-stack-milestone-driver",
  deps: [],
  proof_card: "proof",
  proof_status: "passing",
  block_reason: "",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  completed_at: "",
  ...partial,
});

/** The verdict's own view of a milestone, built from the same fixture fields. */
const milestoneFor = (partial: Record<string, unknown> = {}) => milestoneRecord(partial) as unknown as Milestone;
const cardFor = (partial: Record<string, unknown> = {}) => cardRecord(partial) as unknown as Card;

/**
 * Did the real `proofGate` let this milestone reach `complete`?
 *
 * Seeded at `proving` because the lifecycle map has no `active → complete` edge,
 * and a transition refused for the WRONG reason would make every row below pass
 * while proving nothing about the proof gate. (It did, on first run.)
 *
 * The seed is written straight into the store rather than transitioned into
 * place, which is the real-world sequence and the only one that can be set up at
 * all: these fixtures describe a milestone that reached `proving` while its
 * evidence was intact and then lost it.
 */
async function gateAdmitsComplete(seed: { cards?: Array<Record<string, unknown>>; milestone?: Record<string, unknown> }): Promise<boolean> {
  const node = fakeNode({ cards: seed.cards, milestones: [milestoneRecord({ state: "proving", ...seed.milestone })] });
  try {
    await milestoneStateCmd({ cfg, node, slug: "m1", state: "complete" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Each row is one way the evidence behind a `passing` claim can stop holding.
 * `gate` is not an expectation written from the gate's source — it is asserted
 * against the gate at runtime below, so a row that misdescribes the gate fails
 * this file rather than quietly encoding a wrong belief.
 */
const DIMENSIONS = [
  { name: "the proof card was deleted", card: null as Record<string, unknown> | null, reason: "missing-proof-card" },
  { name: "the proof card was unlinked from the milestone", card: { milestone: "other-milestone" }, reason: "proof-card-mismatch" },
  { name: "the proof card moved back out of its terminal column", card: { column: "doing" }, reason: "proof-not-terminal" },
  { name: "the PASS line was edited away", card: { body: "## GOAL\nProve it.\n" }, reason: "no-pass-evidence" },
] as const;

describe("the read verdict agrees with the write gate, dimension by dimension", () => {
  test("healthy evidence: the gate admits `complete` AND the verdict is passing", async () => {
    expect(await gateAdmitsComplete({ cards: [cardRecord()] })).toBe(true);
    expect(milestoneProofVerdict(milestoneFor(), cardFor())).toEqual({ verdict: "passing", reason: "evidence-present" });
  });

  for (const dim of DIMENSIONS) {
    test(`${dim.name}: the gate refuses AND the verdict degrades (${dim.reason})`, async () => {
      // The gate's answer is MEASURED, not assumed. If a future change makes the
      // gate tolerant of this dimension, this line fails and the pair is
      // re-examined together instead of drifting apart in silence.
      expect(await gateAdmitsComplete({ cards: dim.card === null ? [] : [cardRecord(dim.card)] })).toBe(false);
      expect(milestoneProofVerdict(milestoneFor(), dim.card === null ? null : cardFor(dim.card)))
        .toEqual({ verdict: "unproven", reason: dim.reason });
    });
  }

  test("a live-but-sparse proof card is `unreadable`, not `missing`", () => {
    // Same degraded verdict, different remedy: this one sends the operator to
    // `board-cards-heal`, and reporting it as missing sends them to recreate a
    // card that is sitting right there.
    expect(milestoneProofVerdict(milestoneFor(), null, true)).toEqual({ verdict: "unproven", reason: "unreadable-proof-card" });
  });

  test("kind=validation is checked by the gate and DELIBERATELY not by the verdict", async () => {
    // Stated as an assertion so widening the verdict has to argue with a test.
    // `PROOF_CARD_FIELDS` does not project `kind`, and adding it would make a
    // card merely missing that field read as ABSENT — a read-time check that
    // invents failures is worse than one with a documented blind spot. `kind` is
    // also a pickup-routing property, not evidence that the proof passed.
    expect(await gateAdmitsComplete({ cards: [cardRecord({ kind: "pr" })] })).toBe(false);
    expect(milestoneProofVerdict(milestoneFor(), cardFor({ kind: "pr" })).verdict).toBe("passing");
  });
});

describe("`unproven` means exactly one thing", () => {
  test("pending, failing and not_required pass through untouched", () => {
    // A proof that has not run yet is not a defect, and reporting it as
    // `unproven` would make the field useless for the case it exists to flag.
    // `not_required` never rested on a card, so a dangling ref cannot degrade it.
    expect(milestoneProofVerdict(milestoneFor({ proof_status: "pending" }), null)).toEqual({ verdict: "pending", reason: "not-claimed" });
    expect(milestoneProofVerdict(milestoneFor({ proof_status: "failing" }), null)).toEqual({ verdict: "failing", reason: "not-claimed" });
    expect(milestoneProofVerdict(milestoneFor({ proof_status: "not_required", proof_card: "gone" }), null))
      .toEqual({ verdict: "not_required", reason: "not-required" });
  });

  test("passing with no proof card named at all is unproven", () => {
    expect(milestoneProofVerdict(milestoneFor({ proof_card: "" }), null)).toEqual({ verdict: "unproven", reason: "no-proof-card" });
  });
});

describe("every read path reports the verdict, not just the stored claim", () => {
  /** The live board's shape: completed, proof recorded passing, card deleted. */
  const completedThenDeleted = {
    cards: [],
    milestones: [milestoneRecord({ state: "complete", completed_at: "2026-02-01T00:00:00.000Z" })],
  };

  test("`milestone show` degrades the claim and names the reason", async () => {
    // RED before the change: `show` did not read the proof card at all, so it
    // returned `proof_status: passing` with nothing to contradict it — and it is
    // both the cheapest milestone read and the one behind fkanban_milestone_show.
    const result = await milestoneShowResult({ cfg, node: fakeNode(completedThenDeleted), slug: "m1" });
    expect(result.proof_verdict).toBe("unproven");
    expect(result.proof_verdict_reason).toBe("missing-proof-card");
    // The stored claim SURVIVES beside the verdict. Healing it away would erase
    // the only record that a passing proof was ever asserted.
    expect(result.milestone.proof_status).toBe("passing");
    expect(result.text).toContain("proof: passing · proof");
    expect(result.text).toContain("proof verdict: unproven (missing-proof-card)");
  });

  test("`milestone show` costs no proof read when nothing is claimed", async () => {
    // The verdict must not turn the cheap read into an expensive one for the
    // common case. `pending` and `not_required` answer without the card.
    let queries = 0;
    const node = fakeNode({ milestones: [milestoneRecord({ proof_status: "pending" })] });
    const counting: NodeClient = { ...node, async queryAll(req) { queries += 1; return node.queryAll(req); } };
    const result = await milestoneShowResult({ cfg, node: counting, slug: "m1" });
    expect(result.proof_verdict).toBe("pending");
    // One read: the milestone itself. A second would mean the proof card was
    // fetched for a milestone that claims nothing.
    expect(queries).toBe(1);
  });

  test("the portfolio PROOF column shows the verdict, and --json keeps both", async () => {
    const result = await milestonePortfolioResult({ cfg, node: fakeNode(completedThenDeleted) });
    expect(result.entries[0]!.proof_status).toBe("passing");
    expect(result.entries[0]!.proof_verdict).toBe("unproven");
    expect(result.entries[0]!.proof_verdict_reason).toBe("missing-proof-card");
    // The human-facing table must not be the last place still printing the
    // stale claim — it was the largest single source of it on the live board.
    expect(result.text).toContain("unproven");
    expect(result.text).not.toContain("passing");
  });
});
