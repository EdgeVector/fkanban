/**
 * `pickup claim` must not return before `show` agrees with it.
 *
 * `kanban show` is a keyed Card point read and nothing else, so it is a
 * DIFFERENT read of the same durable write the claim made — and on the primary
 * it lagged that write by seconds to minutes across eight witnessed runs
 * (2026-08-18 → 2026-08-20, `papercut-fkanban-show-lags-pickup-claim-projection`):
 * `claimed=true, from=todo, to=doing` followed immediately by `show` reporting
 * `column=todo` with a blank assignee, while `list --column doing` reported the
 * claim correctly.
 *
 * Two distinct failures came out of that window and both are pinned here:
 *
 * 1. The worker cannot trust its own claim — `show` contradicts the claim
 *    response, so it retries or misclassifies.
 * 2. Worse, and the reason this is a WRITE bug and not only a read one: the
 *    claim's own assignee re-stamp used to run on the stale read, and
 *    `updateCardRecord` rebuilds the wide BoardCards row from that object,
 *    which is a full-record write to the primary by proxy. So the re-stamp put
 *    `column: todo` BACK over the claim — the durable revert-to-todo that hit
 *    runs mid-build.
 *
 * The fake node here is faithful in the one way that matters: it serves a
 * configurable number of STALE keyed Card reads after the claim write, exactly
 * as the primary did, while the stored record is already current.
 */

import { describe, expect, test } from "bun:test";

import {
  FkanbanError,
  type CasExpectation,
  type NodeClient,
  type QueryFilter,
  type QueryResponse,
  type QueryRow,
} from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { pickupClaimResult } from "../src/commands/pickup_claim.ts";
import { showResult } from "../src/commands/show.ts";
import {
  awaitCardClaimVisible,
  cardReflectsClaim,
  claimVisibilityTimeoutWarning,
  CLAIM_VISIBLE_BUDGET_MS,
} from "../src/doing-claim.ts";
import {
  boardToFields,
  cardToFields,
  emptyStructuredFields,
  findCard,
  nowIso,
  type Board,
  type Card,
} from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash" },
};

function casError(actual: unknown): FkanbanError {
  return new FkanbanError({
    code: "cas_conflict",
    message: "CAS precondition failed.",
    cause: { error: "cas_conflict", field: "column", expected: "todo", actual },
  });
}

type LaggingNode = NodeClient & {
  /**
   * Arm the lag: the next Card write that moves a row INTO `doing` — i.e. the
   * claim write itself — starts serving `reads` keyed Card reads from the
   * snapshot taken immediately before it.
   *
   * Armed rather than applied directly because the window under test opens at
   * the claim write, which is several reads into `pickup claim` (board, todo
   * list, overlap peers). Counting those by hand would pin the test to the
   * current read plan instead of to the defect.
   */
  lagAfterClaimWrite: (reads: number) => void;
  /** Serve this many keyed Card reads from the snapshot, starting now. */
  lagKeyedCardReads: (reads: number) => void;
  /** Stop lagging, so an assertion can read the durable record itself. */
  clearLag: () => void;
  /** How many keyed Card point reads the code under test issued. */
  keyedCardReads: () => number;
};

/**
 * A node whose keyed Card point read can be held behind the stored record.
 *
 * The lag is applied ONLY to a `HashKey`-filtered Card query — the shape
 * `findCard` sends, and therefore the shape `show` sends. Writes land in the
 * store immediately, so the record is durable throughout: what the test
 * withholds is visibility, which is precisely what the primary withheld.
 */
