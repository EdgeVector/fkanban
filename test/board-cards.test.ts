import { describe, expect, test } from "bun:test";
import {
  boardCardFieldsFromCard,
  boardCardSk,
  cardFromBoardCardFields,
  parseBoardCardSk,
} from "../src/board-cards.ts";
import { BOARD_CARDS_LAYOUT, boardCardsSchema } from "../src/schemas.ts";
import { emptyStructuredFields, type Card } from "../src/record.ts";

function card(partial: Partial<Card> = {}): Card {
  return {
    slug: "my-card",
    title: "My card",
    body: "SHOULD NOT APPEAR ON BOARD CARDS",
    board: "default",
    column: "todo",
    position: "3",
    assignee: "tom",
    tags: ["a"],
    deps: ["other"],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    ...emptyStructuredFields(),
    surfaces: ["src/**"],
    done_at: "",
    kind: "pr",
    repo: "EdgeVector/fkanban",
    ...partial,
  };
}

describe("board-cards keys", () => {
  test("sk is column#pos8#slug", () => {
    expect(boardCardSk("todo", "3", "my-card")).toBe("todo#00000003#my-card");
    expect(boardCardSk("doing", 42, "x")).toBe("doing#00000042#x");
  });

  test("parseSk round-trips", () => {
    const sk = boardCardSk("backlog", "10", "slug-with-dash");
    const p = parseBoardCardSk(sk);
    expect(p).toEqual({ column: "backlog", position: "10", slug: "slug-with-dash" });
  });

  test("column prefix sorts before later columns", () => {
    const keys = [
      boardCardSk("todo", 1, "a"),
      boardCardSk("doing", 1, "b"),
      boardCardSk("backlog", 1, "c"),
      boardCardSk("todo", 2, "d"),
    ].sort();
    expect(keys[0]!.startsWith("backlog#")).toBe(true);
    expect(keys.filter((k) => k.startsWith("todo#"))).toHaveLength(2);
  });
});

describe("board-cards projection", () => {
  test("fields omit body and set layout", () => {
    const f = boardCardFieldsFromCard(card());
    expect(f.body).toBeUndefined();
    expect(f.layout).toBe(BOARD_CARDS_LAYOUT);
    expect(f.sk).toBe("todo#00000003#my-card");
    expect(f.board).toBe("default");
    expect(f.slug).toBe("my-card");
    expect(f.deps).toEqual(["other"]);
  });

  test("cardFromBoardCardFields restores thin card with empty body", () => {
    const f = boardCardFieldsFromCard(card());
    const c = cardFromBoardCardFields(f);
    expect(c.body).toBe("");
    expect(c.slug).toBe("my-card");
    expect(c.column).toBe("todo");
    expect(c.kind).toBe("pr");
    expect(c.repo).toBe("EdgeVector/fkanban");
  });
});

describe("boardCards schema", () => {
  test("is HashRange on board/sk", () => {
    expect(boardCardsSchema.schema.schema_type).toBe("HashRange");
    expect(boardCardsSchema.schema.key).toEqual({
      hash_field: "board",
      range_field: "sk",
    });
    expect(boardCardsSchema.schema.fields).toContain("layout");
    expect(boardCardsSchema.schema.fields).not.toContain("body");
  });
});
