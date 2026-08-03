// The completion checkpoint is a DURABLE, one-way write into Brain. Nothing in
// this codebase ever retracts one. So the ordering question is not stylistic:
//
//   checkpoint BEFORE the card write -> a refused write leaves Brain claiming a
//                                       completion that never happened, forever.
//   checkpoint AFTER  the card write -> a refused write writes nothing, and a
//                                       write that lands but whose checkpoint
//                                       fails is caught by the `delete-backstop`
//                                       in `rm` / `board rm` before the card can
//                                       ever leave the board.
//
// Only one of those two failures is permanent, so these tests pin the order on
// the `done-transition` paths. A CAS conflict is the demonstration because it is
// not an outage: `move --expect` exists FOR concurrent agents, and `move.ts`
// catches `cas_conflict` and re-reports it as `ClaimConflictError` — a routine,
// expected outcome on a board several routines write to.
//
// The `delete-backstop` sites (`rm`, `board rm`) keep the opposite order on
// purpose: there, the checkpoint MUST precede the delete, because after it the
// card is gone.

import { afterEach, describe, expect, test } from "bun:test";

import {
  FkanbanError,
  type CasExpectation,
  type NodeClient,
  type QueryFilter,
  type QueryResponse,
  type QueryRow,
} from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { setBrainCheckpointClientForTest } from "../src/brain_checkpoint.ts";
import { ClaimConflictError, moveCmd } from "../src/commands/move.ts";
import { addCmd } from "../src/commands/add.ts";
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

const OWNER_SLUG = "ns-checkpoint-ordering";

function casError(actual: unknown): FkanbanError {
  return new FkanbanError({
    code: "cas_conflict",
    message: "CAS precondition failed.",
    cause: { error: "cas_conflict", field: "column", expected: "todo", actual },
  });
}

/**
 * Records every append instead of performing one. `get` answers for the owner
 * record so the checkpoint takes the normal (non-orphan) path — the orphan
 * ledger path would `put` first and muddy what the assertion is measuring.
 */
function recordingBrainClient() {
  const appends: Array<{ slug: string; chunk: string }> = [];
  const bodies = new Map<string, string>([[OWNER_SLUG, "# owner\n"]]);
  return {
    appends,
    client: {
      async get(slug: string) {
        const body = bodies.get(slug);
        return body === undefined ? null : { slug, type: "project", body };
      },
      async put(record: { slug: string; body: string }) {
        bodies.set(record.slug, record.body);
      },
      async append(slug: string, chunk: string) {
        appends.push({ slug, chunk });
        bodies.set(slug, (bodies.get(slug) ?? "") + chunk);
      },
    },
  };
}

function fakeNode(): NodeClient {
  type StoredRecord = { keyHash: string; rangeKey: string | null; fields: Record<string, unknown> };
  const store = new Map<string, Map<string, StoredRecord>>();
  const storeKey = (keyHash: string, rangeKey?: string | null) => `${keyHash}\0${rangeKey ?? ""}`;
  const tableFor = (schemaHash: string) => {
    let t = store.get(schemaHash);
    if (!t) {
      t = new Map();
      store.set(schemaHash, t);
    }
    return t;
  };
  const rowsFor = (schemaHash: string, filter?: QueryFilter): QueryRow[] => {
    const t = tableFor(schemaHash);
    const entries = filter?.HashKey
      ? [...t.values()].filter((rec) => rec.keyHash === filter.HashKey)
      : [...t.values()].filter((rec) =>
          !filter || Object.entries(filter).every(([field, value]) => rec.fields[field] === value)
        );
    return entries.map(({ keyHash, rangeKey, fields }) => ({ fields, key: { hash: keyHash, range: rangeKey } }));
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
    async createRecord({ schemaHash, fields, keyHash, rangeKey, expected }) {
      const table = tableFor(schemaHash);
      const key = storeKey(keyHash, rangeKey);
      checkExpected(table.get(key)?.fields ?? {}, expected);
      table.set(key, { keyHash, rangeKey: rangeKey ?? null, fields });
    },
    async updateRecord({ schemaHash, fields, keyHash, rangeKey, expected }) {
      const table = tableFor(schemaHash);
      const key = storeKey(keyHash, rangeKey);
      checkExpected(table.get(key)?.fields ?? {}, expected);
      table.set(key, { keyHash, rangeKey: rangeKey ?? null, fields: { ...table.get(key)?.fields, ...fields } });
    },
    async deleteRecord({ schemaHash, keyHash, rangeKey }) {
      tableFor(schemaHash).delete(storeKey(keyHash, rangeKey));
    },
    async queryAll({ schemaHash, filter }): Promise<QueryResponse> {
      const results = rowsFor(schemaHash, filter);
      return { ok: true, results, returned_count: results.length, total_count: results.length };
    },
    rawCall: notImpl("rawCall") as NodeClient["rawCall"],
    nodeTransport: () => ({ transport: "unavailable" as const }),
  };
}