function laggingNode(): LaggingNode {
  const store = new Map<string, Map<string, Record<string, unknown>>>();
  // The pre-lag snapshot of each Card row, served while `lag` is positive.
  const shadow = new Map<string, Record<string, unknown>>();
  let lag = 0;
  let armed = 0;
  let keyedReads = 0;

  const tableFor = (schemaHash: string) => {
    let t = store.get(schemaHash);
    if (!t) {
      t = new Map();
      store.set(schemaHash, t);
    }
    return t;
  };
  const snapshotCards = () => {
    shadow.clear();
    for (const [hash, fields] of tableFor(cfg.schemaHashes.card!)) {
      shadow.set(hash, { ...fields });
    }
  };
  const checkExpected = (fields: Record<string, unknown>, expected?: CasExpectation) => {
    if (expected === undefined) return;
    const actual = fields[expected.field];
    if (expected.type === "absent") {
      if (actual !== undefined && actual !== "") throw casError(actual);
    } else if (actual !== expected.value) {
      throw casError(actual);
    }
  };
  const rowsFor = (schemaHash: string, filter?: QueryFilter): QueryRow[] => {
    const t = tableFor(schemaHash);
    const keyed = typeof filter?.HashKey === "string" ? filter.HashKey : null;
    if (keyed !== null) {
      const isCard = schemaHash === cfg.schemaHashes.card;
      if (isCard) keyedReads++;
      // The lag: a keyed Card read is answered from the snapshot taken before
      // the claim write, while the store already holds the claimed row.
      const serveStale = isCard && lag > 0;
      if (serveStale) lag--;
      const fields = serveStale && shadow.has(keyed) ? shadow.get(keyed)! : t.get(keyed);
      return fields ? [{ fields, key: { hash: keyed, range: null } }] : [];
    }
    return [...t.entries()]
      .filter(([, fields]) =>
        !filter || Object.entries(filter).every(([field, value]) => fields[field] === value)
      )
      .map(([hash, fields]) => ({ fields, key: { hash, range: null } }));
  };
  const notImpl = (m: string) => async (): Promise<never> => {
    throw new Error(`laggingNode.${m} not implemented`);
  };

  return {
    baseUrl: cfg.nodeUrl,
    userHash: cfg.userHash,
    autoIdentity: notImpl("autoIdentity"),
    bootstrap: notImpl("bootstrap"),
    loadSchemas: notImpl("loadSchemas"),
    listSchemas: notImpl("listSchemas"),
    async createRecord({ schemaHash, fields, keyHash, expected }) {
      const table = tableFor(schemaHash);
      checkExpected(table.get(keyHash) ?? {}, expected);
      table.set(keyHash, fields);
    },
    async updateRecord({ schemaHash, fields, keyHash, expected }) {
      const table = tableFor(schemaHash);
      checkExpected(table.get(keyHash) ?? {}, expected);
      const claimWrite = armed > 0 &&
        schemaHash === cfg.schemaHashes.card &&
        fields.column === "doing" &&
        table.get(keyHash)?.column !== "doing";
      if (claimWrite) snapshotCards();
      table.set(keyHash, { ...table.get(keyHash), ...fields });
      if (claimWrite) {
        lag = armed;
        armed = 0;
      }
    },
    async deleteRecord({ schemaHash, keyHash }) {
      tableFor(schemaHash).delete(keyHash);
    },
    async queryAll({ schemaHash, filter }): Promise<QueryResponse> {
      const results = rowsFor(schemaHash, filter);
      return { ok: true, results, returned_count: results.length, total_count: results.length };
    },
    rawCall: notImpl("rawCall") as NodeClient["rawCall"],
    nodeTransport: () => ({ transport: "unavailable" as const }),
    lagAfterClaimWrite(reads: number) {
      armed = reads;
    },
    lagKeyedCardReads(reads: number) {
      snapshotCards();
      lag = reads;
    },
    clearLag() {
      armed = 0;
      lag = 0;
    },
    keyedCardReads: () => keyedReads,
  };
}

function board(): Board {
  const now = nowIso();
  return {
    slug: "default",
    title: "Default",
    body: "",
    columns: [...DEFAULT_COLUMNS],
    created_at: now,
    updated_at: now,
  };
}

function card(partial: Partial<Card>): Card {
  const now = nowIso();
  return {
    slug: "card",
    title: "Card",
    body: "Repo: EdgeVector/fkanban\nBase: main\n\n## GOAL\nfixture\n\n## END STATE\ndone\n",
    board: "default",
    column: "todo",
    position: "10",
    assignee: "",
    tags: [],
    deps: [],
    created_at: now,
    updated_at: now,
    ...emptyStructuredFields(),
    kind: "pr",
    block_status: "none",
    repo: "EdgeVector/fkanban",
    base: "main",
    ...partial,
  };
}

async function seed(node: NodeClient) {
  await node.createRecord({
    schemaHash: cfg.schemaHashes.board!,
    keyHash: "default",
    fields: boardToFields(board()),
  });
  await node.createRecord({
    schemaHash: cfg.schemaHashes.card!,
    keyHash: "claim-me",
    fields: cardToFields(card({ slug: "claim-me", title: "Claim me" })),
  });
}

/** Run `fn` with `console.error` captured rather than printed. */
async function captureStderr<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    return { value: await fn(), lines };
  } finally {
    console.error = original;
  }
}

