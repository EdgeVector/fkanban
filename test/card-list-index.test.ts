import { describe, expect, test } from "bun:test";
import { toCardSummary, CARD_LIST_INDEX_KEY } from "../src/card-list-index.ts";
import { CARD_LIST_INDEX_KEY as KEY_FROM_SCHEMAS } from "../src/schemas.ts";

describe("card-list-index", () => {
  test("toCardSummary strips body for index storage", () => {
    const summary = toCardSummary({
      slug: "x",
      title: "T",
      body: "huge body should not be indexed",
      board: "default",
      column: "todo",
      position: "0",
      assignee: "",
      tags: [],
      deps: [],
      surfaces: [],
      created_at: "",
      updated_at: "",
      db: "",
      repo: "",
      base: "",
      kind: "pr",
      block_status: "none",
      block_reason: "",
      north_star: "",
      pr_url: "",
      branch: "",
    });
    expect(summary.body).toBe("");
    expect(summary.slug).toBe("x");
    expect(summary.column).toBe("todo");
  });

  test("index key is stable all_cards", () => {
    expect(CARD_LIST_INDEX_KEY).toBe("all_cards");
    expect(KEY_FROM_SCHEMAS).toBe("all_cards");
  });
});
