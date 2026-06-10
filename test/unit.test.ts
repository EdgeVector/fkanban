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
  appendPosition,
  ensureColumn,
  isTombstoned,
  sortCards,
  validateSlug,
  rowToCard,
  cardToFields,
  normalizeDeps,
  depStatus,
  blockedSlugSet,
  depTag,
  isWorkingColumn,
  TOMBSTONE_TAG,
  DEP_TAG_PREFIX,
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
    deps: [],
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
  test("appendPosition sorts after legacy hand-numbered positions", () => {
    const cards = [
      card({ slug: "new", position: appendPosition() }),
      card({ slug: "old-a", position: "10" }),
      card({ slug: "old-b", position: "20" }),
    ];
    expect(sortCards(cards).map((c) => c.slug)).toEqual(["old-a", "old-b", "new"]);
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

describe("dependencies", () => {
  test("dep tags split out of tags into deps on read", () => {
    const c = rowToCard({
      key: { hash: "x", range: null },
      fields: { slug: "x", tags: ["p1", depTag("a"), depTag("b"), TOMBSTONE_TAG] },
    });
    expect(c.deps).toEqual(["a", "b"]);
    expect(c.tags).toEqual(["p1", TOMBSTONE_TAG]); // tombstone stays, dep tags removed
  });

  test("cardToFields folds deps back into tags (round-trips)", () => {
    const c = card({ slug: "x", tags: ["p1"], deps: ["a", "b"] });
    const fields = cardToFields(c);
    expect(fields.tags).toEqual(["p1", depTag("a"), depTag("b")]);
    const back = rowToCard({ key: { hash: "x", range: null }, fields });
    expect(back.tags).toEqual(["p1"]);
    expect(back.deps).toEqual(["a", "b"]);
  });

  test("DEP_TAG_PREFIX is the reserved prefix", () => {
    expect(depTag("foo")).toBe(`${DEP_TAG_PREFIX}foo`);
  });

  test("normalizeDeps drops blanks, self, and dupes (order-stable)", () => {
    expect(normalizeDeps([" a ", "self", "a", "", "b"], "self")).toEqual(["a", "b"]);
  });

  test("a card is blocked until every dep reaches done", () => {
    const all = [
      card({ slug: "a", column: "doing" }),
      card({ slug: "b", column: "done" }),
      card({ slug: "x", column: "todo", deps: ["a", "b"] }),
    ];
    const x = all.find((c) => c.slug === "x")!;
    const s = depStatus(x, all);
    expect(s.blocked).toBe(true);
    expect(s.blockedBy).toEqual(["a"]); // b is done, so only a blocks
    expect(s.missing).toEqual([]);
  });

  test("unblocked once all deps are done", () => {
    const all = [
      card({ slug: "a", column: "done" }),
      card({ slug: "x", column: "todo", deps: ["a"] }),
    ];
    const s = depStatus(all[1]!, all);
    expect(s.blocked).toBe(false);
    expect(blockedSlugSet(all, all).has("x")).toBe(false);
  });

  test("a missing dep is surfaced but does not block", () => {
    const x = card({ slug: "x", deps: ["ghost"] });
    const s = depStatus(x, [x]);
    expect(s.missing).toEqual(["ghost"]);
    expect(s.blocked).toBe(false);
  });

  test("only doing/review/done are gating (working) columns", () => {
    expect(isWorkingColumn("backlog")).toBe(false);
    expect(isWorkingColumn("todo")).toBe(false);
    expect(isWorkingColumn("doing")).toBe(true);
    expect(isWorkingColumn("review")).toBe(true);
    expect(isWorkingColumn("done")).toBe(true);
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
