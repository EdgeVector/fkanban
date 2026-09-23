// papercut-kanban-pickup-claim-lost-across-unclean-lastdbd-restart-20260922
//
// A claim is the pickup lease. Its Card write must ask the node for a durable
// receipt; an ordinary board write keeps the node's queued default. A node
// that predates the `durability` field (HTTP 400) gets one queued retry.

import { beforeEach, describe, expect, test } from "bun:test";

import { FkanbanError, withDurableWrites, type NodeClient } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { addCmd } from "../src/commands/add.ts";
import { claimCard, moveCmd } from "../src/commands/move.ts";
import { boardToFields, findCard, nowIso } from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";
import { fakeNode, type FakeNode } from "./fake-node.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash" },
};

const body = "Repo: EdgeVector/fkanban\nBase: main\nKind: pr\n\n## GOAL\nx\n\n## END STATE\ny\n";

type Seen = { schemaHash: string; durability?: string; column?: unknown };

function spy(node: FakeNode): Seen[] {
  const seen: Seen[] = [];
  const update = node.updateRecord.bind(node);
  node.updateRecord = async (o) => {
    seen.push({ schemaHash: o.schemaHash, durability: (o as { durability?: string }).durability, column: o.fields.column });
    return update(o);
  };
  return seen;
}

describe("claim writes are durable", () => {
  let node: FakeNode;
  beforeEach(async () => {
    node = fakeNode();
    const now = nowIso();
    await node.createRecord({
      schemaHash: "boardhash",
      keyHash: "default",
      fields: boardToFields({ slug: "default", title: "D", body: "", columns: [...DEFAULT_COLUMNS], created_at: now, updated_at: now }),
    });
    await addCmd({ cfg, node, slug: "c1", title: "c1", column: "todo", body, force: true });
  });

  test("claimCard asks for a durable Card write", async () => {
    const seen = spy(node);
    await claimCard({ cfg, node, slug: "c1", worker: "w1" });
    const cardWrites = seen.filter((s) => s.schemaHash === "cardhash");
    expect(cardWrites.length).toBeGreaterThan(0);
    expect(cardWrites.every((s) => s.durability === "durable")).toBe(true);
    expect((await findCard(node, cfg, "c1"))?.column).toBe("doing");
  });

  test("move --worker into doing is durable; a plain move is not", async () => {
    const seen = spy(node);
    await moveCmd({ cfg, node, slug: "c1", column: "doing", expectColumn: "todo", worker: "w1" });
    expect(seen.filter((s) => s.schemaHash === "cardhash").every((s) => s.durability === "durable")).toBe(true);
    seen.length = 0;
    await moveCmd({ cfg, node, slug: "c1", column: "backlog", force: true });
    expect(seen.filter((s) => s.schemaHash === "cardhash").some((s) => s.durability === "durable")).toBe(false);
  });

  test("an old node that rejects `durability` gets one queued retry", async () => {
    const calls: Array<string | undefined> = [];
    const base = {
      updateRecord: async (o: { durability?: string }) => {
        calls.push(o.durability);
        if (o.durability) throw new FkanbanError({ code: "http_400", message: "Node /api/mutation returned HTTP 400: unknown field `durability`" });
      },
    } as unknown as NodeClient;
    await withDurableWrites(base).updateRecord({ schemaHash: "h", fields: {}, keyHash: "k" });
    expect(calls).toEqual(["durable", undefined]);
  });

  test("other errors are not swallowed", async () => {
    const base = {
      updateRecord: async () => {
        throw new FkanbanError({ code: "cas_conflict", message: "Node /api/mutation returned HTTP 409: cas_conflict" });
      },
    } as unknown as NodeClient;
    await expect(withDurableWrites(base).updateRecord({ schemaHash: "h", fields: {}, keyHash: "k" }))
      .rejects.toMatchObject({ code: "cas_conflict" });
  });
});
