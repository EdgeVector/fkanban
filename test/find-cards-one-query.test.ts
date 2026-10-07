import { describe, expect, test } from "bun:test";

import type { Config } from "../src/config.ts";
import { cardToFields, findCards, nowIso, type Card } from "../src/record.ts";
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
    body: "body",
    board: "default",
    column: "todo",
    position: "m",
    assignee: "",
    tags: [],
    deps: [],
    surfaces: [],
    created_at: now,
    updated_at: now,
    done_at: "",
    first_doing_at: "",
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

describe("findCards", () => {
  test("an empty slug list reads nothing", async () => {
    const node = fakeNode();
    const before = node.reads.length;
    expect(await findCards(node, cfg, [])).toEqual([]);
    expect(node.reads.slice(before)).toHaveLength(0);
  });

  test("the named slugs are one HashRangeKeys query, in the caller's order", async () => {
    const node = fakeNode();
    node.seed({ schemaHash: "cardhash", keyHash: "a", fields: cardToFields(card("a")) });
    node.seed({ schemaHash: "cardhash", keyHash: "b", fields: cardToFields(card("b")) });
    const before = node.reads.length;
    const got = await findCards(node, cfg, ["b", "missing", "a"]);
    const cardReads = node.reads.slice(before).filter((read) => read.schemaHash === "cardhash");
    expect(cardReads).toHaveLength(1);
    const filter = cardReads[0]?.filter as { HashRangeKeys?: Array<[string, string]> } | undefined;
    expect(filter?.HashRangeKeys).toEqual([
      ["b", ""],
      ["missing", ""],
      ["a", ""],
    ]);
    expect(got.map((row) => row?.slug ?? null)).toEqual(["b", null, "a"]);
  });
});