function card(partial: Partial<Card>): Card {
  const now = nowIso();
  return {
    slug: "checkpoint-me",
    title: "Checkpoint me",
    body: "Repo: EdgeVector/fkanban\nBase: main\n\n## GOAL\nfixture\n\n## END STATE\ndone\n",
    board: "default",
    column: "doing",
    position: "1",
    assignee: "",
    tags: [],
    deps: [],
    ...emptyStructuredFields(),
    north_star: OWNER_SLUG,
    created_at: now,
    updated_at: now,
    ...partial,
  };
}

function board(partial: Partial<Board> = {}): Board {
  const now = nowIso();
  return {
    slug: "default",
    title: "Default board",
    body: "",
    columns: [...DEFAULT_COLUMNS],
    created_at: now,
    updated_at: now,
    ...partial,
  };
}

async function seed(node: NodeClient, c: Card = card({})) {
  await node.createRecord({
    schemaHash: cfg.schemaHashes.board!,
    keyHash: "default",
    fields: boardToFields(board()),
  });
  await node.createRecord({
    schemaHash: cfg.schemaHashes.card!,
    keyHash: c.slug,
    fields: cardToFields(c),
  });
}

let restoreBrain: (() => void) | null = null;
afterEach(() => {
  restoreBrain?.();
  restoreBrain = null;
});

/**
 * A node that accepts every read and every index write, and refuses the one
 * write that matters: the Card record.
 *
 * `refusal: "timeout"` is the common case — `service_timeout` / "node did not
 * respond within Nms" is documented backpressure on this machine, not an
 * outage, and every mutation can meet it.
 *
 * `refusal: "cas"` is the narrow one, and it is why the CAS expectation is sent
 * to the node at all: `moveCmd` pre-checks `expectColumn` against the card it
 * just read, so a claim that was already lost fails EARLY, before the
 * checkpoint. The expectation on the write covers the remaining window — the
 * card changing between that read and this write — and a conflict there lands
 * after the checkpoint has run.
 */
function nodeRefusingCardWrite(node: NodeClient, refusal: "timeout" | "cas"): NodeClient {
  const refuse = () => {
    throw refusal === "cas"
      ? casError("todo")
      : new FkanbanError({ code: "service_timeout", message: "node did not respond within 30000ms" });
  };
  return {
    ...node,
    async createRecord(args) {
      if (args.schemaHash === cfg.schemaHashes.card) refuse();
      return node.createRecord(args);
    },
    async updateRecord(args) {
      if (args.schemaHash === cfg.schemaHashes.card) refuse();
      return node.updateRecord(args);
    },
  };
}

describe("completion checkpoint ordering vs the card write", () => {
  test("a move whose card write times out writes no completion checkpoint", async () => {
    const node = fakeNode();
    await seed(node);
    const brain = recordingBrainClient();
    restoreBrain = setBrainCheckpointClientForTest(brain.client);

    await expect(
      moveCmd({ cfg, node: nodeRefusingCardWrite(node, "timeout"), slug: "checkpoint-me", column: "done" }),
    ).rejects.toThrow();

    const after = await findCard(node, cfg, "checkpoint-me");
    expect(after?.column).toBe("doing");

    // The board says the card was never completed. Brain must agree.
    expect(brain.appends).toEqual([]);
  });

  test("a move that loses the CAS race at the write writes no completion checkpoint", async () => {
    const node = fakeNode();
    await seed(node);
    const brain = recordingBrainClient();
    restoreBrain = setBrainCheckpointClientForTest(brain.client);

    // Passes the early `expectColumn` guard (the card still reads `doing`) and
    // loses the race at the write, which is the case the CAS expectation exists
    // to catch.
    await expect(
      moveCmd({
        cfg,
        node: nodeRefusingCardWrite(node, "cas"),
        slug: "checkpoint-me",
        column: "done",
        expectColumn: "doing",
      }),
    ).rejects.toBeInstanceOf(ClaimConflictError);

    const after = await findCard(node, cfg, "checkpoint-me");
    expect(after?.column).toBe("doing");
    expect(brain.appends).toEqual([]);
  });

  test("a move that lands does write the completion checkpoint", async () => {
    const node = fakeNode();
    await seed(node);
    const brain = recordingBrainClient();
    restoreBrain = setBrainCheckpointClientForTest(brain.client);

    await moveCmd({ cfg, node, slug: "checkpoint-me", column: "done", expectColumn: "doing" });

    const after = await findCard(node, cfg, "checkpoint-me");
    expect(after?.column).toBe("done");
    expect(brain.appends.map((a) => a.slug)).toEqual([OWNER_SLUG]);
    expect(brain.appends[0]!.chunk).toContain("checkpoint-me");
  });

  test("a refused add writes no completion checkpoint", async () => {
    const node = fakeNode();
    await seed(node);
    const brain = recordingBrainClient();
    restoreBrain = setBrainCheckpointClientForTest(brain.client);

    // `add` reaches the same `done-transition` checkpoint. Refuse its write at
    // the node so the assertion is about ordering, not about which guard fired.
    await expect(
      addCmd({ cfg, node: nodeRefusingCardWrite(node, "timeout"), slug: "checkpoint-me", column: "done" }),
    ).rejects.toThrow();

    const after = await findCard(node, cfg, "checkpoint-me");
    expect(after?.column).toBe("doing");
    expect(brain.appends).toEqual([]);
  });
});