describe("pickup claim / show coherence", () => {
  test("show reflects the claim immediately, with no retry loop or sleep", async () => {
    const node = laggingNode();
    await seed(node);
    // Hold the keyed read one round behind the write, the shape measured on the
    // primary: the claim succeeds, the point read still answers `todo`.
    node.lagAfterClaimWrite(1);
    const claim = await pickupClaimResult({ cfg, node, worker: "worker-a" });

    expect(claim.claimed).toBe(true);
    expect(claim.to).toBe("doing");

    // THE ASSERTION THE CARD ASKS FOR: one keyed show, no polling, no sleep.
    const { card: shown } = await showResult({ cfg, node, slug: "claim-me" });
    expect(shown.column).toBe("doing");
    expect(shown.assignee).toBe("worker-a");
    expect(claim.card?.column).toBe(shown.column);
    expect(claim.card?.assignee).toBe(shown.assignee);
  });

  test("a stale post-claim read is never written back over the claim", async () => {
    const node = laggingNode();
    await seed(node);

    // Lag every keyed read the claim can issue inside its budget, so the wait
    // is guaranteed to exhaust and the old re-stamp path would fire on a
    // snapshot that still says `todo`.
    node.lagAfterClaimWrite(1000);
    const { value: claim, lines } = await captureStderr(() =>
      pickupClaimResult({ cfg, node, worker: "worker-a" })
    );

    expect(claim.claimed).toBe(true);
    // The response reports the claim the CAS settled, not the read that lagged.
    expect(claim.card?.column).toBe("doing");
    expect(claim.card?.assignee).toBe("worker-a");
    // And it SAYS so, rather than letting the divergence pass silently.
    expect(lines).toContain(claimVisibilityTimeoutWarning("claim-me", "doing"));

    // The durable record still holds the claim. Before the fix the re-stamp
    // rebuilt the row from the stale snapshot and put `todo` back here.
    // Read it directly: the point of the test is what was WRITTEN, so the lag
    // that stands in for the read path has to be out of the way to see it.
    node.clearLag();
    const stored = await findCard(node, cfg, "claim-me");
    expect(stored?.column).toBe("doing");
    expect(stored?.assignee).toBe("worker-a");
  });

  test("cardReflectsClaim judges the claim, not equality with the written row", () => {
    // Column and assignee are what the claim asserts.
    expect(cardReflectsClaim({ column: "doing", assignee: "w" }, { column: "doing", assignee: "w" }))
      .toBe(true);
    expect(cardReflectsClaim({ column: "todo", assignee: "w" }, { column: "doing", assignee: "w" }))
      .toBe(false);
    expect(cardReflectsClaim({ column: "doing", assignee: "" }, { column: "doing", assignee: "w" }))
      .toBe(false);
    expect(cardReflectsClaim({ column: "doing", assignee: "other" }, { column: "doing", assignee: "w" }))
      .toBe(false);
    // No worker id available asserts nothing about ownership.
    expect(cardReflectsClaim({ column: "doing", assignee: "" }, { column: "doing", assignee: "" }))
      .toBe(true);
  });

  test("the visibility wait is bounded and reports exhaustion rather than throwing", async () => {
    const node = laggingNode();
    await seed(node);
    node.lagKeyedCardReads(1000);
    const slept: number[] = [];
    const before = node.keyedCardReads();

    const visibility = await awaitCardClaimVisible(
      node,
      cfg,
      "claim-me",
      { column: "doing", assignee: "worker-a" },
      { sleep: async (ms) => { slept.push(ms); } },
    );

    expect(visibility.reflects).toBe(false);
    // It returns the last read it got — evidence, not a substitute for the write.
    expect(visibility.card?.column).toBe("todo");
    expect(node.keyedCardReads()).toBeGreaterThan(before);
    expect(slept.reduce((a, b) => a + b, 0)).toBe(CLAIM_VISIBLE_BUDGET_MS);
  });

  test("a read that throws costs an attempt but does not end the wait", async () => {
    const node = laggingNode();
    await seed(node);
    let calls = 0;
    const flaky: NodeClient = {
      ...node,
      async queryAll(req) {
        calls++;
        // Shed the first keyed Card read the way Mini sheds under load.
        if (calls === 1 && req.schemaHash === cfg.schemaHashes.card) {
          throw new Error("too many concurrent reads");
        }
        return node.queryAll(req);
      },
    };
    // The stored card is already claimed, so the read AFTER the shed succeeds.
    await flaky.updateRecord({
      schemaHash: cfg.schemaHashes.card!,
      keyHash: "claim-me",
      fields: cardToFields(card({ slug: "claim-me", column: "doing", assignee: "worker-a" })),
    });

    const visibility = await awaitCardClaimVisible(
      flaky,
      cfg,
      "claim-me",
      { column: "doing", assignee: "worker-a" },
      { sleep: async () => {} },
    );

    expect(visibility.reflects).toBe(true);
    expect(visibility.card?.column).toBe("doing");
  });
});
