import { describe, expect, test } from "bun:test";

import type { Config } from "../src/config.ts";
import { cardToFields, listCardsWithBodies, nowIso, type Card } from "../src/record.ts";
import { fakeNode } from "./fake-node.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash" },
};

function card(slug: string): Card {
  const now = nowIso();
  return {
    slug,
    title: slug,
    body: `## GOAL\nShip ${slug}.\n`,
    board: "default",
    column: "todo",
    position: slug,
    assignee: "",
    tags: [],
    deps: [],
    surfaces: [],
    created_at: now,
    created_by: "test",
    updated_at: now,
    done_at: "",
    db: "",
    repo: "EdgeVector/fkanban",
    base: "main",
    kind: "pr",
    priority: "P2",
    block_status: "none",
    block_reason: "",
    north_star: "",
    milestone: "",
    pr_url: "",
    branch: "",
  } as Card;
}

describe("Card admin drains use key list plus point-get", () => {
  test("returns three live bodies, then two after delete, without an unfiltered query", async () => {
    const node = fakeNode();
    for (const slug of ["alpha", "beta", "gamma"]) {
      node.seed({
        schemaHash: cfg.schemaHashes.card!,
        keyHash: slug,
        fields: cardToFields(card(slug)),
      });
    }

    let listCalls = 0;
    const listRecordKeys = node.listRecordKeys!.bind(node);
    node.listRecordKeys = async (schemaHash, opts) => {
      listCalls += 1;
      return listRecordKeys(schemaHash, opts);
    };

    expect((await listCardsWithBodies(node, cfg)).map((value) => value.slug).sort())
      .toEqual(["alpha", "beta", "gamma"]);

    await node.deleteRecord({ schemaHash: cfg.schemaHashes.card!, keyHash: "beta" });
    expect((await listCardsWithBodies(node, cfg)).map((value) => value.slug).sort())
      .toEqual(["alpha", "gamma"]);

    expect(listCalls).toBe(2);
    const cardReads = node.reads.filter((read) => read.schemaHash === cfg.schemaHashes.card);
    expect(cardReads).toHaveLength(5);
    expect(cardReads.every((read) => typeof read.filter?.HashKey === "string")).toBe(true);
  });
});
