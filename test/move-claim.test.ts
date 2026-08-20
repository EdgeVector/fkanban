import { describe, expect, test } from "bun:test";
import { cardsFromJson } from "./json_page.ts";

import { FkanbanError, type CasExpectation, type NodeClient, type QueryFilter, type QueryResponse, type QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { ClaimConflictError, moveCmd } from "../src/commands/move.ts";
import { listCmd } from "../src/commands/list.ts";
import { boardCardFieldsFromCard, boardCardSk, sweepBoardCardJanitor } from "../src/board-cards.ts";
import { resetBoardCardJanitorForTests } from "../src/board-card-janitor.ts";
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
const cfgWithBoardCards: Config = {
  ...cfg,
  schemaHashes: { ...cfg.schemaHashes, board_cards: "boardcardshash" },
};

function casError(actual: unknown): FkanbanError {
  return new FkanbanError({
    code: "cas_conflict",
    message: "CAS precondition failed.",
    cause: { error: "cas_conflict", field: "column", expected: "todo", actual },
  });
}

// `prefixBlind` models a node that ACCEPTS a HashRangePrefix query but answers
// no rows (the OPE/encrypted-range-key failure mode). Column list is
// HashRangePrefix-only, so a prefix-blind node must render an empty column
// rather than silently degrading to a HashKey partition scan.
function fakeNode(opts: { prefixBlind?: boolean } = {}): NodeClient {
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
    const rangePrefix = (filter as unknown as { HashRangePrefix?: { hash?: string; prefix?: string } } | undefined)
      ?.HashRangePrefix;
    let entries: StoredRecord[];
    if (rangePrefix?.hash && rangePrefix.prefix !== undefined) {
      entries = opts.prefixBlind
        ? []
        : [...t.values()].filter(
            (rec) =>
              rec.keyHash === rangePrefix.hash &&
              typeof rec.rangeKey === "string" &&
              rec.rangeKey.startsWith(rangePrefix.prefix!),
          );
    } else if (filter?.HashKey) {
      entries = [...t.values()].filter((rec) => rec.keyHash === filter.HashKey);
    } else {
      entries = [...t.values()].filter((rec) =>
        !filter || Object.entries(filter).every(([field, value]) => rec.fields[field] === value)
      );
    }
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
    slug: "claim-me",
    title: "Claim me",
    body: "Repo: EdgeVector/fkanban\nBase: main\n\n## GOAL\nfixture\n\n## END STATE\ndone\n",
    board: "default",
    column: "todo",
    position: "1",
    assignee: "",
    tags: [],
    deps: [],
    ...emptyStructuredFields(),
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

async function seed(node: NodeClient) {
  await node.createRecord({
    schemaHash: cfg.schemaHashes.board!,
    keyHash: "default",
    fields: boardToFields(board()),
  });
  await node.createRecord({
    schemaHash: cfg.schemaHashes.card!,
    keyHash: "claim-me",
    fields: cardToFields(card({})),
  });
}

async function seedBoardCard(node: NodeClient, c: Card) {
  await node.createRecord({
    schemaHash: cfgWithBoardCards.schemaHashes.board_cards!,
    keyHash: c.board,
    rangeKey: boardCardSk(c.column, c.position, c.slug),
    fields: boardCardFieldsFromCard(c),
  });
}

describe("move claim guard", () => {
  test("move --from is exactly-one-winner under a CAS-aware node", async () => {
    const node = fakeNode();
    await seed(node);

    const first = await moveCmd({ cfg, node, slug: "claim-me", column: "doing", expectColumn: "todo" });
    expect(first).toMatchObject({ slug: "claim-me", from: "todo", to: "doing" });

    await expect(
      moveCmd({ cfg, node, slug: "claim-me", column: "doing", expectColumn: "todo" }),
    ).rejects.toMatchObject({
      code: "claim_conflict",
      current: "doing",
      expected: "todo",
    });
    expect(await findCard(node, cfg, "claim-me")).toMatchObject({ column: "doing" });
  });

  test("plain move remains idempotent without a claim guard", async () => {
    const node = fakeNode();
    await seed(node);

    await moveCmd({ cfg, node, slug: "claim-me", column: "doing" });
    const second = await moveCmd({ cfg, node, slug: "claim-me", column: "doing" });

    expect(second).toMatchObject({ slug: "claim-me", from: "doing", to: "doing" });
  });

  test("move removes the old BoardCards row so column list previews follow show", async () => {
    const node = fakeNode();
    const initial = card({ column: "doing", position: "2" });
    await node.createRecord({
      schemaHash: cfgWithBoardCards.schemaHashes.board!,
      keyHash: "default",
      fields: boardToFields(board()),
    });
    await node.createRecord({
      schemaHash: cfgWithBoardCards.schemaHashes.card!,
      keyHash: initial.slug,
      fields: cardToFields(initial),
    });
    await seedBoardCard(node, initial);

    resetBoardCardJanitorForTests();
    await moveCmd({ cfg: cfgWithBoardCards, node, slug: initial.slug, column: "done" });
    await sweepBoardCardJanitor(node);

    expect(await findCard(node, cfgWithBoardCards, initial.slug)).toMatchObject({ column: "done" });
    const doing = cardsFromJson(await listCmd({ cfg: cfgWithBoardCards, node, column: "doing", json: true }));
    expect(doing.map((c: { slug: string }) => c.slug)).not.toContain(initial.slug);
  });

  // Contract change: `list` is BoardCards-projection-authoritative and does NOT
  // point-read Card per row to repair drift. Verifying per row made one keyed
  // partition query into 1+N serial point-reads (measured: `list --column todo`
  // rendering 10 cards cost 11 Card queries / 26.6s on the live node), and no
  // bound helps — even a 12-per-column cap is ~31s at the live per-read cost.
  // Stale rows are repaired by `groom board-cards-heal`, which owns this exact
  // scenario and proves it in board-cards.test.ts ("board-cards-heal deletes
  // stale doing when card is done"). Writes dual-write BoardCards, so this state
  // only arises from a partial write, not from ordinary use.
  test("list renders the BoardCards projection without per-row Card point-reads", async () => {
    const node = fakeNode();
    const stale = card({ column: "doing", position: "2", updated_at: "2026-01-01T00:00:00.000Z" });
    const truth = card({ column: "done", position: "9", updated_at: "2026-01-02T00:00:00.000Z" });
    await node.createRecord({
      schemaHash: cfgWithBoardCards.schemaHashes.board!,
      keyHash: "default",
      fields: boardToFields(board()),
    });
    await node.createRecord({
      schemaHash: cfgWithBoardCards.schemaHashes.card!,
      keyHash: truth.slug,
      fields: cardToFields(truth),
    });
    await seedBoardCard(node, stale);

    // The projection is what renders — the un-updated BoardCards row still shows
    // its own column until an explicit heal runs.
    const doing = cardsFromJson(await listCmd({ cfg: cfgWithBoardCards, node, column: "doing", json: true }));
    expect(doing.map((c: { slug: string }) => c.slug)).toEqual([stale.slug]);

    const all = cardsFromJson(await listCmd({ cfg: cfgWithBoardCards, node, json: true }));
    expect(all).toMatchObject([{ slug: stale.slug, column: "doing", position: "2" }]);
  });

  test("list keeps BoardCards thin row when Card point-read misses (no orphan delete)", async () => {
    // Regression 2026-07-23/24: list reconcile deleted BoardCards when Card was
    // unreadable (Mini degradation), emptying Factory scrapers.
    const node = fakeNode();
    const thinOnly = card({ slug: "ghost-membership", column: "todo", position: "3" });
    await node.createRecord({
      schemaHash: cfgWithBoardCards.schemaHashes.board!,
      keyHash: "default",
      fields: boardToFields(board()),
    });
    // BoardCards row only — no Card record.
    await seedBoardCard(node, thinOnly);

    // Board-wide list (HashKey partition) — not --column (HashRangePrefix).
    const listed = cardsFromJson(await listCmd({ cfg: cfgWithBoardCards, node, json: true })) as Array<{
      slug: string;
      column: string;
    }>;
    expect(listed.map((c) => c.slug)).toContain("ghost-membership");
    expect(listed.find((c) => c.slug === "ghost-membership")?.column).toBe("todo");

    // Second list must still see the row (not deleted on first reconcile).
    const again = cardsFromJson(await listCmd({ cfg: cfgWithBoardCards, node, json: true })) as Array<{
      slug: string;
    }>;
    expect(again.map((c) => c.slug)).toContain("ghost-membership");
  });

  test("column list does not rescue false-empty HashRangePrefix results with a partition scan", async () => {
    // Column list primary path is HashRangePrefix only. If the node accepts the
    // prefix query but returns no rows, fkanban must not silently paper over the
    // primary-path breakage with a HashKey partition scan.
    const node = fakeNode({ prefixBlind: true });
    const todo = card({ slug: "visible-todo", column: "todo", position: "3" });
    await node.createRecord({
      schemaHash: cfgWithBoardCards.schemaHashes.board!,
      keyHash: "default",
      fields: boardToFields(board()),
    });
    await seedBoardCard(node, todo);

    const listed = cardsFromJson(await listCmd({ cfg: cfgWithBoardCards, node, column: "todo", json: true })) as Array<{
      slug: string;
      column: string;
    }>;
    expect(listed).toEqual([]);
  });

  test("move refuses an ambient DB that disagrees with the card home DB", async () => {
    const node = fakeNode();
    await seed(node);

    await moveCmd({ cfg, node, slug: "claim-me", column: "doing", dbLocator: "lastdb://personal" });
    const after = await findCard(node, cfg, "claim-me");
    expect(after?.db).toBe("lastdb://personal");
    expect(after?.body.startsWith("Db: lastdb://personal\n")).toBe(true);

    await expect(
      moveCmd({
        cfg,
        node,
        slug: "claim-me",
        column: "review",
        dbLocator: "lastdb://org/edgevector/company",
      }),
    ).rejects.toMatchObject({ code: "db_locator_mismatch" });
  });

  test("claim conflict exposes the current column", () => {
    const err = new ClaimConflictError({ slug: "claim-me", expected: "todo", current: "review" });
    expect(err.code).toBe("claim_conflict");
    expect(err.current).toBe("review");
    expect(err.expected).toBe("todo");
  });

  test("move into doing stamps explicit worker so the card is not an empty zombie", async () => {
    const node = fakeNode();
    await seed(node);

    const res = await moveCmd({
      cfg,
      node,
      slug: "claim-me",
      column: "doing",
      expectColumn: "todo",
      worker: "last-stack-fkanban-pickup",
    });
    expect(res.claim).toBe("stamped");
    expect(res.assignee).toBe("last-stack-fkanban-pickup");
    expect(await findCard(node, cfg, "claim-me")).toMatchObject({
      column: "doing",
      assignee: "last-stack-fkanban-pickup",
    });
  });

  test("move into doing refuses silent unclaimed when no actor is available", async () => {
    const node = fakeNode();
    await seed(node);

    await expect(
      moveCmd({
        cfg,
        node,
        slug: "claim-me",
        column: "doing",
        allowUnclaimed: false,
        env: {}, // no USER / LASTGIT_ACTOR / AUTOMATION_ID
      }),
    ).rejects.toMatchObject({ code: "move_into_doing_requires_claim" });
  });

  test("allow-unclaimed keeps bare move into doing for intentional empty claims", async () => {
    const node = fakeNode();
    await seed(node);

    const res = await moveCmd({
      cfg,
      node,
      slug: "claim-me",
      column: "doing",
      allowUnclaimed: true,
      env: {},
    });
    expect(res).toMatchObject({ to: "doing", claim: "unclaimed" });
    expect(await findCard(node, cfg, "claim-me")).toMatchObject({ column: "doing", assignee: "" });
  });
});
