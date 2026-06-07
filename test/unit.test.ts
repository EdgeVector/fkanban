// Pure-logic unit tests — no node / schema-service required.

import { describe, expect, test } from "bun:test";

import {
  DEFAULT_COLUMNS,
  cardSchema,
  boardSchema,
  isRecordType,
  isDefaultColumn,
  namespacedSchemaName,
} from "../src/schemas.ts";
import {
  ensureColumn,
  isTombstoned,
  sortCards,
  validateSlug,
  rowToCard,
  TOMBSTONE_TAG,
  type Card,
} from "../src/record.ts";
import { FkanbanError } from "../src/client.ts";
import { renderBoard } from "../src/board.ts";

function card(partial: Partial<Card>): Card {
  return {
    slug: "c",
    title: "C",
    body: "",
    board: "default",
    column: "todo",
    position: "10",
    assignee: "",
    tags: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("schemas", () => {
  test("two record types are recognised", () => {
    expect(isRecordType("card")).toBe(true);
    expect(isRecordType("board")).toBe(true);
    expect(isRecordType("design")).toBe(false);
  });

  test("schemas declare the fkanban app owner", () => {
    expect(cardSchema.schema.owner_app_id).toBe("fkanban");
    expect(boardSchema.schema.owner_app_id).toBe("fkanban");
    expect(namespacedSchemaName("Card")).toBe("fkanban/Card");
  });

  test("card key is its slug", () => {
    expect(cardSchema.schema.key.hash_field).toBe("slug");
  });

  test("default columns are the kanban lifecycle", () => {
    expect([...DEFAULT_COLUMNS]).toEqual(["backlog", "todo", "doing", "review", "done"]);
    expect(isDefaultColumn("doing")).toBe(true);
    expect(isDefaultColumn("nope")).toBe(false);
  });
});

describe("slug validation", () => {
  test("accepts a clean slug", () => {
    expect(() => validateSlug("ship-login_2")).not.toThrow();
  });
  test("rejects uppercase / spaces / empty", () => {
    for (const bad of ["", "Ship", "a b", "-lead"]) {
      expect(() => validateSlug(bad)).toThrow(FkanbanError);
    }
  });
});

describe("column validation", () => {
  test("falls back to default columns when board lists none", () => {
    expect(() => ensureColumn("doing", [])).not.toThrow();
    expect(() => ensureColumn("nonsense", [])).toThrow(FkanbanError);
  });
  test("honours a board's custom columns", () => {
    expect(() => ensureColumn("qa", ["dev", "qa", "ship"])).not.toThrow();
    expect(() => ensureColumn("doing", ["dev", "qa", "ship"])).toThrow(FkanbanError);
  });
});

describe("ordering + tombstones", () => {
  test("sorts by numeric position then created_at", () => {
    const cards = [
      card({ slug: "c", position: "20" }),
      card({ slug: "a", position: "10" }),
      card({ slug: "b", position: "10", created_at: "2026-01-02T00:00:00.000Z" }),
    ];
    expect(sortCards(cards).map((c) => c.slug)).toEqual(["a", "b", "c"]);
  });
  test("tombstone tag is detected", () => {
    expect(isTombstoned([TOMBSTONE_TAG])).toBe(true);
    expect(isTombstoned(["auth"])).toBe(false);
  });
});

describe("row → card", () => {
  test("coerces fields and parses comma-string tags", () => {
    const c = rowToCard({
      key: { hash: "ship", range: null },
      fields: { slug: "ship", title: "Ship", column: "doing", tags: "auth, p1" },
    });
    expect(c.slug).toBe("ship");
    expect(c.column).toBe("doing");
    expect(c.tags).toEqual(["auth", "p1"]);
  });
});

describe("render", () => {
  test("renders columns with counts and a card line", () => {
    const board = {
      slug: "default",
      title: "Default board",
      body: "",
      columns: [...DEFAULT_COLUMNS],
      created_at: "",
      updated_at: "",
    };
    const out = renderBoard(board, [card({ slug: "ship", title: "Ship it", column: "doing", tags: ["auth"] })], {
      color: false,
    });
    expect(out).toContain("DOING  (1)");
    expect(out).toContain("Ship it");
    expect(out).toContain("#auth");
    expect(out).toContain("BACKLOG  (0)");
  });
});
