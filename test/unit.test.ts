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
  cardMatchesQuery,
  searchCards,
  depTag,
  isWorkingColumn,
  TOMBSTONE_TAG,
  DEP_TAG_PREFIX,
  type Card,
} from "../src/record.ts";
import { FkanbanError } from "../src/client.ts";
import { renderBoard, renderSearchResults } from "../src/board.ts";
import { doctor } from "../src/commands/doctor.ts";

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

describe("search", () => {
  const corpus = [
    card({ slug: "ship-login", title: "Ship the login flow", tags: ["auth", "p1"] }),
    card({ slug: "fix-typo", title: "Fix a typo", body: "in the README", tags: ["docs"] }),
    card({ slug: "oauth", title: "OAuth support", assignee: "tom", body: "needs auth review" }),
  ];

  test("matches across slug, title, body, assignee, and tags (case-insensitive)", () => {
    expect(cardMatchesQuery(corpus[0]!, "LOGIN")).toBe(true); // title
    expect(cardMatchesQuery(corpus[0]!, "p1")).toBe(true); // tag
    expect(cardMatchesQuery(corpus[1]!, "readme")).toBe(true); // body
    expect(cardMatchesQuery(corpus[2]!, "tom")).toBe(true); // assignee
    expect(cardMatchesQuery(corpus[2]!, "oauth")).toBe(true); // slug
  });

  test("multi-word queries are AND-matched (every term must appear)", () => {
    expect(cardMatchesQuery(corpus[2]!, "oauth auth")).toBe(true); // slug + body
    expect(cardMatchesQuery(corpus[2]!, "oauth missing")).toBe(false);
  });

  test("an empty query matches everything", () => {
    expect(cardMatchesQuery(corpus[0]!, "   ")).toBe(true);
  });

  test("searchCards returns the AND-matching subset", () => {
    expect(searchCards(corpus, "auth").map((c) => c.slug)).toEqual(["ship-login", "oauth"]);
    expect(searchCards(corpus, "nope")).toEqual([]);
  });

  test("renderSearchResults shows a count, location, and a no-match message", () => {
    const hits = searchCards(corpus, "auth");
    const out = renderSearchResults(hits, "auth", { color: false });
    expect(out).toContain('2 matches for "auth"');
    expect(out).toContain("[default/todo]");
    expect(out).toContain("ship-login");
    expect(renderSearchResults([], "ghost", { color: false })).toBe('No cards match "ghost".');
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

  test("limit caps a column and shows the overflow count", () => {
    const board = {
      slug: "default",
      title: "Default board",
      body: "",
      columns: [...DEFAULT_COLUMNS],
      created_at: "",
      updated_at: "",
    };
    const todo = Array.from({ length: 5 }, (_, i) =>
      card({ slug: `t${i}`, title: `Todo ${i}`, column: "todo", position: String((i + 1) * 10) }),
    );
    const out = renderBoard(board, todo, { color: false, limit: 2 });
    // Header still reports the true total.
    expect(out).toContain("TODO  (5)");
    // First 2 (top-of-column) shown; the rest collapse.
    expect(out).toContain("Todo 0");
    expect(out).toContain("Todo 1");
    expect(out).not.toContain("Todo 2");
    expect(out).toContain("… 3 more (--all)");
  });

  test("terminal column shows the most recent N (tail), not the first", () => {
    const board = {
      slug: "default",
      title: "Default board",
      body: "",
      columns: [...DEFAULT_COLUMNS],
      created_at: "",
      updated_at: "",
    };
    const done = Array.from({ length: 5 }, (_, i) =>
      card({ slug: `d${i}`, title: `Done ${i}`, column: "done", position: String((i + 1) * 10) }),
    );
    const out = renderBoard(board, done, { color: false, limit: 2 });
    expect(out).toContain("DONE  (5)");
    // Tail (highest position = most recent) is kept; oldest are hidden.
    expect(out).toContain("Done 3");
    expect(out).toContain("Done 4");
    expect(out).not.toContain("Done 0");
    expect(out).toContain("… 3 earlier (--all)");
  });

  test("no limit (0) renders every card", () => {
    const board = {
      slug: "default",
      title: "Default board",
      body: "",
      columns: [...DEFAULT_COLUMNS],
      created_at: "",
      updated_at: "",
    };
    const done = Array.from({ length: 4 }, (_, i) =>
      card({ slug: `d${i}`, title: `Done ${i}`, column: "done", position: String((i + 1) * 10) }),
    );
    const out = renderBoard(board, done, { color: false, limit: 0 });
    for (let i = 0; i < 4; i++) expect(out).toContain(`Done ${i}`);
    expect(out).not.toContain("(--all)");
  });
});

describe("doctor", () => {
  // Backs the fkanban_doctor MCP tool: it accumulates check lines through the
  // injected `print` callback and returns ok=false when a check fails. A
  // missing config short-circuits before any node call, so this stays pure.
  test("missing config → ok=false, prints the failed check + init hint", async () => {
    const lines: string[] = [];
    const ok = await doctor({ configPath: "/tmp/fkanban-doctor-nonexistent-config.json", print: (l) => lines.push(l) });
    expect(ok).toBe(false);
    const report = lines.join("\n");
    expect(report).toContain("✗ config present");
    expect(report).toContain("fkanban init");
  });
});
